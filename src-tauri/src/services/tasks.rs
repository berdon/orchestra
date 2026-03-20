use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Row};
use uuid::Uuid;

use crate::{
    models::{
        TaskAttachment, TaskComment, TaskDependency, TaskDetail, TaskLaneRun, TaskSummary,
        TaskUpsertInput,
    },
    services::task_attachments,
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

pub fn list_tasks(connection: &Connection, include_archived: bool) -> Result<Vec<TaskSummary>, String> {
    let mut statement = connection
        .prepare(&format!(
            r#"
            SELECT
                {summary_columns}
            FROM tasks t
            WHERE (?1 = 1 OR t.archived = 0)
            ORDER BY t.archived ASC, t.updated_at DESC, t.sequence_number DESC
            "#,
            summary_columns = task_summary_columns("t"),
        ))
        .map_err(|error| format!("Unable to prepare task list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], map_task_summary_row)
        .map_err(|error| format!("Unable to query tasks: {error}"))?;

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
                    archived: row.get::<_, i64>(13)? != 0,
                    comment_count: row.get(14)?,
                    lane_run_count: row.get(15)?,
                    child_count: row.get(16)?,
                    completed_child_count: row.get(17)?,
                    in_progress_child_count: row.get(18)?,
                    blocked_child_count: row.get(19)?,
                    blocked_by_count: row.get(20)?,
                    blocking_count: row.get(21)?,
                    attachment_count: row.get(22)?,
                    dependency_blocked: row.get::<_, i64>(23)? != 0,
                    ready_for_dispatch: row.get::<_, i64>(24)? != 0,
                    repository_id: row.get(27)?,
                    parent: None,
                    lineage: Vec::new(),
                    children: Vec::new(),
                    blocked_by: Vec::new(),
                    blocking: Vec::new(),
                    attachments: Vec::new(),
                    comments: Vec::new(),
                    lane_runs: Vec::new(),
                    created_at: row.get(25)?,
                    updated_at: row.get(26)?,
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
    task.comments = load_task_comments(connection, task_id)?;
    task.lane_runs = load_task_lane_runs(connection, task_id)?;
    Ok(task)
}

pub fn create_task(connection: &mut Connection, input: TaskUpsertInput) -> Result<TaskDetail, String> {
    let normalized = normalize_input(input);
    validate_task_input(connection, &normalized, None)?;

    let project_id = DEFAULT_PROJECT_ID.to_string();
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
            archived,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?17)
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
            normalized.repository_id,
            normalized.parent_task_id,
            if normalized.archived.unwrap_or(false) { 1 } else { 0 },
            now,
        ],
    )
    .map_err(|error| format!("Unable to create task: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task creation: {error}"))?;

    get_task(connection, &task_id)
}

pub fn update_task(
    connection: &mut Connection,
    task_id: &str,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let normalized = normalize_input(input);
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
            archived = ?13,
            updated_at = ?14
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
            normalized.repository_id,
            normalized.parent_task_id,
            if normalized.archived.unwrap_or(existing.archived) { 1 } else { 0 },
            now,
        ],
    )
    .map_err(|error| format!("Unable to update task {task_id}: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task update: {error}"))?;

    get_task(connection, task_id)
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
        params![dependency_id, project_id, blocker_task_id, blocked_task_id, now],
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
        .execute("DELETE FROM task_dependencies WHERE id = ?1", [dependency_id])
        .map_err(|error| format!("Unable to remove task dependency {dependency_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task dependency {dependency_id} was not found"));
    }

    Ok(dependency)
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

    if !VALID_ASSIGNEE_TYPES.contains(&input.assignee_type.as_str()) {
        errors.push("assigneeType: Assignee type must be one of: user, agent, role, unassigned.".to_string());
    }

    if matches!(input.assignee_type.as_str(), "user" | "unassigned") && input.assignee_id.is_some() {
        errors.push("assigneeId: User/unassigned tasks must not specify an assignee id.".to_string());
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
                errors.push("currentLaneId: Lane does not belong to the selected workflow.".to_string());
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

fn load_task_comments(connection: &Connection, task_id: &str) -> Result<Vec<TaskComment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, author, message, interrupt_agent, created_at, updated_at
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
                author: row.get(2)?,
                message: row.get(3)?,
                interrupt_agent: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
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

fn load_lineage(connection: &Connection, mut parent_task_id: Option<String>) -> Result<Vec<TaskSummary>, String> {
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
        .map_err(|error| format!("Unable to query blocked-by dependencies for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect blocked-by dependencies for {task_id}: {error}"))?
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
            stack.push(child.map_err(|error| format!("Unable to read dependency traversal row: {error}"))?);
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
    input.parent_task_id = normalized_optional_string(input.parent_task_id);
    input
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
        CASE WHEN {alias}.archived = 0 AND {alias}.status IN ('ready', 'in_progress') AND {unresolved_blockers} = 0 THEN 1 ELSE 0 END AS ready_for_dispatch,
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
        archived: row.get::<_, i64>(13)? != 0,
        comment_count: row.get(14)?,
        lane_run_count: row.get(15)?,
        child_count: row.get(16)?,
        completed_child_count: row.get(17)?,
        in_progress_child_count: row.get(18)?,
        blocked_child_count: row.get(19)?,
        blocked_by_count: row.get(20)?,
        blocking_count: row.get(21)?,
        attachment_count: row.get(22)?,
        dependency_blocked: row.get::<_, i64>(23)? != 0,
        ready_for_dispatch: row.get::<_, i64>(24)? != 0,
        created_at: row.get(25)?,
        updated_at: row.get(26)?,
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
            TaskUpsertInput {
                title: title.into(),
                description: None,
                task_type: if parent_task_id.is_none() { "epic" } else { "task" }.into(),
                status: status.into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                parent_task_id,
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
                parent_task_id: Some(epic.id.clone()),
                archived: None,
            },
        )
        .expect("create task");

        assert_eq!(created.number, "ORC-2");
        assert_eq!(created.parent_task_id.as_deref(), Some(epic.id.as_str()));

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
    fn rejects_lane_without_matching_workflow() {
        let mut connection = in_memory_connection();
        let error = create_task(
            &mut connection,
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
                parent_task_id: None,
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
                parent_task_id: Some(child.id.clone()),
                archived: Some(false),
            },
        )
        .expect_err("reject parent cycle");

        assert!(error.contains("cycle"));
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
                parent_task_id: blocker.parent_task_id.clone(),
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
