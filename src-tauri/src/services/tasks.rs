use std::{collections::HashSet, fs};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    models::{
        TaskComment, TaskCommentInput, TaskCommentReceipt, TaskDependency, TaskDetail,
        TaskLaneAssignment, TaskLaneRun, TaskSummary, TaskUpsertInput,
    },
    services::{
        orchestra_paths::{default_orchestra_root, task_attachments_dir},
        task_attachments, task_file_references, task_repositories, task_runtime,
    },
};

const DEFAULT_PROJECT_ID: &str = "orchestra";
const VALID_TASK_TYPES: &[&str] = &["task", "bug", "feature", "chore", "epic"];
const VALID_TASK_STATUSES: &[&str] = &[
    "draft",
    "ready",
    "in_progress",
    "blocked",
    "in_review",
    "completed",
    "canceled",
];
const VALID_TASK_PRIORITIES: &[&str] = &["P0", "P1", "P2", "P3", "P4"];
const VALID_ASSIGNEE_TYPES: &[&str] = &["user", "agent", "role", "unassigned"];
const TERMINAL_TASK_STATUSES: &[&str] = &["completed", "canceled"];

pub fn list_tasks(
    connection: &Connection,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<TaskSummary>, String> {
    let mut statement = connection
        .prepare(&format!(
            r#"
            SELECT
                {summary_columns}
            FROM tasks t
            WHERE t.project_id = ?1 AND (?2 = 1 OR t.archived = 0)
            ORDER BY t.archived ASC, t.updated_at DESC, t.sequence_number DESC
            "#,
            summary_columns = task_summary_columns("t"),
        ))
        .map_err(|error| format!("Unable to prepare task list query: {error}"))?;

    let rows = statement
        .query_map(
            params![project_id, if include_archived { 1 } else { 0 }],
            map_task_summary_row,
        )
        .map_err(|error| format!("Unable to query tasks for project {project_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read task rows: {error}"))
}

pub fn get_task(connection: &Connection, task_id: &str) -> Result<TaskDetail, String> {
    let mut task = connection
        .query_row(
            &format!(
                r#"
                SELECT
                    {summary_columns},
                    t.repository_id
                FROM tasks t
                WHERE t.id = ?1
                "#,
                summary_columns = task_summary_columns("t"),
            ),
            [task_id],
            |row| {
                Ok(TaskDetail {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    number: row.get(2)?,
                    title: row.get(3)?,
                    description: row.get(4)?,
                    task_type: row.get(5)?,
                    status: row.get(6)?,
                    priority: row.get(7)?,
                    workflow_id: row.get(8)?,
                    current_lane_id: row.get(9)?,
                    assignee_type: row.get(10)?,
                    assignee_id: row.get(11)?,
                    parent_task_id: row.get(12)?,
                    whip_max_attempts: row.get(13)?,
                    archived: row.get::<_, i64>(14)? != 0,
                    comment_count: row.get(15)?,
                    lane_run_count: row.get(16)?,
                    child_count: row.get(17)?,
                    completed_child_count: row.get(18)?,
                    in_progress_child_count: row.get(19)?,
                    blocked_child_count: row.get(20)?,
                    blocked_by_count: row.get(21)?,
                    blocking_count: row.get(22)?,
                    attachment_count: row.get(23)?,
                    dependency_blocked: row.get::<_, i64>(24)? != 0,
                    ready_for_dispatch: row.get::<_, i64>(25)? != 0,
                    repository_id: row.get(28)?,
                    repository_ids: Vec::new(),
                    parent: None,
                    lineage: Vec::new(),
                    children: Vec::new(),
                    blocked_by: Vec::new(),
                    blocking: Vec::new(),
                    attachments: Vec::new(),
                    task_repositories: Vec::new(),
                    file_references: Vec::new(),
                    comments: Vec::new(),
                    lane_runs: Vec::new(),
                    active_lane_assignment: None,
                    created_at: row.get(26)?,
                    updated_at: row.get(27)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query task {task_id}: {error}"))?
        .ok_or_else(|| format!("Task {task_id} was not found"))?;

    task.parent = load_parent_summary(connection, task.parent_task_id.as_deref())?;
    task.lineage = load_lineage(connection, task.parent_task_id.clone())?;
    task.children = load_child_tasks(connection, task_id)?;
    task.blocked_by = load_blocked_by_dependencies(connection, task_id)?;
    task.blocking = load_blocking_dependencies(connection, task_id)?;
    task.attachments = task_attachments::load_task_attachments(connection, task_id)?;
    task.active_lane_assignment = task_runtime::get_active_lane_assignment(connection, task_id)?;
    task.task_repositories = task_repositories::load_task_repositories(
        connection,
        task_id,
        task.active_lane_assignment
            .as_ref()
            .and_then(|assignment| assignment.runtime_cwd.as_deref()),
    )?;
    task.repository_ids = task
        .task_repositories
        .iter()
        .map(|repository| repository.repository_id.clone())
        .collect();
    task.file_references = task_file_references::load_task_file_references(connection, task_id)?;
    task.comments = load_task_comments(connection, task_id)?;
    task.lane_runs = load_task_lane_runs(connection, task_id)?;
    Ok(task)
}

pub fn get_task_context(connection: &Connection, task_id: &str) -> Result<TaskDetail, String> {
    get_task(connection, task_id)
}

pub fn list_task_comments(connection: &Connection, task_id: &str) -> Result<Vec<TaskComment>, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }
    load_task_comments(connection, task_id)
}

pub fn create_task(
    connection: &mut Connection,
    project_id: Option<&str>,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let project_id = project_id.unwrap_or(DEFAULT_PROJECT_ID).to_string();
    let normalized = apply_default_task_repositories(
        connection,
        &project_id,
        apply_default_lane_if_needed(connection, normalize_input(input))?,
    )?;
    validate_task_input(connection, &normalized, None)?;
    let sequence_number = next_task_sequence_number(connection, &project_id)?;
    let number = format!("ORC-{sequence_number}");
    let task_id = task_id();
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task creation transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO tasks (
            id,
            project_id,
            sequence_number,
            number,
            title,
            description,
            task_type,
            status,
            priority,
            workflow_id,
            current_lane_id,
            assignee_type,
            assignee_id,
            repository_id,
            parent_task_id,
            whip_max_attempts,
            archived,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?18)
        "#,
        params![
            task_id,
            project_id,
            sequence_number,
            number,
            normalized.title,
            normalized.description,
            normalized.task_type,
            normalized.status,
            normalized.priority,
            normalized.workflow_id,
            normalized.current_lane_id,
            normalized.assignee_type,
            normalized.assignee_id,
            normalized.repository_ids.first().cloned(),
            normalized.parent_task_id,
            normalized.whip_max_attempts.unwrap_or(10),
            if normalized.archived.unwrap_or(false) { 1 } else { 0 },
            now,
        ],
    )
    .map_err(|error| format!("Unable to create task: {error}"))?;

    sync_task_repository_links(&tx, &task_id, &project_id, &normalized.repository_ids, &now)?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task creation: {error}"))?;

    get_task(connection, &task_id)
}

pub fn create_subtask(
    connection: &mut Connection,
    parent_task_id: &str,
    mut input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    input.parent_task_id = Some(parent_task_id.to_string());
    let project_id = connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [parent_task_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Unable to resolve parent task project: {error}"))?;
    create_task(connection, Some(&project_id), input)
}

pub fn update_task(
    connection: &mut Connection,
    task_id: &str,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let normalized = apply_default_lane_if_needed(connection, normalize_input(input))?;
    let existing = get_task(connection, task_id)?;
    validate_task_input(connection, &normalized, Some(task_id))?;
    let now = now_iso();

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task update transaction: {error}"))?;

    tx.execute(
        r#"
        UPDATE tasks
        SET title = ?2,
            description = ?3,
            task_type = ?4,
            status = ?5,
            priority = ?6,
            workflow_id = ?7,
            current_lane_id = ?8,
            assignee_type = ?9,
            assignee_id = ?10,
            repository_id = ?11,
            parent_task_id = ?12,
            whip_max_attempts = ?13,
            archived = ?14,
            updated_at = ?15
        WHERE id = ?1
        "#,
        params![
            task_id,
            normalized.title,
            normalized.description,
            normalized.task_type,
            normalized.status,
            normalized.priority,
            normalized.workflow_id,
            normalized.current_lane_id,
            normalized.assignee_type,
            normalized.assignee_id,
            normalized.repository_ids.first().cloned(),
            normalized.parent_task_id,
            normalized
                .whip_max_attempts
                .unwrap_or(existing.whip_max_attempts),
            if normalized.archived.unwrap_or(existing.archived) {
                1
            } else {
                0
            },
            now,
        ],
    )
    .map_err(|error| format!("Unable to update task {task_id}: {error}"))?;

    sync_task_repository_links(
        &tx,
        task_id,
        &existing.project_id,
        &normalized.repository_ids,
        &now,
    )?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task update: {error}"))?;

    get_task(connection, task_id)
}

pub fn delete_task(connection: &mut Connection, task_id: &str) -> Result<TaskDetail, String> {
    let task = get_task(connection, task_id)?;
    let attachments = task_attachments::load_task_attachments(connection, task_id)?;
    let orchestra_root = default_orchestra_root()?;
    let attachment_dir = task_attachments_dir(&orchestra_root, &task.project_id, task_id);

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task deletion transaction: {error}"))?;

    let deleted = tx
        .execute("DELETE FROM tasks WHERE id = ?1", [task_id])
        .map_err(|error| format!("Unable to delete task {task_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task {task_id} was not found"));
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit task deletion: {error}"))?;

    for attachment in attachments {
        let path = std::path::PathBuf::from(&attachment.stored_path);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "Unable to remove task attachment file {}: {error}",
                    path.display()
                )
            })?;
        }
    }

    if attachment_dir.exists() {
        fs::remove_dir_all(&attachment_dir).map_err(|error| {
            format!(
                "Unable to remove task attachment directory {}: {error}",
                attachment_dir.display()
            )
        })?;
    }

    Ok(task)
}

pub fn add_task_dependency(
    connection: &mut Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<TaskDependency, String> {
    validate_dependency_edge(connection, blocker_task_id, blocked_task_id)?;

    let project_id = task_project_id(connection, blocker_task_id)?;
    let dependency_id = dependency_id();
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start dependency transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO task_dependencies (id, project_id, blocker_task_id, blocked_task_id, created_at)
        VALUES (?1, ?2, ?3, ?4, ?5)
        "#,
        params![
            dependency_id,
            project_id,
            blocker_task_id,
            blocked_task_id,
            now
        ],
    )
    .map_err(|error| format!("Unable to add task dependency: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task dependency: {error}"))?;

    load_dependency(connection, &dependency_id)
}

pub fn remove_task_dependency(
    connection: &Connection,
    dependency_id: &str,
) -> Result<TaskDependency, String> {
    let dependency = load_dependency(connection, dependency_id)?;
    let deleted = connection
        .execute(
            "DELETE FROM task_dependencies WHERE id = ?1",
            [dependency_id],
        )
        .map_err(|error| format!("Unable to remove task dependency {dependency_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task dependency {dependency_id} was not found"));
    }

    Ok(dependency)
}

pub fn add_task_comment(
    connection: &mut Connection,
    task_id: &str,
    input: TaskCommentInput,
) -> Result<TaskComment, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }

    let author = input.author.trim();
    let message = input.message.trim();
    let parent_comment_id = normalized_optional_string(input.parent_comment_id);
    if author.is_empty() {
        return Err("author: Comment author is required.".to_string());
    }
    if message.is_empty() {
        return Err("message: Comment message is required.".to_string());
    }
    validate_task_comment_parent(connection, task_id, parent_comment_id.as_deref())?;

    let comment = TaskComment {
        id: format!("task-comment-{}", Uuid::new_v4().simple()),
        task_id: task_id.to_string(),
        parent_comment_id: parent_comment_id.clone(),
        author: author.to_string(),
        message: message.to_string(),
        interrupt_agent: input.interrupt_agent,
        created_at: now_iso(),
        updated_at: now_iso(),
    };

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task comment transaction: {error}"))?;
    tx.execute(
        "INSERT INTO task_comments (id, task_id, parent_comment_id, author, message, interrupt_agent, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
        params![
            comment.id,
            comment.task_id,
            comment.parent_comment_id,
            comment.author,
            comment.message,
            if comment.interrupt_agent { 1 } else { 0 },
            comment.created_at,
            comment.updated_at,
        ],
    )
    .map_err(|error| format!("Unable to add task comment: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Unable to commit task comment: {error}"))?;

    Ok(comment)
}

pub fn list_unread_task_comments(
    connection: &Connection,
    task_id: &str,
    assignment: &TaskLaneAssignment,
) -> Result<Vec<TaskComment>, String> {
    if assignment.task_id != task_id {
        return Err(format!(
            "Assignment {} does not belong to task {}",
            assignment.id, task_id
        ));
    }
    let session_id = assignment
        .session_id
        .as_deref()
        .ok_or_else(|| format!("Task assignment {} has no session id", assignment.id))?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT c.id, c.task_id, c.parent_comment_id, c.author, c.message, c.interrupt_agent, c.created_at, c.updated_at
            FROM task_comments c
            WHERE c.task_id = ?1
              AND NOT EXISTS (
                  SELECT 1
                  FROM task_comment_receipts r
                  WHERE r.comment_id = c.id AND r.session_id = ?2
              )
            ORDER BY c.created_at ASC, c.id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare unread task comments query: {error}"))?;

    let rows = statement
        .query_map(params![task_id, session_id], |row| {
            Ok(TaskComment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                parent_comment_id: row.get(2)?,
                author: row.get(3)?,
                message: row.get(4)?,
                interrupt_agent: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Unable to load unread task comments for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect unread task comments for {task_id}: {error}"))
}

pub fn mark_task_comments_read(
    connection: &Connection,
    task_id: &str,
    assignment: &TaskLaneAssignment,
    comment_ids: Option<&[String]>,
) -> Result<Vec<TaskCommentReceipt>, String> {
    if assignment.task_id != task_id {
        return Err(format!(
            "Assignment {} does not belong to task {}",
            assignment.id, task_id
        ));
    }
    let session_id = assignment
        .session_id
        .as_deref()
        .ok_or_else(|| format!("Task assignment {} has no session id", assignment.id))?;

    let comments = load_comments_for_receipt_update(connection, task_id, comment_ids)?;
    if comments.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_iso();
    for comment in &comments {
        connection
            .execute(
                r#"
                INSERT INTO task_comment_receipts (
                    comment_id,
                    task_id,
                    assignment_id,
                    worker_type,
                    worker_id,
                    role_instance_id,
                    session_id,
                    read_at,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
                ON CONFLICT(comment_id, session_id) DO UPDATE SET
                    assignment_id = excluded.assignment_id,
                    worker_type = excluded.worker_type,
                    worker_id = excluded.worker_id,
                    role_instance_id = excluded.role_instance_id,
                    read_at = excluded.read_at,
                    updated_at = excluded.updated_at
                "#,
                params![
                    comment.id.as_str(),
                    task_id,
                    assignment.id.as_str(),
                    assignment.worker_type.as_str(),
                    assignment.worker_id.clone(),
                    assignment.role_instance_id.clone(),
                    session_id,
                    now,
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to record task comment receipt for comment {} on task {}: {error}",
                    comment.id, task_id
                )
            })?;
    }

    load_task_comment_receipts(connection, task_id, session_id, Some(&comments))
}

fn validate_task_comment_parent(
    connection: &Connection,
    task_id: &str,
    parent_comment_id: Option<&str>,
) -> Result<(), String> {
    let Some(parent_comment_id) = parent_comment_id else {
        return Ok(());
    };

    let parent = connection
        .query_row(
            "SELECT task_id, parent_comment_id FROM task_comments WHERE id = ?1",
            [parent_comment_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to load parent comment {parent_comment_id}: {error}"))?
        .ok_or_else(|| format!("parentCommentId: Comment {parent_comment_id} was not found."))?;

    if parent.0 != task_id {
        return Err("parentCommentId: Reply target must belong to the same task.".into());
    }
    if parent.1.is_some() {
        return Err("parentCommentId: Replies can only target top-level comments.".into());
    }

    Ok(())
}

fn validate_task_input(
    connection: &Connection,
    input: &TaskUpsertInput,
    task_id: Option<&str>,
) -> Result<(), String> {
    let mut errors = Vec::new();

    if input.title.is_empty() {
        errors.push("title: Task title is required.".to_string());
    }

    if !VALID_TASK_TYPES.contains(&input.task_type.as_str()) {
        errors.push("type: Task type must be one of: task, bug, feature, chore, epic.".to_string());
    }

    if !VALID_TASK_STATUSES.contains(&input.status.as_str()) {
        errors.push(
            "status: Task status must be one of: draft, ready, in_progress, blocked, in_review, completed, canceled.".to_string(),
        );
    }

    if !VALID_TASK_PRIORITIES.contains(&input.priority.as_str()) {
        errors.push("priority: Task priority must be one of: P0, P1, P2, P3, P4.".to_string());
    }

    if let Some(whip_max_attempts) = input.whip_max_attempts {
        if whip_max_attempts < 1 {
            errors.push("whipMaxAttempts: Task whip max attempts must be at least 1.".to_string());
        }
    }

    if !VALID_ASSIGNEE_TYPES.contains(&input.assignee_type.as_str()) {
        errors.push(
            "assigneeType: Assignee type must be one of: user, agent, role, unassigned."
                .to_string(),
        );
    }

    if matches!(input.assignee_type.as_str(), "user" | "unassigned") && input.assignee_id.is_some()
    {
        errors
            .push("assigneeId: User/unassigned tasks must not specify an assignee id.".to_string());
    }

    if matches!(input.assignee_type.as_str(), "agent" | "role") && input.assignee_id.is_none() {
        errors.push("assigneeId: Agent/role tasks require an assignee id.".to_string());
    }

    if input.current_lane_id.is_some() && input.workflow_id.is_none() {
        errors.push("currentLaneId: A current lane requires a workflow selection.".to_string());
    }

    if let Some(parent_task_id) = input.parent_task_id.as_deref() {
        if Some(parent_task_id) == task_id {
            errors.push("parentTaskId: A task cannot be its own parent.".to_string());
        } else if !task_exists(connection, parent_task_id)? {
            errors.push("parentTaskId: Parent task was not found.".to_string());
        } else if let Some(task_id) = task_id {
            if would_create_parent_cycle(connection, task_id, parent_task_id)? {
                errors.push("parentTaskId: Parent would create a hierarchy cycle.".to_string());
            }
        }
    }

    if let Some(workflow_id) = input.workflow_id.as_deref() {
        if !workflow_exists(connection, workflow_id)? {
            errors.push("workflowId: Workflow was not found.".to_string());
        } else if let Some(current_lane_id) = input.current_lane_id.as_deref() {
            if !lane_exists_for_workflow(connection, workflow_id, current_lane_id)? {
                errors.push(
                    "currentLaneId: Lane does not belong to the selected workflow.".to_string(),
                );
            }
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" "))
    }
}

fn validate_dependency_edge(
    connection: &Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<(), String> {
    if blocker_task_id == blocked_task_id {
        return Err("A task cannot depend on itself.".to_string());
    }

    if !task_exists(connection, blocker_task_id)? {
        return Err(format!("Blocker task {blocker_task_id} was not found"));
    }

    if !task_exists(connection, blocked_task_id)? {
        return Err(format!("Blocked task {blocked_task_id} was not found"));
    }

    let blocker_project = task_project_id(connection, blocker_task_id)?;
    let blocked_project = task_project_id(connection, blocked_task_id)?;
    if blocker_project != blocked_project {
        return Err("Task dependencies must stay within a single project.".to_string());
    }

    if dependency_exists(connection, blocker_task_id, blocked_task_id)? {
        return Err("That dependency already exists.".to_string());
    }

    if would_create_dependency_cycle(connection, blocker_task_id, blocked_task_id)? {
        return Err("That dependency would create a cycle.".to_string());
    }

    Ok(())
}

fn load_comments_for_receipt_update(
    connection: &Connection,
    task_id: &str,
    comment_ids: Option<&[String]>,
) -> Result<Vec<TaskComment>, String> {
    let comments = load_task_comments(connection, task_id)?;
    let Some(comment_ids) = comment_ids else {
        return Ok(comments);
    };

    let selected_ids = comment_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    if selected_ids.is_empty() {
        return Ok(comments);
    }

    let filtered = comments
        .into_iter()
        .filter(|comment| selected_ids.contains(&comment.id))
        .collect::<Vec<_>>();

    if filtered.len() != selected_ids.len() {
        return Err("One or more comment ids were not found on this task.".into());
    }

    Ok(filtered)
}

fn load_task_comment_receipts(
    connection: &Connection,
    task_id: &str,
    session_id: &str,
    comments: Option<&[TaskComment]>,
) -> Result<Vec<TaskCommentReceipt>, String> {
    let selected_ids = comments.map(|entries| {
        entries
            .iter()
            .map(|comment| comment.id.as_str())
            .collect::<HashSet<_>>()
    });
    let mut statement = connection
        .prepare(
            r#"
            SELECT comment_id, task_id, assignment_id, worker_type, worker_id, role_instance_id, session_id, read_at, created_at, updated_at
            FROM task_comment_receipts
            WHERE task_id = ?1 AND session_id = ?2
            ORDER BY read_at ASC, comment_id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task comment receipts query: {error}"))?;

    let rows = statement
        .query_map(params![task_id, session_id], |row| {
            Ok(TaskCommentReceipt {
                comment_id: row.get(0)?,
                task_id: row.get(1)?,
                assignment_id: row.get(2)?,
                worker_type: row.get(3)?,
                worker_id: row.get(4)?,
                role_instance_id: row.get(5)?,
                session_id: row.get(6)?,
                read_at: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| format!("Unable to read task comment receipts for {task_id}: {error}"))?;

    let receipts = rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        format!("Unable to collect task comment receipts for {task_id}: {error}")
    })?;

    if let Some(selected_ids) = selected_ids {
        Ok(receipts
            .into_iter()
            .filter(|receipt| selected_ids.contains(receipt.comment_id.as_str()))
            .collect())
    } else {
        Ok(receipts)
    }
}

fn load_task_comments(connection: &Connection, task_id: &str) -> Result<Vec<TaskComment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, parent_comment_id, author, message, interrupt_agent, created_at, updated_at
            FROM task_comments
            WHERE task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task comments query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok(TaskComment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                parent_comment_id: row.get(2)?,
                author: row.get(3)?,
                message: row.get(4)?,
                interrupt_agent: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Unable to read task comments for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task comments for {task_id}: {error}"))
}

fn load_task_lane_runs(connection: &Connection, task_id: &str) -> Result<Vec<TaskLaneRun>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, lane_id, session_id, result, notes, started_at, completed_at
            FROM task_lane_runs
            WHERE task_id = ?1
            ORDER BY started_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task lane run query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok(TaskLaneRun {
                id: row.get(0)?,
                task_id: row.get(1)?,
                lane_id: row.get(2)?,
                session_id: row.get(3)?,
                result: row.get(4)?,
                notes: row.get(5)?,
                started_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Unable to read task lane runs for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task lane runs for {task_id}: {error}"))
}

fn load_parent_summary(
    connection: &Connection,
    parent_task_id: Option<&str>,
) -> Result<Option<TaskSummary>, String> {
    match parent_task_id {
        Some(parent_task_id) => load_task_summary(connection, parent_task_id).map(Some),
        None => Ok(None),
    }
}

fn load_lineage(
    connection: &Connection,
    mut parent_task_id: Option<String>,
) -> Result<Vec<TaskSummary>, String> {
    let mut lineage = Vec::new();

    while let Some(current_parent_id) = parent_task_id {
        let parent = load_task_summary(connection, &current_parent_id)?;
        parent_task_id = parent.parent_task_id.clone();
        lineage.push(parent);
    }

    lineage.reverse();
    Ok(lineage)
}

fn load_child_tasks(connection: &Connection, task_id: &str) -> Result<Vec<TaskSummary>, String> {
    let mut statement = connection
        .prepare(&format!(
            r#"
            SELECT
                {summary_columns}
            FROM tasks t
            WHERE t.parent_task_id = ?1
            ORDER BY t.archived ASC, t.sequence_number ASC, t.created_at ASC
            "#,
            summary_columns = task_summary_columns("t"),
        ))
        .map_err(|error| format!("Unable to prepare child task query: {error}"))?;

    let rows = statement
        .query_map([task_id], map_task_summary_row)
        .map_err(|error| format!("Unable to query child tasks for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect child tasks for {task_id}: {error}"))
}

fn load_task_summary(connection: &Connection, task_id: &str) -> Result<TaskSummary, String> {
    connection
        .query_row(
            &format!(
                r#"
                SELECT
                    {summary_columns}
                FROM tasks t
                WHERE t.id = ?1
                "#,
                summary_columns = task_summary_columns("t"),
            ),
            [task_id],
            map_task_summary_row,
        )
        .map_err(|error| format!("Unable to load task summary {task_id}: {error}"))
}

fn load_dependency(connection: &Connection, dependency_id: &str) -> Result<TaskDependency, String> {
    let dependency = connection
        .query_row(
            r#"
            SELECT id, blocker_task_id, blocked_task_id, created_at
            FROM task_dependencies
            WHERE id = ?1
            "#,
            [dependency_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task dependency {dependency_id}: {error}"))?
        .ok_or_else(|| format!("Task dependency {dependency_id} was not found"))?;

    Ok(TaskDependency {
        id: dependency.0,
        blocker: load_task_summary(connection, &dependency.1)?,
        blocked: load_task_summary(connection, &dependency.2)?,
        blocker_task_id: dependency.1,
        blocked_task_id: dependency.2,
        created_at: dependency.3,
    })
}

fn load_blocked_by_dependencies(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskDependency>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, blocker_task_id, blocked_task_id, created_at
            FROM task_dependencies
            WHERE blocked_task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare blocked-by dependency query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| {
            format!("Unable to query blocked-by dependencies for {task_id}: {error}")
        })?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!("Unable to collect blocked-by dependencies for {task_id}: {error}")
        })?
        .into_iter()
        .map(|(id, blocker_task_id, blocked_task_id, created_at)| {
            Ok(TaskDependency {
                id,
                blocker: load_task_summary(connection, &blocker_task_id)?,
                blocked: load_task_summary(connection, &blocked_task_id)?,
                blocker_task_id,
                blocked_task_id,
                created_at,
            })
        })
        .collect()
}

fn load_blocking_dependencies(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskDependency>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, blocker_task_id, blocked_task_id, created_at
            FROM task_dependencies
            WHERE blocker_task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare blocking dependency query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("Unable to query blocking dependencies for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect blocking dependencies for {task_id}: {error}"))?
        .into_iter()
        .map(|(id, blocker_task_id, blocked_task_id, created_at)| {
            Ok(TaskDependency {
                id,
                blocker: load_task_summary(connection, &blocker_task_id)?,
                blocked: load_task_summary(connection, &blocked_task_id)?,
                blocker_task_id,
                blocked_task_id,
                created_at,
            })
        })
        .collect()
}

fn next_task_sequence_number(connection: &Connection, project_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM tasks WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to calculate next task number for {project_id}: {error}"))
}

fn task_exists(connection: &Connection, task_id: &str) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1 LIMIT 1",
            [task_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up task {task_id}: {error}"))?;
    Ok(exists.is_some())
}

fn task_project_id(connection: &Connection, task_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to read project for task {task_id}: {error}"))
}

fn workflow_exists(connection: &Connection, workflow_id: &str) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM workflows WHERE id = ?1 LIMIT 1",
            [workflow_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up workflow {workflow_id}: {error}"))?;
    Ok(exists.is_some())
}

fn lane_exists_for_workflow(
    connection: &Connection,
    workflow_id: &str,
    lane_id: &str,
) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM workflow_lanes WHERE workflow_id = ?1 AND id = ?2 LIMIT 1",
            params![workflow_id, lane_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up workflow lane {lane_id}: {error}"))?;
    Ok(exists.is_some())
}

fn first_lane_id(connection: &Connection, workflow_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT id FROM workflow_lanes WHERE workflow_id = ?1 ORDER BY lane_order ASC LIMIT 1",
            [workflow_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to read first lane for workflow {workflow_id}: {error}"))
}

fn lane_owner_for_workflow(
    connection: &Connection,
    workflow_id: &str,
    lane_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    connection
        .query_row(
            "SELECT assigned_entity_type, assigned_entity_id FROM workflow_lanes WHERE workflow_id = ?1 AND id = ?2 LIMIT 1",
            params![workflow_id, lane_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to read workflow lane owner {lane_id}: {error}"))
}

fn dependency_exists(
    connection: &Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM task_dependencies WHERE blocker_task_id = ?1 AND blocked_task_id = ?2 LIMIT 1",
            params![blocker_task_id, blocked_task_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query task dependency edge: {error}"))?;
    Ok(exists.is_some())
}

fn unresolved_blocker_count(connection: &Connection, task_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM task_dependencies d
            JOIN tasks blocker ON blocker.id = d.blocker_task_id
            WHERE d.blocked_task_id = ?1
              AND blocker.status NOT IN ('completed', 'canceled')
            "#,
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to compute unresolved blockers for {task_id}: {error}"))
}

fn would_create_parent_cycle(
    connection: &Connection,
    task_id: &str,
    proposed_parent_id: &str,
) -> Result<bool, String> {
    let mut current = Some(proposed_parent_id.to_string());

    while let Some(current_id) = current {
        if current_id == task_id {
            return Ok(true);
        }

        current = connection
            .query_row(
                "SELECT parent_task_id FROM tasks WHERE id = ?1",
                [current_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("Unable to traverse task hierarchy: {error}"))?
            .flatten();
    }

    Ok(false)
}

fn would_create_dependency_cycle(
    connection: &Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<bool, String> {
    let mut stack = vec![blocked_task_id.to_string()];
    let mut visited = std::collections::HashSet::new();

    while let Some(current) = stack.pop() {
        if !visited.insert(current.clone()) {
            continue;
        }

        if current == blocker_task_id {
            return Ok(true);
        }

        let mut statement = connection
            .prepare("SELECT blocked_task_id FROM task_dependencies WHERE blocker_task_id = ?1")
            .map_err(|error| format!("Unable to prepare dependency traversal query: {error}"))?;
        let rows = statement
            .query_map([current], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Unable to traverse task dependency graph: {error}"))?;

        for child in rows {
            stack
                .push(child.map_err(|error| {
                    format!("Unable to read dependency traversal row: {error}")
                })?);
        }
    }

    Ok(false)
}

fn normalize_input(mut input: TaskUpsertInput) -> TaskUpsertInput {
    input.title = input.title.trim().to_string();
    input.description = normalized_optional_string(input.description);
    input.task_type = input.task_type.trim().to_string();
    input.status = input.status.trim().to_string();
    input.priority = input.priority.trim().to_string();
    input.workflow_id = normalized_optional_string(input.workflow_id);
    input.current_lane_id = normalized_optional_string(input.current_lane_id);
    input.assignee_type = input.assignee_type.trim().to_string();
    input.assignee_id = normalized_optional_string(input.assignee_id);
    input.repository_id = normalized_optional_string(input.repository_id);
    input.repository_ids = input
        .repository_ids
        .into_iter()
        .filter_map(|value| normalized_optional_string(Some(value)))
        .collect();
    if input.repository_ids.is_empty() {
        if let Some(repository_id) = input.repository_id.clone() {
            input.repository_ids.push(repository_id);
        }
    }
    input.repository_ids.sort();
    input.repository_ids.dedup();
    input.repository_id = input.repository_ids.first().cloned();
    input.parent_task_id = normalized_optional_string(input.parent_task_id);
    input
}

fn apply_default_task_repositories(
    connection: &Connection,
    project_id: &str,
    mut input: TaskUpsertInput,
) -> Result<TaskUpsertInput, String> {
    if input.repository_ids.is_empty() {
        let default_repository_id = connection
            .query_row(
                "SELECT default_repository_id FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!("Unable to resolve default repository for project {project_id}: {error}")
            })?
            .flatten();
        if let Some(default_repository_id) = default_repository_id {
            input.repository_ids.push(default_repository_id.clone());
            input.repository_id = Some(default_repository_id);
        }
    }

    Ok(input)
}

fn apply_default_lane_if_needed(
    connection: &Connection,
    mut input: TaskUpsertInput,
) -> Result<TaskUpsertInput, String> {
    if input.current_lane_id.is_none() {
        if let Some(workflow_id) = input.workflow_id.as_deref() {
            input.current_lane_id = first_lane_id(connection, workflow_id)?;
        }
    }

    if let (Some(workflow_id), Some(current_lane_id)) = (
        input.workflow_id.as_deref(),
        input.current_lane_id.as_deref(),
    ) {
        if let Some((assignee_type, assignee_id)) =
            lane_owner_for_workflow(connection, workflow_id, current_lane_id)?
        {
            input.assignee_type = assignee_type;
            input.assignee_id = assignee_id;
        }
    }
    Ok(input)
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn sync_task_repository_links(
    connection: &rusqlite::Transaction<'_>,
    task_id: &str,
    project_id: &str,
    repository_ids: &[String],
    created_at: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM task_repositories WHERE task_id = ?1",
            [task_id],
        )
        .map_err(|error| format!("Unable to clear task repositories for {task_id}: {error}"))?;

    for repository_id in repository_ids {
        let repository_project_id = connection
            .query_row(
                "SELECT project_id FROM repositories WHERE id = ?1",
                [repository_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| {
                format!("Unable to validate task repository {repository_id}: {error}")
            })?;

        if repository_project_id != project_id {
            return Err(format!(
                "Repository {} does not belong to project {}",
                repository_id, project_id
            ));
        }

        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES (?1, ?2, ?3)",
                params![task_id, repository_id, created_at],
            )
            .map_err(|error| format!("Unable to link task repository {repository_id}: {error}"))?;
    }

    Ok(())
}

fn task_summary_columns(alias: &str) -> String {
    format!(
        r#"
        {alias}.id,
        {alias}.project_id,
        {alias}.number,
        {alias}.title,
        {alias}.description,
        {alias}.task_type,
        {alias}.status,
        {alias}.priority,
        {alias}.workflow_id,
        {alias}.current_lane_id,
        {alias}.assignee_type,
        {alias}.assignee_id,
        {alias}.parent_task_id,
        {alias}.whip_max_attempts,
        {alias}.archived,
        COALESCE((SELECT COUNT(*) FROM task_comments c WHERE c.task_id = {alias}.id), 0) AS comment_count,
        COALESCE((SELECT COUNT(*) FROM task_lane_runs lr WHERE lr.task_id = {alias}.id), 0) AS lane_run_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id), 0) AS child_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.status = 'completed'), 0) AS completed_child_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.status = 'in_progress'), 0) AS in_progress_child_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.status = 'blocked'), 0) AS blocked_child_count,
        COALESCE((SELECT COUNT(*) FROM task_dependencies d WHERE d.blocked_task_id = {alias}.id), 0) AS blocked_by_count,
        COALESCE((SELECT COUNT(*) FROM task_dependencies d WHERE d.blocker_task_id = {alias}.id), 0) AS blocking_count,
        COALESCE((SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = {alias}.id), 0) AS attachment_count,
        CASE WHEN {unresolved_blockers} > 0 THEN 1 ELSE 0 END AS dependency_blocked,
        CASE WHEN {alias}.archived = 0 AND {alias}.workflow_id IS NOT NULL AND {alias}.current_lane_id IS NOT NULL AND {alias}.status IN ('ready', 'in_progress') AND {unresolved_blockers} = 0 AND NOT EXISTS (SELECT 1 FROM task_lane_assignments tla WHERE tla.task_id = {alias}.id AND tla.status IN ('queued', 'active')) THEN 1 ELSE 0 END AS ready_for_dispatch,
        {alias}.created_at,
        {alias}.updated_at
        "#,
        unresolved_blockers = unresolved_blocker_sql(alias),
    )
}

fn unresolved_blocker_sql(alias: &str) -> String {
    format!(
        "COALESCE((SELECT COUNT(*) FROM task_dependencies d JOIN tasks blocker ON blocker.id = d.blocker_task_id WHERE d.blocked_task_id = {alias}.id AND blocker.status NOT IN ('completed', 'canceled')), 0)"
    )
}

fn map_task_summary_row(row: &Row<'_>) -> rusqlite::Result<TaskSummary> {
    Ok(TaskSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        number: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        task_type: row.get(5)?,
        status: row.get(6)?,
        priority: row.get(7)?,
        workflow_id: row.get(8)?,
        current_lane_id: row.get(9)?,
        assignee_type: row.get(10)?,
        assignee_id: row.get(11)?,
        parent_task_id: row.get(12)?,
        whip_max_attempts: row.get(13)?,
        archived: row.get::<_, i64>(14)? != 0,
        comment_count: row.get(15)?,
        lane_run_count: row.get(16)?,
        child_count: row.get(17)?,
        completed_child_count: row.get(18)?,
        in_progress_child_count: row.get(19)?,
        blocked_child_count: row.get(20)?,
        blocked_by_count: row.get(21)?,
        blocking_count: row.get(22)?,
        attachment_count: row.get(23)?,
        dependency_blocked: row.get::<_, i64>(24)? != 0,
        ready_for_dispatch: row.get::<_, i64>(25)? != 0,
        created_at: row.get(26)?,
        updated_at: row.get(27)?,
    })
}

fn task_id() -> String {
    format!("task-{}", Uuid::new_v4().simple())
}

fn dependency_id() -> String {
    format!("task-dependency-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn seed_workflow(connection: &Connection) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
                params!["workflow-dev", "development", "Development", now],
            )
            .expect("insert workflow");
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, success_transition_type, failure_transition_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 'user', 'end', 'end', ?5, ?5)",
                params!["lane-plan", "workflow-dev", "plan", "Plan", now],
            )
            .expect("insert lane");
    }

    fn create_named_task(
        connection: &mut Connection,
        title: &str,
        status: &str,
        parent_task_id: Option<String>,
    ) -> TaskDetail {
        create_task(
            connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: title.into(),
                description: None,
                task_type: if parent_task_id.is_none() {
                    "epic"
                } else {
                    "task"
                }
                .into(),
                status: status.into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("create named task")
    }

    #[test]
    fn create_and_load_task_round_trip() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let epic = create_named_task(&mut connection, "Task system", "ready", None);
        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Map task foundation".into(),
                description: Some("Persist task records".into()),
                task_type: "feature".into(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "role".into(),
                assignee_id: Some("developer".into()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: Some(epic.id.clone()),
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("create task");

        assert_eq!(created.number, "ORC-2");
        assert_eq!(created.parent_task_id.as_deref(), Some(epic.id.as_str()));
        assert_eq!(created.whip_max_attempts, 10);

        let loaded_epic = get_task(&connection, &epic.id).expect("load epic");
        assert_eq!(loaded_epic.child_count, 1);
        assert_eq!(loaded_epic.in_progress_child_count, 1);
        assert_eq!(loaded_epic.children.len(), 1);
        assert_eq!(loaded_epic.children[0].id, created.id);

        let loaded_child = get_task(&connection, &created.id).expect("load child");
        assert_eq!(loaded_child.lineage.len(), 1);
        assert_eq!(loaded_child.lineage[0].id, epic.id);
        assert_eq!(
            loaded_child.parent.as_ref().map(|task| task.id.as_str()),
            Some(epic.id.as_str())
        );
    }

    #[test]
    fn updates_task_whip_max_attempts() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Whip settings task".into(),
                description: None,
                task_type: "task".into(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(3),
                archived: None,
            },
        )
        .expect("task should create");
        assert_eq!(created.whip_max_attempts, 3);

        let updated = update_task(
            &mut connection,
            &created.id,
            TaskUpsertInput {
                title: created.title.clone(),
                description: created.description.clone(),
                task_type: created.task_type.clone(),
                status: created.status.clone(),
                priority: created.priority.clone(),
                workflow_id: created.workflow_id.clone(),
                current_lane_id: created.current_lane_id.clone(),
                assignee_type: created.assignee_type.clone(),
                assignee_id: created.assignee_id.clone(),
                repository_id: created.repository_id.clone(),
                repository_ids: created.repository_ids.clone(),
                parent_task_id: created.parent_task_id.clone(),
                whip_max_attempts: Some(5),
                archived: Some(created.archived),
            },
        )
        .expect("task should update");
        assert_eq!(updated.whip_max_attempts, 5);
    }

    #[test]
    fn lists_tasks_scoped_to_project() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task_a = create_task(
            &mut connection,
            Some("project-a"),
            TaskUpsertInput {
                title: "Task A".into(),
                description: None,
                task_type: "task".into(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task A should create");
        let task_b = create_task(
            &mut connection,
            Some("project-b"),
            TaskUpsertInput {
                title: "Task B".into(),
                description: None,
                task_type: "task".into(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task B should create");

        let project_a = list_tasks(&connection, "project-a", false).expect("project A tasks");
        let project_b = list_tasks(&connection, "project-b", false).expect("project B tasks");
        assert_eq!(project_a.len(), 1);
        assert_eq!(project_b.len(), 1);
        assert_eq!(project_a[0].id, task_a.id);
        assert_eq!(project_b[0].id, task_b.id);
        assert_eq!(task_a.number, "ORC-1");
        assert_eq!(task_b.number, "ORC-1");
    }

    #[test]
    fn defaults_new_task_repositories_from_project_default_repository() {
        let mut connection = in_memory_connection();
        crate::services::projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "Project With Default Repo".into(),
                description: None,
            },
        )
        .expect("project should create");
        let project = connection
            .query_row(
                "SELECT id FROM projects WHERE name = 'Project With Default Repo'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("project id should load");
        let repository = crate::services::projects::create_repository(
            &connection,
            &project,
            crate::models::RepositoryUpsertInput {
                name: "Default Repo".into(),
                repository_path: Some(std::env::temp_dir().display().to_string()),
                default_branch: Some("main".into()),
            },
        )
        .expect("repository should create");
        crate::services::projects::set_project_default_repository(
            &connection,
            &project,
            Some(&repository.id),
        )
        .expect("default repository should set");

        let task = create_task(
            &mut connection,
            Some(&project),
            TaskUpsertInput {
                title: "Repo default task".into(),
                description: None,
                task_type: "task".into(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        assert_eq!(task.repository_id.as_deref(), Some(repository.id.as_str()));
        assert_eq!(task.repository_ids, vec![repository.id]);
        assert_eq!(task.task_repositories.len(), 1);
    }

    #[test]
    fn rejects_lane_without_matching_workflow() {
        let mut connection = in_memory_connection();
        let error = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Broken".into(),
                description: None,
                task_type: "task".into(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect_err("reject missing workflow for lane");

        assert!(error.contains("currentLaneId"));
    }

    #[test]
    fn rejects_parent_cycles() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let parent = create_named_task(&mut connection, "Parent", "ready", None);
        let child = create_named_task(&mut connection, "Child", "ready", Some(parent.id.clone()));

        let error = update_task(
            &mut connection,
            &parent.id,
            TaskUpsertInput {
                title: parent.title.clone(),
                description: parent.description.clone(),
                task_type: parent.task_type.clone(),
                status: parent.status.clone(),
                priority: parent.priority.clone(),
                workflow_id: parent.workflow_id.clone(),
                current_lane_id: parent.current_lane_id.clone(),
                assignee_type: parent.assignee_type.clone(),
                assignee_id: parent.assignee_id.clone(),
                repository_id: parent.repository_id.clone(),
                repository_ids: parent.repository_ids.clone(),
                parent_task_id: Some(child.id.clone()),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect_err("reject parent cycle");

        assert!(error.contains("cycle"));
    }

    #[test]
    fn adds_comments_with_interrupt_flag() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Comment target", "in_progress", None);
        let comment = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                message: "Please course-correct before continuing.".into(),
                interrupt_agent: true,
                parent_comment_id: None,
            },
        )
        .expect("add task comment");

        assert!(comment.interrupt_agent);
        let loaded = get_task(&connection, &task.id).expect("load task with comments");
        assert_eq!(loaded.comment_count, 1);
        assert_eq!(loaded.comments.len(), 1);
        assert_eq!(loaded.comments[0].author, "Reviewer");
        assert!(loaded.comments[0].interrupt_agent);
    }

    #[test]
    fn supports_comment_replies_on_top_level_comments() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Reply target", "in_progress", None);
        let parent = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                message: "Please split this into smaller steps.".into(),
                interrupt_agent: false,
                parent_comment_id: None,
            },
        )
        .expect("parent comment should add");
        let reply = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Worker".into(),
                message: "Split completed and queued for follow-up review.".into(),
                interrupt_agent: false,
                parent_comment_id: Some(parent.id.clone()),
            },
        )
        .expect("reply should add");

        let comments = list_task_comments(&connection, &task.id).expect("task comments should load");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[1].id, reply.id);
        assert_eq!(comments[1].parent_comment_id.as_deref(), Some(parent.id.as_str()));
    }

    #[test]
    fn rejects_replies_to_replies() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Nested reply target", "in_progress", None);
        let parent = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                message: "Parent comment".into(),
                interrupt_agent: false,
                parent_comment_id: None,
            },
        )
        .expect("parent comment should add");
        let reply = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Worker".into(),
                message: "Reply comment".into(),
                interrupt_agent: false,
                parent_comment_id: Some(parent.id.clone()),
            },
        )
        .expect("reply should add");

        let error = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "User".into(),
                message: "Nested reply".into(),
                interrupt_agent: false,
                parent_comment_id: Some(reply.id.clone()),
            },
        )
        .expect_err("nested reply should be rejected");
        assert!(error.contains("Replies can only target top-level comments"));
    }

    #[test]
    fn tracks_unread_comments_and_records_receipts_per_session() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Unread target", "in_progress", None);
        let now = now_iso();
        let assignment = TaskLaneAssignment {
            id: "assignment-unread".into(),
            task_id: task.id.clone(),
            workflow_id: "workflow-dev".into(),
            lane_id: "lane-plan".into(),
            worker_type: "agent".into(),
            worker_id: Some("agent-data".into()),
            status: "active".into(),
            session_id: Some("session-unread".into()),
            runtime_cwd: Some("/tmp/unread".into()),
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: Some("Prompt".into()),
            whip_count: 0,
            last_whip_at: None,
            started_at: now.clone(),
            completed_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, 0, NULL, ?11, NULL, ?11, ?11)",
                params![
                    assignment.id.as_str(),
                    assignment.task_id.as_str(),
                    assignment.workflow_id.as_str(),
                    assignment.lane_id.as_str(),
                    assignment.worker_type.as_str(),
                    assignment.worker_id.as_deref(),
                    assignment.status.as_str(),
                    assignment.session_id.as_deref(),
                    assignment.runtime_cwd.as_deref(),
                    assignment.prompt.as_deref(),
                    now.as_str(),
                ],
            )
            .expect("assignment should insert");

        let first = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                message: "Check the failing test before you continue.".into(),
                interrupt_agent: false,
                parent_comment_id: None,
            },
        )
        .expect("first comment should add");
        let second = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Lead".into(),
                message: "Also update the release notes.".into(),
                interrupt_agent: true,
                parent_comment_id: None,
            },
        )
        .expect("second comment should add");

        let unread_before = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("unread comments should load");
        assert_eq!(unread_before.len(), 2);
        assert_eq!(unread_before[0].id, first.id);
        assert_eq!(unread_before[1].id, second.id);

        let receipts = mark_task_comments_read(
            &connection,
            &task.id,
            &assignment,
            Some(&[first.id.clone()]),
        )
        .expect("comment receipt should record");
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].comment_id, first.id);
        assert_eq!(receipts[0].assignment_id, assignment.id);
        assert_eq!(receipts[0].session_id, "session-unread");

        let unread_after_first = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("remaining unread comments should load");
        assert_eq!(unread_after_first.len(), 1);
        assert_eq!(unread_after_first[0].id, second.id);

        let remaining_receipts = mark_task_comments_read(&connection, &task.id, &assignment, None)
            .expect("remaining unread comments should mark read");
        assert_eq!(remaining_receipts.len(), 2);
        let unread_after_all = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("all comments should now be read");
        assert!(unread_after_all.is_empty());
    }

    #[test]
    fn adds_dependencies_and_computes_blocked_state() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let blocker = create_named_task(&mut connection, "Blocker", "in_progress", None);
        let blocked = create_named_task(&mut connection, "Blocked", "ready", None);

        add_task_dependency(&mut connection, &blocker.id, &blocked.id).expect("add dependency");

        let loaded = get_task(&connection, &blocked.id).expect("load blocked task");
        assert_eq!(loaded.blocked_by_count, 1);
        assert!(loaded.dependency_blocked);
        assert!(!loaded.ready_for_dispatch);
        assert_eq!(loaded.blocked_by[0].blocker.id, blocker.id);

        let updated_blocker = update_task(
            &mut connection,
            &blocker.id,
            TaskUpsertInput {
                title: blocker.title.clone(),
                description: blocker.description.clone(),
                task_type: blocker.task_type.clone(),
                status: "completed".into(),
                priority: blocker.priority.clone(),
                workflow_id: blocker.workflow_id.clone(),
                current_lane_id: blocker.current_lane_id.clone(),
                assignee_type: blocker.assignee_type.clone(),
                assignee_id: blocker.assignee_id.clone(),
                repository_id: blocker.repository_id.clone(),
                repository_ids: blocker.repository_ids.clone(),
                parent_task_id: blocker.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("complete blocker");

        assert_eq!(updated_blocker.status, "completed");
        let unblocked = get_task(&connection, &blocked.id).expect("reload blocked task");
        assert!(!unblocked.dependency_blocked);
        assert!(unblocked.ready_for_dispatch);
    }

    #[test]
    fn rejects_dependency_cycles() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let alpha = create_named_task(&mut connection, "Alpha", "ready", None);
        let beta = create_named_task(&mut connection, "Beta", "ready", None);
        let gamma = create_named_task(&mut connection, "Gamma", "ready", None);

        add_task_dependency(&mut connection, &alpha.id, &beta.id).expect("alpha blocks beta");
        add_task_dependency(&mut connection, &beta.id, &gamma.id).expect("beta blocks gamma");

        let error = add_task_dependency(&mut connection, &gamma.id, &alpha.id)
            .expect_err("reject dependency cycle");
        assert!(error.contains("cycle"));
    }
}
