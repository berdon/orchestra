use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{TaskComment, TaskDetail, TaskLaneRun, TaskSummary, TaskUpsertInput};

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

pub fn list_tasks(connection: &Connection, include_archived: bool) -> Result<Vec<TaskSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                t.id,
                t.project_id,
                t.number,
                t.title,
                t.description,
                t.task_type,
                t.status,
                t.priority,
                t.workflow_id,
                t.current_lane_id,
                t.assignee_type,
                t.assignee_id,
                t.parent_task_id,
                t.archived,
                COALESCE((SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id), 0) AS comment_count,
                COALESCE((SELECT COUNT(*) FROM task_lane_runs lr WHERE lr.task_id = t.id), 0) AS lane_run_count,
                t.created_at,
                t.updated_at
            FROM tasks t
            WHERE (?1 = 1 OR t.archived = 0)
            ORDER BY t.archived ASC, t.updated_at DESC, t.sequence_number DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], |row| {
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
                created_at: row.get(16)?,
                updated_at: row.get(17)?,
            })
        })
        .map_err(|error| format!("Unable to query tasks: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read task rows: {error}"))
}

pub fn get_task(connection: &Connection, task_id: &str) -> Result<TaskDetail, String> {
    let mut task = connection
        .query_row(
            r#"
            SELECT
                t.id,
                t.project_id,
                t.number,
                t.title,
                t.description,
                t.task_type,
                t.status,
                t.priority,
                t.workflow_id,
                t.current_lane_id,
                t.assignee_type,
                t.assignee_id,
                t.repository_id,
                t.parent_task_id,
                t.archived,
                COALESCE((SELECT COUNT(*) FROM task_comments c WHERE c.task_id = t.id), 0) AS comment_count,
                COALESCE((SELECT COUNT(*) FROM task_lane_runs lr WHERE lr.task_id = t.id), 0) AS lane_run_count,
                t.created_at,
                t.updated_at
            FROM tasks t
            WHERE t.id = ?1
            "#,
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
                    repository_id: row.get(12)?,
                    parent_task_id: row.get(13)?,
                    archived: row.get::<_, i64>(14)? != 0,
                    comment_count: row.get(15)?,
                    lane_run_count: row.get(16)?,
                    comments: Vec::new(),
                    lane_runs: Vec::new(),
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query task {task_id}: {error}"))?
        .ok_or_else(|| format!("Task {task_id} was not found"))?;

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

fn task_id() -> String {
    format!("task-{}", Uuid::new_v4().simple())
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

    #[test]
    fn create_and_load_task_round_trip() {
        let mut connection = in_memory_connection();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
                params!["workflow-dev", "development", "Development", now_iso()],
            )
            .expect("insert workflow");
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, success_transition_type, failure_transition_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 'user', 'end', 'end', ?5, ?5)",
                params!["lane-plan", "workflow-dev", "plan", "Plan", now_iso()],
            )
            .expect("insert lane");

        let created = create_task(
            &mut connection,
            TaskUpsertInput {
                title: "Map task foundation".into(),
                description: Some("Persist task records".into()),
                task_type: "feature".into(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                parent_task_id: None,
                archived: None,
            },
        )
        .expect("create task");

        assert_eq!(created.number, "ORC-1");
        assert_eq!(created.title, "Map task foundation");
        assert_eq!(created.workflow_id.as_deref(), Some("workflow-dev"));
        assert_eq!(created.current_lane_id.as_deref(), Some("lane-plan"));

        let listed = list_tasks(&connection, false).expect("list tasks");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
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
}
