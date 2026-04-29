use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    models::{
        AgentDefinition, AuthorizationContext, RepositoryRecord, RoleDefinition, TaskComment,
        TaskDetail, TaskLaneAssignment, TaskRepository, WorkflowDefinition, WorkflowLane,
    },
    services::{
        agent_dispatch, agent_runtime, agents, live_sessions, messages, notifications, pi_sessions,
        project_settings, projects, role_dispatch, role_runtime, roles, session_list,
        task_repositories, tasks, workflows,
    },
    state::{generate_id, now_iso, AppState},
};

const ASSIGNMENT_STATUS_QUEUED: &str = "queued";
const ASSIGNMENT_STATUS_ACTIVE: &str = "active";
const ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL: &str = "awaiting_user_approval";
const ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION: &str = "awaiting_user_intervention";
const ASSIGNMENT_STATUS_PAUSED_BY_USER: &str = "paused_by_user";
const ASSIGNMENT_STATUS_COMPLETED: &str = "completed";
const ASSIGNMENT_STATUS_FAILED: &str = "failed";
const ASSIGNMENT_STATUS_CANCELED: &str = "canceled";
const DEFAULT_TASK_WHIP_MAX_ATTEMPTS: i64 = 10;
const TASK_WHIP_PROMPT: &str = "Keep working until you are done - when you are done use tool `complete_lane_as_success` (with the task ID and optional notes) unless you believe either you or the task that was sent to you failed - then use tool `complete_lane_as_failure` (with task ID and optional notes). If you believe you need to escalate to the user - use tool `request_user_intervention` (with task ID and optional notes).";

#[derive(Debug, Clone)]
pub struct StaleTaskAssignmentCandidate {
    pub assignment_id: String,
    pub task_id: String,
    pub project_id: String,
    pub session_id: Option<String>,
    pub reason: String,
}

#[derive(Debug, Clone)]
pub struct RestartResumeCandidate {
    pub assignment_id: String,
    pub task_id: String,
    pub project_id: String,
    pub session_id: String,
}

#[derive(Debug, Clone, Default)]
pub struct TaskRuntimeClaimCleanup {
    pub assignments: Vec<TaskLaneAssignment>,
    pub changed: bool,
}

fn session_context_for_task_id(task_id: &str) -> Result<pi_sessions::SessionContext, String> {
    let connection = crate::services::database::open_connection()?;
    let task = tasks::get_task_context(&connection, task_id)?;
    pi_sessions::session_context_for_project_id(&task.project_id)
}

fn is_task_in_user_review_state(task: &TaskDetail) -> bool {
    task.status == "in_review" && task.assignee_type == "user" && task.current_lane_id.is_some()
}

pub fn effective_task_review_assignment_status(
    task: &TaskDetail,
    assignment: &TaskLaneAssignment,
) -> String {
    if is_task_in_user_review_state(task) {
        match assignment.pending_outcome.as_deref() {
            Some("success") => return ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL.to_string(),
            Some("needs_user") => {
                return ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION.to_string()
            }
            Some("paused") => return ASSIGNMENT_STATUS_PAUSED_BY_USER.to_string(),
            _ => {}
        }
    }

    assignment.status.clone()
}

pub fn task_transition_event_reason(outcome: &str, task: &TaskDetail) -> &'static str {
    match task
        .active_lane_assignment
        .as_ref()
        .map(|assignment| assignment.status.as_str())
    {
        Some(ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL) if outcome == "success" => {
            "task.transition.awaiting_user_approval"
        }
        Some(ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION) if outcome == "needs_user" => {
            "task.transition.awaiting_user_intervention"
        }
        _ => match outcome {
            "success" => "task.transition.success",
            "failure" => "task.transition.failure",
            "needs_user" => "task.transition.needs_user",
            _ => "task.transition.updated",
        },
    }
}

pub fn get_active_lane_assignment(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    connection
        .query_row(
            r#"
            SELECT
                tla.id,
                tla.task_id,
                tla.workflow_id,
                tla.lane_id,
                tla.worker_type,
                tla.worker_id,
                tla.status,
                tla.session_id,
                tla.runtime_cwd,
                tla.role_queue_entry_id,
                tla.role_instance_id,
                tla.prompt,
                tla.pending_outcome,
                tla.completion_notes,
                tla.whip_count,
                tla.last_whip_at,
                tla.started_at,
                tla.completed_at,
                tla.created_at,
                tla.updated_at
            FROM task_lane_assignments tla
            INNER JOIN tasks t ON t.id = tla.task_id
            WHERE tla.task_id = ?1
              AND tla.status IN ('queued', 'active')
              AND t.status NOT IN ('completed', 'canceled')
              AND (t.current_lane_id IS NULL OR tla.lane_id = t.current_lane_id)
            ORDER BY CASE tla.status
                     WHEN 'active' THEN 0
                     ELSE 1
                     END,
                     tla.created_at ASC,
                     tla.id ASC
            LIMIT 1
            "#,
            [task_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| format!("Unable to query active assignment for task {task_id}: {error}"))
}

pub fn get_current_lane_assignment(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    connection
        .query_row(
            r#"
            SELECT
                tla.id,
                tla.task_id,
                tla.workflow_id,
                tla.lane_id,
                tla.worker_type,
                tla.worker_id,
                tla.status,
                tla.session_id,
                tla.runtime_cwd,
                tla.role_queue_entry_id,
                tla.role_instance_id,
                tla.prompt,
                tla.pending_outcome,
                tla.completion_notes,
                tla.whip_count,
                tla.last_whip_at,
                tla.started_at,
                tla.completed_at,
                tla.created_at,
                tla.updated_at
            FROM task_lane_assignments tla
            INNER JOIN tasks t ON t.id = tla.task_id
            WHERE tla.task_id = ?1
              AND tla.status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
              AND t.status NOT IN ('completed', 'canceled')
              AND (t.current_lane_id IS NULL OR tla.lane_id = t.current_lane_id)
            ORDER BY CASE tla.status
                     WHEN 'active' THEN 0
                     WHEN 'awaiting_user_approval' THEN 1
                     WHEN 'awaiting_user_intervention' THEN 2
                     WHEN 'paused_by_user' THEN 3
                     ELSE 4
                     END,
                     tla.created_at ASC,
                     tla.id ASC
            LIMIT 1
            "#,
            [task_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| format!("Unable to query current assignment for task {task_id}: {error}"))
}

pub fn find_open_assignment_for_task_lane(
    connection: &Connection,
    task_id: &str,
    lane_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            FROM task_lane_assignments
            WHERE task_id = ?1
              AND lane_id = ?2
              AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
            ORDER BY CASE status
                     WHEN 'active' THEN 0
                     WHEN 'awaiting_user_approval' THEN 1
                     WHEN 'awaiting_user_intervention' THEN 2
                     WHEN 'paused_by_user' THEN 3
                     ELSE 4
                     END,
                     created_at ASC,
                     id ASC
            LIMIT 1
            "#,
            params![task_id, lane_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query open assignment for task {task_id} lane {lane_id}: {error}")
        })
}

pub fn cancel_duplicate_open_assignments_for_task_lane(
    connection: &Connection,
    task_id: &str,
    lane_id: &str,
    keep_assignment_id: &str,
    reason: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM task_lane_assignments
            WHERE task_id = ?1
              AND lane_id = ?2
              AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
              AND id <> ?3
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| {
            format!(
                "Unable to prepare duplicate assignment query for task {task_id} lane {lane_id}: {error}"
            )
        })?;
    let duplicate_ids = statement
        .query_map(params![task_id, lane_id, keep_assignment_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| {
            format!(
                "Unable to query duplicate assignments for task {task_id} lane {lane_id}: {error}"
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Unable to read duplicate assignments for task {task_id} lane {lane_id}: {error}"
            )
        })?;

    if duplicate_ids.is_empty() {
        return Ok(duplicate_ids);
    }

    let now = now_iso();
    for duplicate_id in &duplicate_ids {
        connection
            .execute(
                r#"
                UPDATE task_lane_assignments
                SET status = 'canceled',
                    session_id = NULL,
                    runtime_cwd = NULL,
                    role_instance_id = NULL,
                    pending_outcome = NULL,
                    completion_notes = ?2,
                    completed_at = ?3,
                    updated_at = ?3
                WHERE id = ?1
                  AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
                "#,
                params![duplicate_id, reason, now],
            )
            .map_err(|error| {
                format!("Unable to cancel duplicate assignment {duplicate_id}: {error}")
            })?;
    }

    Ok(duplicate_ids)
}

fn task_is_runnable_for_worker_runtime(
    connection: &Connection,
    task: &TaskDetail,
    workflow_id: Option<&str>,
    lane_id: &str,
) -> Result<bool, String> {
    if task.archived
        || task.dependency_blocked
        || !matches!(task.status.as_str(), "ready" | "in_progress")
    {
        return Ok(false);
    }

    if task.current_lane_id.as_deref() != Some(lane_id) {
        return Ok(false);
    }

    if let Some(workflow_id) = workflow_id {
        if task.workflow_id.as_deref() != Some(workflow_id) {
            return Ok(false);
        }
    }

    let Some(task_workflow_id) = task.workflow_id.as_deref() else {
        return Ok(false);
    };
    let workflow = match workflows::get_workflow(connection, task_workflow_id) {
        Ok(workflow) => workflow,
        Err(_) => return Ok(false),
    };
    let Some(lane) = workflow.lanes.iter().find(|lane| lane.id == lane_id) else {
        return Ok(false);
    };

    Ok(matches!(
        lane.assigned_entity_type.as_str(),
        "role" | "agent"
    ))
}

pub fn task_lane_queue_source_is_valid(
    connection: &Connection,
    task_id: &str,
    workflow_id: Option<&str>,
    lane_id: &str,
) -> Result<bool, String> {
    let Ok(task) = tasks::get_task_context(connection, task_id) else {
        return Ok(false);
    };

    task_is_runnable_for_worker_runtime(connection, &task, workflow_id, lane_id)
}

pub fn get_assignment_by_id(
    connection: &Connection,
    assignment_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            FROM task_lane_assignments
            WHERE id = ?1
            "#,
            [assignment_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| format!("Unable to query assignment {assignment_id}: {error}"))
}

pub fn list_restart_resume_candidates(
    connection: &Connection,
) -> Result<Vec<RestartResumeCandidate>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT tla.id, tla.task_id, t.project_id, tla.session_id
            FROM task_lane_assignments tla
            INNER JOIN tasks t ON t.id = tla.task_id
            WHERE tla.status = 'active'
              AND tla.worker_type IN ('agent', 'role')
              AND tla.session_id IS NOT NULL
              AND trim(tla.session_id) != ''
            ORDER BY tla.updated_at ASC, tla.created_at ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare restart resume candidate query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(RestartResumeCandidate {
                assignment_id: row.get(0)?,
                task_id: row.get(1)?,
                project_id: row.get(2)?,
                session_id: row.get(3)?,
            })
        })
        .map_err(|error| format!("Unable to query restart resume candidates: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect restart resume candidates: {error}"))
}

pub fn build_restart_resume_message(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
) -> Result<String, String> {
    let task = tasks::get_task_context(connection, &assignment.task_id)?;
    let workflow = load_task_workflow(connection, &task)?;
    let lane_name = workflow
        .lanes
        .iter()
        .find(|lane| lane.id == assignment.lane_id)
        .map(|lane| lane.name.clone())
        .unwrap_or_else(|| assignment.lane_id.clone());

    Ok(format!(
        "Orchestra restarted while you were actively working task {} ({}) in lane {}. Resume the active task now from the existing session context. Before continuing, call get_unread_task_comments({}) and get_unread_mail({}) so you pick up anything that arrived while Orchestra was offline, then continue the lane and use the appropriate completion tool when you are done.",
        task.number,
        task.title,
        lane_name,
        task.id,
        task.id,
    ))
}

pub fn list_current_role_assignments(
    connection: &Connection,
    role_id: &str,
) -> Result<Vec<TaskLaneAssignment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            FROM task_lane_assignments
            WHERE worker_type = 'role'
              AND worker_id = ?1
              AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
            ORDER BY updated_at DESC, created_at DESC
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare role assignment query for {role_id}: {error}")
        })?;

    let rows = statement
        .query_map([role_id], read_assignment)
        .map_err(|error| {
            format!("Unable to query current role assignments for {role_id}: {error}")
        })?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read current role assignments for {role_id}: {error}"))
}

pub fn get_active_assignment_for_session(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    connection
        .query_row(
            r#"
            SELECT
                tla.id,
                tla.task_id,
                tla.workflow_id,
                tla.lane_id,
                tla.worker_type,
                tla.worker_id,
                tla.status,
                tla.session_id,
                tla.runtime_cwd,
                tla.role_queue_entry_id,
                tla.role_instance_id,
                tla.prompt,
                tla.pending_outcome,
                tla.completion_notes,
                tla.whip_count,
                tla.last_whip_at,
                tla.started_at,
                tla.completed_at,
                tla.created_at,
                tla.updated_at
            FROM task_lane_assignments tla
            INNER JOIN tasks t ON t.id = tla.task_id
            WHERE tla.session_id = ?1
              AND tla.status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
              AND t.status NOT IN ('completed', 'canceled')
              AND (t.current_lane_id IS NULL OR tla.lane_id = t.current_lane_id)
            ORDER BY CASE tla.status
                       WHEN 'active' THEN 0
                       WHEN 'awaiting_user_approval' THEN 1
                       WHEN 'awaiting_user_intervention' THEN 2
                       WHEN 'paused_by_user' THEN 3
                       ELSE 4
                     END,
                     tla.created_at ASC,
                     tla.id ASC
            LIMIT 1
            "#,
            [session_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| format!("Unable to query assignment for session {session_id}: {error}"))
}

pub fn rotate_open_assignment_session(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    new_session_id: &str,
    now: &str,
) -> Result<TaskLaneAssignment, String> {
    if !matches!(
        assignment.status.as_str(),
        ASSIGNMENT_STATUS_QUEUED
            | ASSIGNMENT_STATUS_ACTIVE
            | ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
    ) {
        return Err(format!(
            "Assignment {} is not open and cannot rotate sessions",
            assignment.id
        ));
    }

    if let Some(session_id) = assignment.session_id.as_deref() {
        update_open_lane_run(
            connection,
            &assignment.task_id,
            &assignment.lane_id,
            Some(session_id),
            ASSIGNMENT_STATUS_CANCELED,
            Some("Session rotated by operator.".into()),
            now,
        )?;
    }

    complete_assignment(connection, &assignment.id, ASSIGNMENT_STATUS_CANCELED, now)?;

    let replacement = TaskLaneAssignment {
        id: generate_id("assignment"),
        task_id: assignment.task_id.clone(),
        workflow_id: assignment.workflow_id.clone(),
        lane_id: assignment.lane_id.clone(),
        worker_type: assignment.worker_type.clone(),
        worker_id: assignment.worker_id.clone(),
        status: assignment.status.clone(),
        session_id: Some(new_session_id.to_string()),
        runtime_cwd: assignment.runtime_cwd.clone(),
        role_queue_entry_id: assignment.role_queue_entry_id.clone(),
        role_instance_id: assignment.role_instance_id.clone(),
        prompt: assignment.prompt.clone(),
        pending_outcome: assignment.pending_outcome.clone(),
        completion_notes: assignment.completion_notes.clone(),
        whip_count: assignment.whip_count,
        last_whip_at: assignment.last_whip_at.clone(),
        started_at: now.to_string(),
        completed_at: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    };

    insert_assignment(connection, &replacement)?;
    ensure_lane_run(
        connection,
        &replacement.task_id,
        &replacement.lane_id,
        new_session_id,
        now,
    )?;

    Ok(replacement)
}

fn list_open_task_lane_assignments(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskLaneAssignment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            FROM task_lane_assignments
            WHERE task_id = ?1
              AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare open task lane assignment query for {task_id}: {error}")
        })?;

    let rows = statement
        .query_map([task_id], read_assignment)
        .map_err(|error| {
            format!("Unable to query open task lane assignments for {task_id}: {error}")
        })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        format!("Unable to collect open task lane assignments for {task_id}: {error}")
    })
}

pub fn clear_task_runtime_claims_preserving_status(
    connection: &mut Connection,
    task_id: &str,
    notes: Option<String>,
) -> Result<TaskRuntimeClaimCleanup, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    let assignments = list_open_task_lane_assignments(connection, task_id)?;
    let now = now_iso();
    let normalized_notes = normalize_optional(notes);

    let mut impacted_agent_ids = connection
        .prepare(
            r#"
            SELECT DISTINCT agent_id
            FROM agent_queue_entries
            WHERE source_task_id = ?1
              AND status IN ('queued', 'dispatched', 'paused_by_user')
            ORDER BY agent_id ASC
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare blocked-task agent queue query for {task_id}: {error}")
        })?
        .query_map([task_id], |row| row.get::<_, String>(0))
        .map_err(|error| {
            format!("Unable to query blocked-task agent queue rows for {task_id}: {error}")
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!("Unable to collect blocked-task agent queue rows for {task_id}: {error}")
        })?;

    for assignment in &assignments {
        if assignment.worker_type == "agent" {
            if let Some(worker_id) = assignment.worker_id.clone() {
                if !impacted_agent_ids.contains(&worker_id) {
                    impacted_agent_ids.push(worker_id);
                }
            }
        }
    }

    let mut impacted_role_instance_ids = connection
        .prepare(
            r#"
            SELECT DISTINCT assigned_instance_id
            FROM role_queue_entries
            WHERE source_task_id = ?1
              AND status IN ('queued', 'assigned', 'paused_by_user')
              AND assigned_instance_id IS NOT NULL
            ORDER BY assigned_instance_id ASC
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare blocked-task role queue query for {task_id}: {error}")
        })?
        .query_map([task_id], |row| row.get::<_, String>(0))
        .map_err(|error| {
            format!("Unable to query blocked-task role queue rows for {task_id}: {error}")
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!("Unable to collect blocked-task role queue rows for {task_id}: {error}")
        })?;

    for assignment in &assignments {
        if let Some(instance_id) = assignment.role_instance_id.clone() {
            if !impacted_role_instance_ids.contains(&instance_id) {
                impacted_role_instance_ids.push(instance_id);
            }
        }
    }

    let tx = connection.transaction().map_err(|error| {
        format!("Unable to start task runtime cleanup transaction for {task_id}: {error}")
    })?;

    for assignment in assignments
        .iter()
        .filter(|assignment| assignment.session_id.is_some())
    {
        update_open_lane_run(
            &tx,
            task_id,
            &assignment.lane_id,
            assignment.session_id.as_deref(),
            ASSIGNMENT_STATUS_CANCELED,
            normalized_notes.clone(),
            &now,
        )?;
    }

    let mut changed = false;
    let cleared_assignments = tx
        .execute(
            "UPDATE task_lane_assignments SET status = ?2, pending_outcome = NULL, completion_notes = ?4, completed_at = ?3, updated_at = ?3 WHERE task_id = ?1 AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')",
            params![task_id, ASSIGNMENT_STATUS_CANCELED, now, normalized_notes.as_deref()],
        )
        .map_err(|error| format!("Unable to clear open task lane assignments for blocked task {task_id}: {error}"))?;
    changed |= cleared_assignments > 0;

    let cleared_agent_queue = tx
        .execute(
            "UPDATE agent_queue_entries SET status = 'canceled', completed_at = ?2, updated_at = ?2 WHERE source_task_id = ?1 AND status IN ('queued', 'dispatched', 'paused_by_user')",
            params![task_id, now],
        )
        .map_err(|error| format!("Unable to clear agent queue entries for blocked task {task_id}: {error}"))?;
    changed |= cleared_agent_queue > 0;

    let cleared_role_queue = tx
        .execute(
            "UPDATE role_queue_entries SET status = 'canceled', assigned_instance_id = NULL, started_at = NULL, completed_at = ?2, updated_at = ?2 WHERE source_task_id = ?1 AND status IN ('queued', 'assigned', 'paused_by_user')",
            params![task_id, now],
        )
        .map_err(|error| format!("Unable to clear role queue entries for blocked task {task_id}: {error}"))?;
    changed |= cleared_role_queue > 0;

    for agent_id in &impacted_agent_ids {
        // For global agents, use the default project; otherwise use the task's project
        let agent = agents::get_agent(&tx, agent_id).map_err(|error| {
            format!("Unable to load agent {agent_id} for blocked task {task_id}: {error}")
        })?;
        let effective_project_id = if agent.scope == "global" {
            "orchestra".to_string()
        } else {
            task.project_id.clone()
        };
        let updated = tx
            .execute(
                "UPDATE agent_runtime_states SET status = 'idle', current_queue_entry_id = NULL, last_error = NULL, updated_at = ?3 WHERE project_id = ?1 AND agent_id = ?2",
                params![effective_project_id, agent_id, now],
            )
            .map_err(|error| {
                format!("Unable to reset agent runtime state for blocked task {task_id}: {error}")
            })?;
        changed |= updated > 0;
    }

    for role_instance_id in &impacted_role_instance_ids {
        let updated = tx
            .execute(
                "UPDATE role_instances SET status = 'canceled', current_queue_entry_id = NULL, session_id = NULL, last_error = ?3, updated_at = ?2 WHERE id = ?1",
                params![role_instance_id, now, normalized_notes.as_deref()],
            )
            .map_err(|error| {
                format!("Unable to reset role instance for blocked task {task_id}: {error}")
            })?;
        changed |= updated > 0;
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit task runtime cleanup for {task_id}: {error}"))?;

    Ok(TaskRuntimeClaimCleanup {
        assignments,
        changed,
    })
}

pub fn cancel_dispatch_for_dependency_block(
    connection: &mut Connection,
    task_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    if !task.dependency_blocked {
        return Ok(None);
    }

    let cleanup = clear_task_runtime_claims_preserving_status(
        connection,
        task_id,
        Some("Task became blocked by unresolved dependencies or unfinished subtasks.".to_string()),
    )?;
    Ok(cleanup.assignments.into_iter().next())
}

pub fn stop_task_activity(
    connection: &mut Connection,
    task_id: &str,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    let assignment = get_current_lane_assignment(connection, task_id)?;
    let now = now_iso();
    let normalized_notes = normalize_optional(notes);
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task stop transaction: {error}"))?;

    if let Some(active_assignment) = assignment.as_ref() {
        if active_assignment.session_id.is_some() {
            update_open_lane_run(
                &tx,
                task_id,
                &active_assignment.lane_id,
                active_assignment.session_id.as_deref(),
                ASSIGNMENT_STATUS_CANCELED,
                normalized_notes.clone(),
                &now,
            )?;
        }
    }

    tx.execute(
        "UPDATE task_lane_assignments SET status = ?2, pending_outcome = NULL, completion_notes = ?4, completed_at = ?3, updated_at = ?3 WHERE task_id = ?1 AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')",
        params![task_id, ASSIGNMENT_STATUS_CANCELED, now, normalized_notes.as_deref()],
    )
    .map_err(|error| format!("Unable to clear task lane assignments for {task_id}: {error}"))?;

    tx.execute(
        "UPDATE tasks SET status = 'ready', updated_at = ?2 WHERE id = ?1 AND status IN ('in_progress', 'in_review', 'blocked')",
        params![task_id, now],
    )
    .map_err(|error| format!("Unable to reset task status for {task_id}: {error}"))?;

    tx.execute(
        "UPDATE agent_queue_entries SET status = 'completed', completed_at = ?2, updated_at = ?2 WHERE source_task_id = ?1 AND status IN ('queued', 'dispatched', 'paused_by_user')",
        params![task_id, now],
    )
    .map_err(|error| format!("Unable to clear agent queue entries for {task_id}: {error}"))?;

    tx.execute(
        "UPDATE role_queue_entries SET status = 'canceled', completed_at = ?2, updated_at = ?2 WHERE source_task_id = ?1 AND status IN ('queued', 'assigned', 'paused_by_user')",
        params![task_id, now],
    )
    .map_err(|error| format!("Unable to clear role queue entries for {task_id}: {error}"))?;

    if let Some(active_assignment) = assignment.as_ref() {
        if let Some(worker_id) = active_assignment.worker_id.as_deref() {
            if active_assignment.worker_type == "agent" {
                tx.execute(
                    "UPDATE agent_runtime_states SET status = 'idle', current_queue_entry_id = NULL, last_error = ?4, updated_at = ?3 WHERE project_id = ?1 AND agent_id = ?2",
                    params![task.project_id, worker_id, now, normalized_notes.as_deref()],
                )
                .map_err(|error| format!("Unable to reset agent runtime state for task {task_id}: {error}"))?;
            }
        }

        if let Some(role_instance_id) = active_assignment.role_instance_id.as_deref() {
            tx.execute(
                "UPDATE role_instances SET status = 'idle', current_queue_entry_id = NULL, last_error = ?3, updated_at = ?2 WHERE id = ?1",
                params![role_instance_id, now, normalized_notes.as_deref()],
            )
            .map_err(|error| format!("Unable to reset role instance for task {task_id}: {error}"))?;
        }
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit task stop transaction: {error}"))?;

    tasks::get_task_context(connection, task_id)
}

pub fn reset_task_runtime(
    connection: &mut Connection,
    task_id: &str,
) -> Result<TaskDetail, String> {
    stop_task_activity(connection, task_id, None)
}

fn clear_role_instance_for_reset(
    connection: &Connection,
    instance_id: &str,
    note: Option<String>,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = 'canceled',
                current_queue_entry_id = NULL,
                session_id = NULL,
                last_error = ?2,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![instance_id, note, now],
        )
        .map_err(|error| {
            format!(
                "Unable to cancel role instance {} during reset: {error}",
                instance_id
            )
        })?;
    Ok(())
}

pub fn reset_role_assignments_to_queue(
    connection: &mut Connection,
    role_id: &str,
    reason: &str,
) -> Result<Vec<TaskLaneAssignment>, String> {
    let assignments = list_current_role_assignments(connection, role_id)?;
    let now = now_iso();
    let note = normalize_optional(Some(reason.to_string()));

    for assignment in &assignments {
        let tx = connection.transaction().map_err(|error| {
            format!(
                "Unable to start role reset transaction for {}: {error}",
                assignment.id
            )
        })?;

        tx.execute(
            r#"
            UPDATE task_lane_assignments
            SET status = 'queued',
                session_id = NULL,
                runtime_cwd = NULL,
                role_instance_id = NULL,
                pending_outcome = NULL,
                completion_notes = NULL,
                completed_at = NULL,
                updated_at = ?2
            WHERE id = ?1
            "#,
            params![assignment.id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to queue role assignment {} during reset: {error}",
                assignment.id
            )
        })?;

        tx.execute(
            r#"
            UPDATE tasks
            SET status = 'ready',
                current_lane_id = ?2,
                assignee_type = 'role',
                assignee_id = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![
                assignment.task_id,
                assignment.lane_id,
                assignment.worker_id,
                now
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to reset task {} for role assignment {}: {error}",
                assignment.task_id, assignment.id
            )
        })?;

        if let Some(queue_entry_id) = assignment.role_queue_entry_id.as_deref() {
            let assigned_instance_id = tx
                .query_row(
                    "SELECT assigned_instance_id FROM role_queue_entries WHERE id = ?1",
                    [queue_entry_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to inspect role queue entry {} during reset: {error}",
                        queue_entry_id
                    )
                })?
                .flatten();

            tx.execute(
                r#"
                UPDATE role_queue_entries
                SET status = 'queued',
                    assigned_instance_id = NULL,
                    started_at = NULL,
                    completed_at = NULL,
                    updated_at = ?2
                WHERE id = ?1
                "#,
                params![queue_entry_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to requeue role queue entry {} during reset: {error}",
                    queue_entry_id
                )
            })?;

            if let Some(instance_id) = assigned_instance_id.as_deref() {
                clear_role_instance_for_reset(&tx, instance_id, note.clone(), &now)?;
            }
        }

        if let Some(role_instance_id) = assignment.role_instance_id.as_deref() {
            clear_role_instance_for_reset(&tx, role_instance_id, note.clone(), &now)?;
        }

        if assignment.session_id.is_some() {
            update_open_lane_run(
                &tx,
                &assignment.task_id,
                &assignment.lane_id,
                assignment.session_id.as_deref(),
                "canceled",
                note.clone(),
                &now,
            )?;
        }

        tx.commit().map_err(|error| {
            format!(
                "Unable to commit role reset transaction for {}: {error}",
                assignment.id
            )
        })?;
    }

    Ok(assignments)
}

pub fn find_stale_task_assignment_candidates(
    connection: &Connection,
) -> Result<Vec<StaleTaskAssignmentCandidate>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM task_lane_assignments
            WHERE status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
            ORDER BY updated_at ASC, created_at ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare stale assignment query: {error}"))?;

    let assignment_ids = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query stale assignment candidates: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect stale assignment candidates: {error}"))?;

    let mut candidates = Vec::new();
    for assignment_id in assignment_ids {
        let Some(assignment) = get_assignment_by_id(connection, &assignment_id)? else {
            continue;
        };
        let Some(task) = tasks::get_task_context(connection, &assignment.task_id).ok() else {
            continue;
        };
        if let Some(reason) = stale_assignment_reason(connection, &assignment)? {
            candidates.push(StaleTaskAssignmentCandidate {
                assignment_id: assignment.id.clone(),
                task_id: assignment.task_id.clone(),
                project_id: task.project_id,
                session_id: assignment.session_id.clone(),
                reason,
            });
        }
    }

    Ok(candidates)
}

fn stale_assignment_reason(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
) -> Result<Option<String>, String> {
    let task = tasks::get_task_context(connection, &assignment.task_id)?;
    let blocked_active_assignment =
        task.status == "blocked" && assignment.status == ASSIGNMENT_STATUS_ACTIVE;
    if task.status == "blocked" && !blocked_active_assignment {
        return Ok(Some(
            "task is blocked and should not retain worker runtime".into(),
        ));
    }

    if matches!(
        assignment.status.as_str(),
        ASSIGNMENT_STATUS_QUEUED | ASSIGNMENT_STATUS_ACTIVE
    ) && !blocked_active_assignment
        && !task_lane_queue_source_is_valid(
            connection,
            &assignment.task_id,
            Some(&assignment.workflow_id),
            &assignment.lane_id,
        )?
    {
        return Ok(Some(
            "task is no longer runnable for the queued/active lane claim".into(),
        ));
    }

    if assignment.status == ASSIGNMENT_STATUS_ACTIVE {
        let Some(session_id) = assignment.session_id.as_deref() else {
            return Ok(Some("active assignment is missing a session".into()));
        };
        if pi_sessions::find_session_context_for_session(session_id).is_err() {
            return Ok(Some(format!("assignment session {session_id} is missing")));
        }
    }

    if assignment.worker_type == "agent" {
        if assignment.status == ASSIGNMENT_STATUS_ACTIVE && assignment.worker_id.is_none() {
            return Ok(Some("agent assignment is missing an agent id".into()));
        }
        return Ok(None);
    }

    let Some(queue_entry_id) = assignment.role_queue_entry_id.as_deref() else {
        return Ok(Some("role assignment is missing a queue entry".into()));
    };
    let Some((queue_status, assigned_instance_id)) = connection
        .query_row(
            "SELECT status, assigned_instance_id FROM role_queue_entries WHERE id = ?1",
            [queue_entry_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to query role queue entry {}: {error}",
                queue_entry_id
            )
        })?
    else {
        return Ok(Some(format!(
            "role queue entry {queue_entry_id} is missing"
        )));
    };

    match assignment.status.as_str() {
        ASSIGNMENT_STATUS_ACTIVE => {
            let Some(role_instance_id) = assignment.role_instance_id.as_deref() else {
                return Ok(Some(
                    "active role assignment is missing a role instance".into(),
                ));
            };
            let Some((session_id, current_queue_entry_id)) = connection
                .query_row(
                    "SELECT session_id, current_queue_entry_id FROM role_instances WHERE id = ?1",
                    [role_instance_id],
                    |row| {
                        Ok((
                            row.get::<_, Option<String>>(0)?,
                            row.get::<_, Option<String>>(1)?,
                        ))
                    },
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to query role instance {}: {error}",
                        role_instance_id
                    )
                })?
            else {
                return Ok(Some(format!("role instance {role_instance_id} is missing")));
            };
            if current_queue_entry_id.as_deref() != Some(queue_entry_id) {
                return Ok(Some(format!(
                    "role instance {role_instance_id} no longer owns queue entry {queue_entry_id}"
                )));
            }
            if session_id.as_deref() != assignment.session_id.as_deref() {
                return Ok(Some(format!(
                    "role instance {role_instance_id} session no longer matches assignment {}",
                    assignment.id
                )));
            }
        }
        ASSIGNMENT_STATUS_QUEUED => {
            if queue_status == "assigned" {
                let Some(role_instance_id) = assigned_instance_id.as_deref() else {
                    return Ok(Some(format!(
                        "queued role assignment {} has an assigned queue entry without an instance",
                        assignment.id
                    )));
                };
                let Some(session_id) = connection
                    .query_row(
                        "SELECT session_id FROM role_instances WHERE id = ?1",
                        [role_instance_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!(
                            "Unable to query role instance {}: {error}",
                            role_instance_id
                        )
                    })?
                else {
                    return Ok(Some(format!(
                        "assigned role instance {role_instance_id} is missing"
                    )));
                };
                let Some(session_id) = session_id else {
                    return Ok(Some(format!(
                        "assigned role instance {role_instance_id} is missing a session"
                    )));
                };
                if pi_sessions::find_session_context_for_session(&session_id).is_err() {
                    return Ok(Some(format!(
                        "assigned role instance session {session_id} is missing"
                    )));
                }
            }
        }
        _ => {}
    }

    Ok(None)
}

pub fn activate_queued_role_assignments(
    connection: &Connection,
) -> Result<Vec<TaskLaneAssignment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                tla.id,
                tla.task_id,
                tla.workflow_id,
                tla.lane_id,
                tla.worker_type,
                tla.worker_id,
                tla.status,
                tla.session_id,
                tla.runtime_cwd,
                tla.role_queue_entry_id,
                tla.role_instance_id,
                tla.prompt,
                tla.pending_outcome,
                tla.completion_notes,
                tla.whip_count,
                tla.last_whip_at,
                tla.started_at,
                tla.completed_at,
                tla.created_at,
                tla.updated_at,
                rqe.assigned_instance_id,
                ri.session_id,
                ri.worktree_path
            FROM task_lane_assignments tla
            JOIN role_queue_entries rqe ON rqe.id = tla.role_queue_entry_id
            LEFT JOIN role_instances ri ON ri.id = rqe.assigned_instance_id
            WHERE tla.worker_type = 'role'
              AND tla.status = 'queued'
              AND rqe.status = 'assigned'
              AND rqe.assigned_instance_id IS NOT NULL
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare queued role assignment activation query: {error}")
        })?;

    let candidates = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(21)?,
                row.get::<_, String>(22)?,
                row.get::<_, String>(20)?,
            ))
        })
        .map_err(|error| {
            format!("Unable to query queued role assignment activation candidates: {error}")
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!("Unable to collect role assignment activation candidates: {error}")
        })?;

    let mut activated = Vec::new();
    for (assignment_id, session_id, runtime_cwd, instance_id) in candidates {
        let now = now_iso();
        connection
            .execute(
                "UPDATE task_lane_assignments SET status = 'active', session_id = ?2, runtime_cwd = ?3, role_instance_id = ?4, updated_at = ?5 WHERE id = ?1 AND status = 'queued'",
                params![assignment_id, session_id, runtime_cwd, instance_id, now],
            )
            .map_err(|error| format!("Unable to activate queued role assignment {assignment_id}: {error}"))?;
        if let Some(assignment) = connection
            .query_row(
                r#"
                SELECT
                    id,
                    task_id,
                    workflow_id,
                    lane_id,
                    worker_type,
                    worker_id,
                    status,
                    session_id,
                    runtime_cwd,
                    role_queue_entry_id,
                    role_instance_id,
                    prompt,
                    pending_outcome,
                    completion_notes,
                    whip_count,
                    last_whip_at,
                    started_at,
                    completed_at,
                    created_at,
                    updated_at
                FROM task_lane_assignments
                WHERE id = ?1
                "#,
                [assignment_id.as_str()],
                read_assignment,
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to reload activated role assignment {}: {error}",
                    assignment_id
                )
            })?
        {
            activated.push(assignment);
        }
    }

    Ok(activated)
}

pub fn dispatch_task_lane(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
) -> Result<TaskLaneAssignment, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    let workflow = load_task_workflow(connection, &task)?;
    let lane = resolve_task_lane(&workflow, &task)?;
    let runtime_project_root = resolve_task_runtime_project_root(connection, project_root, &task)?;

    if task.archived {
        return Err(format!(
            "Task {task_id} is archived and cannot be dispatched"
        ));
    }

    if task.status == "blocked" {
        return Err(format!(
            "Task {task_id} is blocked and cannot be dispatched until it becomes runnable"
        ));
    }

    if task.dependency_blocked {
        return Err(format!(
            "Task {task_id} is blocked by unresolved dependencies or unfinished subtasks"
        ));
    }

    if lane.assigned_entity_type == "user" {
        return Err(format!(
            "Task {} is currently in user-owned lane {} and cannot be dispatched to runtime",
            task.id, lane.name
        ));
    }

    if let Some(existing) = find_open_assignment_for_task_lane(connection, task_id, &lane.id)? {
        cancel_duplicate_open_assignments_for_task_lane(
            connection,
            task_id,
            &lane.id,
            &existing.id,
            "Removed duplicate open task lane assignment",
        )?;
        return Ok(existing);
    }

    let assignment_id = format!("task-assignment-{}", Uuid::new_v4().simple());
    let now = now_iso();

    let assignment = match lane.assigned_entity_type.as_str() {
        "role" => dispatch_role_lane(
            connection,
            &runtime_project_root,
            session_dir,
            &task,
            &workflow,
            &lane,
            &assignment_id,
            &now,
        )?,
        "agent" => dispatch_agent_lane(
            connection,
            &runtime_project_root,
            session_dir,
            &task,
            &workflow,
            &lane,
            &assignment_id,
            &now,
        )?,
        other => {
            return Err(format!("Unsupported lane worker type: {other}"));
        }
    };

    sync_task_lane_owner(connection, &task, &lane, "in_progress")?;
    Ok(assignment)
}

pub fn maybe_auto_dispatch_task(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    let workflow = match load_task_workflow(connection, &task) {
        Ok(workflow) => workflow,
        Err(_) => return Ok(None),
    };
    let lane = resolve_task_lane(&workflow, &task)?;
    if !task_is_runnable_for_worker_runtime(connection, &task, Some(&workflow.id), &lane.id)? {
        return Ok(None);
    }

    dispatch_task_lane(connection, project_root, session_dir, task_id).map(Some)
}

#[derive(Debug, Clone)]
pub struct AutoDispatchOutcome {
    pub task_id: String,
    pub session_dir: PathBuf,
    pub assignment: TaskLaneAssignment,
}

pub fn collect_post_completion_auto_dispatches(
    connection: &mut Connection,
    task_id: &str,
) -> Result<Vec<AutoDispatchOutcome>, String> {
    let mut outcomes = Vec::new();

    let current_context = session_context_for_task_id(task_id)?;
    if let Some(assignment) = maybe_auto_dispatch_task(
        connection,
        &current_context.project_root,
        &current_context.session_dir,
        task_id,
    )? {
        outcomes.push(AutoDispatchOutcome {
            task_id: task_id.to_string(),
            session_dir: current_context.session_dir,
            assignment,
        });
    }

    for dependent_task_id in auto_dispatchable_unblocked_dependents(connection, task_id)? {
        let context = pi_sessions::session_context_for_project_id(
            &tasks::get_task_context(connection, &dependent_task_id)?.project_id,
        )?;
        if let Some(assignment) = maybe_auto_dispatch_task(
            connection,
            &context.project_root,
            &context.session_dir,
            &dependent_task_id,
        )? {
            outcomes.push(AutoDispatchOutcome {
                task_id: dependent_task_id,
                session_dir: context.session_dir,
                assignment,
            });
        }
    }

    for parent_task_id in auto_dispatchable_unblocked_parents(connection, task_id)? {
        let context = pi_sessions::session_context_for_project_id(
            &tasks::get_task_context(connection, &parent_task_id)?.project_id,
        )?;
        if let Some(assignment) = maybe_auto_dispatch_task(
            connection,
            &context.project_root,
            &context.session_dir,
            &parent_task_id,
        )? {
            outcomes.push(AutoDispatchOutcome {
                task_id: parent_task_id,
                session_dir: context.session_dir,
                assignment,
            });
        }
    }

    Ok(outcomes)
}

fn auto_dispatchable_unblocked_dependents(
    connection: &Connection,
    blocker_task_id: &str,
) -> Result<Vec<String>, String> {
    let dependent_task_ids = connection
        .prepare(
            r#"
            SELECT blocked_task_id
            FROM task_dependencies
            WHERE blocker_task_id = ?1
            ORDER BY blocked_task_id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare dependent task query: {error}"))?
        .query_map([blocker_task_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query dependent tasks for {blocker_task_id}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!("Unable to read dependent tasks for {blocker_task_id}: {error}")
        })?;

    let mut ready = Vec::new();
    for dependent_task_id in dependent_task_ids {
        let task = tasks::get_task_context(connection, &dependent_task_id)?;
        if task.archived || task.dependency_blocked || !task.ready_for_dispatch {
            continue;
        }

        let project = projects::get_project(connection, &task.project_id)?;
        let automation = task_automation_settings_for_project(connection, &project.slug)?;
        if !automation.auto_dispatch_on_blocker_completion {
            continue;
        }

        ready.push(dependent_task_id);
    }

    Ok(ready)
}

fn auto_dispatchable_unblocked_parents(
    connection: &Connection,
    child_task_id: &str,
) -> Result<Vec<String>, String> {
    let mut ready = Vec::new();
    let mut current_parent_id = tasks::get_task_context(connection, child_task_id)?.parent_task_id;

    while let Some(parent_task_id) = current_parent_id {
        let task = tasks::get_task_context(connection, &parent_task_id)?;
        current_parent_id = task.parent_task_id.clone();

        if task.archived || task.dependency_blocked || !task.ready_for_dispatch {
            continue;
        }

        let project = projects::get_project(connection, &task.project_id)?;
        let automation = task_automation_settings_for_project(connection, &project.slug)?;
        if !automation.auto_dispatch_on_blocker_completion {
            continue;
        }

        ready.push(parent_task_id);
    }

    Ok(ready)
}

fn task_automation_settings_for_project(
    connection: &Connection,
    project_slug: &str,
) -> Result<crate::models::ProjectTaskAutomationSettings, String> {
    let orchestra_root = crate::services::orchestra_paths::default_orchestra_root().ok();
    project_settings::get_task_automation_settings_with_connection(
        connection,
        orchestra_root.as_deref(),
        project_slug,
    )
}

fn read_task_whip_candidate(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskWhipCandidate> {
    Ok(TaskWhipCandidate {
        assignment_id: row.get(0)?,
        task_id: row.get(1)?,
        project_id: row.get(2)?,
        workflow_id: row.get(3)?,
        lane_id: row.get(4)?,
        worker_type: row.get(5)?,
        worker_id: row.get(6)?,
        role_instance_id: row.get(7)?,
        session_id: row.get(8)?,
        runtime_cwd: row.get(9)?,
        task_number: row.get(10)?,
        task_title: row.get(11)?,
        whip_count: row.get(12)?,
        whip_max_attempts: {
            let configured = row.get::<_, i64>(13)?;
            if configured < 1 {
                DEFAULT_TASK_WHIP_MAX_ATTEMPTS
            } else {
                configured
            }
        },
    })
}

fn load_task_whip_candidates(
    connection: &Connection,
    assignment_id: Option<&str>,
) -> Result<Vec<TaskWhipCandidate>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                tla.id,
                tla.task_id,
                t.project_id,
                tla.workflow_id,
                tla.lane_id,
                tla.worker_type,
                tla.worker_id,
                tla.role_instance_id,
                tla.session_id,
                tla.runtime_cwd,
                t.number,
                t.title,
                tla.whip_count,
                t.whip_max_attempts
            FROM task_lane_assignments tla
            JOIN tasks t ON t.id = tla.task_id
            LEFT JOIN agent_runtime_states ars ON ars.project_id = t.project_id AND ars.agent_id = tla.worker_id
            LEFT JOIN role_instances ri ON ri.id = tla.role_instance_id
            WHERE tla.status = 'active'
              AND tla.worker_type IN ('agent', 'role')
              AND tla.worker_id IS NOT NULL
              AND tla.session_id IS NOT NULL
              AND t.archived = 0
              AND t.status IN ('ready', 'in_progress')
              AND (?1 IS NULL OR tla.id = ?1)
              AND (
                (
                  tla.worker_type = 'agent'
                  AND ars.status = 'idle'
                  AND ars.current_queue_entry_id IS NULL
                  AND NOT EXISTS (
                      SELECT 1
                      FROM agent_queue_entries aqe
                      WHERE aqe.project_id = t.project_id
                        AND aqe.agent_id = tla.worker_id
                        AND aqe.status IN ('queued', 'dispatched')
                        AND aqe.source_type = 'task_whip'
                        AND aqe.source_task_id = tla.task_id
                        AND aqe.source_workflow_id = tla.workflow_id
                        AND aqe.source_lane_id = tla.lane_id
                  )
                )
                OR
                (
                  tla.worker_type = 'role'
                  AND tla.role_instance_id IS NOT NULL
                  AND tla.runtime_cwd IS NOT NULL
                  AND ri.status IN ('running', 'idle')
                )
              )
            ORDER BY tla.updated_at ASC, tla.created_at ASC, tla.id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task whip candidate query: {error}"))?;

    let rows = statement
        .query_map([assignment_id], read_task_whip_candidate)
        .map_err(|error| format!("Unable to query task whip candidates: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task whip candidates: {error}"))
}

pub fn find_task_whip_candidates(
    connection: &Connection,
) -> Result<Vec<TaskWhipCandidate>, String> {
    load_task_whip_candidates(connection, None)
}

pub fn refresh_task_whip_candidate(
    connection: &Connection,
    assignment_id: &str,
) -> Result<Option<TaskWhipCandidate>, String> {
    Ok(load_task_whip_candidates(connection, Some(assignment_id))?
        .into_iter()
        .next())
}

pub fn build_task_whip_message(task_id: &str) -> String {
    format!("{}\n\nCanonical task ID: {}", TASK_WHIP_PROMPT, task_id)
}

pub fn record_task_whip_sent(
    connection: &Connection,
    assignment_id: &str,
    current_whip_count: i64,
) -> Result<(), String> {
    let next_whip_count = current_whip_count + 1;
    let now = now_iso();
    connection
        .execute(
            "UPDATE task_lane_assignments SET whip_count = ?2, last_whip_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![assignment_id, next_whip_count, now],
        )
        .map_err(|error| format!("Unable to update whip state for assignment {}: {error}", assignment_id))?;
    Ok(())
}

pub fn send_task_whip(
    connection: &Connection,
    candidate: &TaskWhipCandidate,
) -> Result<crate::models::AgentQueueEntry, String> {
    let message = build_task_whip_message(&candidate.task_id);

    let queue_entry = agent_runtime::enqueue_agent_work_for_project(
        connection,
        &candidate.project_id,
        crate::models::AgentQueueEntryInput {
            agent_id: candidate.worker_id.clone(),
            source_type: "task_whip".into(),
            source_task_id: Some(candidate.task_id.clone()),
            source_workflow_id: Some(candidate.workflow_id.clone()),
            source_lane_id: Some(candidate.lane_id.clone()),
            delivery_mode: "prompt".into(),
            title: format!(
                "{} · {} · keep working",
                candidate.task_number, candidate.task_title
            ),
            message,
        },
    )?;

    record_task_whip_sent(connection, &candidate.assignment_id, candidate.whip_count)?;

    Ok(queue_entry)
}

pub fn escalate_task_whip_limit_exceeded(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    candidate: &TaskWhipCandidate,
) -> Result<TaskDetail, String> {
    let note = format!(
        "Automatic user intervention requested after {} whip attempts without lane completion.",
        candidate.whip_count
    );
    let comment = tasks::add_task_comment(
        connection,
        &candidate.task_id,
        crate::models::TaskCommentInput {
            author: "Orchestra".into(),
            origin_type: Some("system".into()),
            origin_id: None,
            message: note.clone(),
            interrupt_agent: false,
            parent_comment_id: None,
            repository_id: None,
            relative_path: None,
            absolute_path: None,
            line_start: None,
            line_end: None,
            column_start: None,
            column_end: None,
            selected_text: None,
        },
    )?;
    if let Some(assignment) = get_active_lane_assignment(connection, &candidate.task_id)? {
        let comment_ids = vec![comment.id.clone()];
        let _ = tasks::mark_task_comments_read(
            connection,
            &candidate.task_id,
            &assignment,
            Some(&comment_ids),
        )?;
    }

    request_user_intervention(
        connection,
        project_root,
        session_dir,
        &candidate.task_id,
        Some(note),
        None,
    )
}

fn resolve_task_runtime_project_root(
    connection: &Connection,
    fallback_project_root: &Path,
    task: &TaskDetail,
) -> Result<PathBuf, String> {
    if let Some(repository_id) = task.repository_id.as_deref() {
        let repository = projects::get_repository(connection, repository_id)?;
        return repository_runtime_root(&repository).ok_or_else(|| {
            format!(
                "Task {} references repository {} but it does not have a managed repository path",
                task.id, repository_id
            )
        });
    }

    for reference in &task.file_references {
        let repository = projects::get_repository(connection, &reference.repository_id)?;
        if let Some(runtime_root) = repository_runtime_root(&repository) {
            return Ok(runtime_root);
        }
    }

    Ok(fallback_project_root.to_path_buf())
}

fn repository_runtime_root(repository: &RepositoryRecord) -> Option<PathBuf> {
    repository.repository_path.as_ref().map(PathBuf::from)
}

struct WorkerPromptContext {
    worker_type: &'static str,
    worker_type_label: &'static str,
    worker_name: String,
    worker_slug: String,
    system_prompt: Option<String>,
    project_overlay_prompt: Option<String>,
}

#[derive(Debug, Clone)]
pub struct TaskWhipCandidate {
    pub assignment_id: String,
    pub task_id: String,
    pub project_id: String,
    pub workflow_id: String,
    pub lane_id: String,
    pub worker_type: String,
    pub worker_id: String,
    pub role_instance_id: Option<String>,
    pub session_id: String,
    pub runtime_cwd: Option<String>,
    pub task_number: String,
    pub task_title: String,
    pub whip_count: i64,
    pub whip_max_attempts: i64,
}

fn load_worker_overlay_prompt(
    connection: &Connection,
    task: &TaskDetail,
    worker_type: &str,
    worker_slug: &str,
) -> Result<Option<String>, String> {
    let project = projects::get_project(connection, &task.project_id)?;
    Ok(project_settings::get_worker_overlay(&project.slug, worker_type, worker_slug)?.prompt)
}

pub fn lane_uses_separate_worktree(lane: &WorkflowLane) -> bool {
    matches!(lane.assigned_entity_type.as_str(), "agent" | "role") && lane.use_separate_worktree
}

fn resolve_lane_workspace_cwd(
    connection: &Connection,
    project_root: &Path,
    task: &TaskDetail,
    lane: &WorkflowLane,
    runtime_cwd: Option<&str>,
) -> Result<String, String> {
    if lane_uses_separate_worktree(lane) {
        let runtime_cwd = runtime_cwd.ok_or_else(|| {
            format!(
                "Lane {} requires a separate worktree but no runtime cwd was available",
                lane.name
            )
        })?;
        return Ok(task_repositories::task_workspace_root(
            runtime_cwd,
            &task.id,
        ));
    }

    let shared_root = pi_sessions::session_context_for_project_id(&task.project_id)
        .map(|context| task_repositories::shared_task_workspaces_root(&context.project_root))
        .unwrap_or_else(|_| task_repositories::shared_task_workspaces_root(project_root));
    Ok(task_repositories::task_workspace_root(
        &shared_root,
        &task.id,
    ))
}

pub fn resolve_assignment_workspace_cwd(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    task_id: &str,
    project_id: &str,
) -> Result<Option<String>, String> {
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(None);
    };

    if assignment.worker_type != "agent" {
        return Ok(Some(runtime_cwd.to_string()));
    }

    let workflow = workflows::get_workflow(connection, &assignment.workflow_id)?;
    let lane = workflow
        .lanes
        .into_iter()
        .find(|entry| entry.id == assignment.lane_id)
        .ok_or_else(|| {
            format!(
                "Unable to resolve workflow lane {} for assignment {}",
                assignment.lane_id, assignment.id
            )
        })?;

    if lane_uses_separate_worktree(&lane) {
        return Ok(Some(task_repositories::task_workspace_root(
            runtime_cwd,
            task_id,
        )));
    }

    let shared_workspace_root = pi_sessions::session_context_for_project_id(project_id)
        .map(|context| task_repositories::shared_task_workspaces_root(&context.project_root))
        .unwrap_or_else(|_| runtime_cwd.to_string());
    Ok(Some(task_repositories::task_workspace_root(
        &shared_workspace_root,
        task_id,
    )))
}

pub fn ensure_task_repository_workspaces(
    task: &TaskDetail,
    task_workspace_root: &str,
) -> Result<(), String> {
    if task.task_repositories.is_empty() {
        return Ok(());
    }

    std::fs::create_dir_all(task_repositories::task_repositories_root(
        task_workspace_root,
    ))
    .map_err(|error| {
        format!(
            "Unable to create task repository workspace root for task {}: {error}",
            task.id
        )
    })?;

    for repository in &task.task_repositories {
        ensure_task_repository_worktree(task, task_workspace_root, repository)?;
    }

    Ok(())
}

fn ensure_task_repository_worktree(
    _task: &TaskDetail,
    task_workspace_root: &str,
    repository: &TaskRepository,
) -> Result<(), String> {
    let Some(managed_repository_path) = repository.managed_repository_path.as_deref() else {
        return Ok(());
    };

    let destination = task_repositories::task_repository_worktree_path(
        task_workspace_root,
        &repository.repository_slug,
    );
    let destination_path = PathBuf::from(&destination);
    if destination_path.exists() {
        return Ok(());
    }

    if let Some(parent) = destination_path.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create task repository worktree parent {}: {error}",
                parent.display()
            )
        })?;
    }

    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(managed_repository_path)
        .arg("worktree")
        .arg("add")
        .arg("--detach")
        .arg(&destination_path)
        .arg("HEAD")
        .status()
        .map_err(|error| {
            format!(
                "Unable to create task worktree for repository {}: {error}",
                repository.repository_slug
            )
        })?;

    if !status.success() {
        return Err(format!(
            "Unable to create task worktree for repository {} at {}",
            repository.repository_slug,
            destination_path.display()
        ));
    }

    Ok(())
}

pub fn start_assignment_run(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
) -> Result<(), String> {
    if assignment.status != ASSIGNMENT_STATUS_ACTIVE {
        return Ok(());
    }

    let Some(prompt) = assignment.prompt.as_deref() else {
        return Ok(());
    };

    start_assignment_prompt(app, state, session_dir, assignment, prompt)
}

pub fn start_assignment_follow_up(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    prompt: &str,
) -> Result<(), String> {
    if assignment.status != ASSIGNMENT_STATUS_ACTIVE {
        return Err(format!(
            "Task lane assignment {} is not active and cannot accept follow-up work",
            assignment.id
        ));
    }

    start_assignment_delivery(app, state, session_dir, assignment, "follow_up", prompt)
}

fn ensure_assignment_runtime(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
) -> Result<Option<(String, std::sync::Arc<live_sessions::SessionRuntime>)>, String> {
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(None);
    };

    std::fs::create_dir_all(runtime_cwd).map_err(|error| {
        format!(
            "Unable to recreate missing assignment runtime cwd {}: {error}",
            runtime_cwd
        )
    })?;

    let mut session_id = assignment.session_id.clone();
    if session_id
        .as_deref()
        .is_none_or(|value| pi_sessions::find_session_context_for_session(value).is_err())
    {
        let connection = crate::services::database::open_connection()?;
        session_id = Some(recover_missing_assignment_session(
            &connection,
            assignment,
            runtime_cwd,
        )?);
    }

    let Some(session_id) = session_id else {
        return Ok(None);
    };

    let actual_session_dir = pi_sessions::find_session_context_for_session(&session_id)
        .map(|context| context.session_dir)
        .unwrap_or(session_dir);

    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        actual_session_dir,
        &session_id,
    )?;

    Ok(Some((session_id, runtime)))
}

fn recover_missing_assignment_session(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    runtime_cwd: &str,
) -> Result<String, String> {
    let task = tasks::get_task_context(connection, &assignment.task_id)?;
    let context = pi_sessions::session_context_for_project_id(&task.project_id)?;
    let now = now_iso();

    match assignment.worker_type.as_str() {
        "agent" => {
            let agent_id = assignment
                .worker_id
                .as_deref()
                .ok_or_else(|| format!("Assignment {} is missing an agent id", assignment.id))?;
            let agent = agents::get_agent(&connection, agent_id)?;
            let runtime_state = agent_dispatch::ensure_main_session(
                &context.project_root,
                &context.session_dir,
                &task.project_id,
                agent_id,
            )?;
            let session_id = runtime_state
                .main_session_id
                .ok_or_else(|| format!("Agent {} has no main session", agent.name))?;
            connection
                .execute(
                    "UPDATE task_lane_assignments SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![assignment.id, session_id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to refresh missing agent assignment session {}: {error}",
                        assignment.id
                    )
                })?;
            Ok(session_id)
        }
        "role" => {
            let role_instance_id = assignment.role_instance_id.as_deref().ok_or_else(|| {
                format!("Assignment {} is missing a role instance id", assignment.id)
            })?;
            let role_instance = role_runtime::get_role_instance(&connection, role_instance_id)?;
            let role = roles::get_role(&connection, &role_instance.role_id)?;
            std::fs::create_dir_all(runtime_cwd).map_err(|error| {
                format!(
                    "Unable to recreate missing role runtime cwd {}: {error}",
                    runtime_cwd
                )
            })?;
            let created = pi_sessions::create_session_file(
                std::path::Path::new(runtime_cwd),
                &context.session_dir,
                Some(&format!("{} · {}", role.name, task.title)),
                false,
            )?;
            if let (Some(provider), Some(model)) = (role.provider.as_deref(), role.model.as_deref())
            {
                let _ = pi_sessions::set_session_model(
                    std::path::Path::new(runtime_cwd),
                    &context.session_dir,
                    &created.record.id,
                    provider,
                    model,
                )?;
            }
            let _ = pi_sessions::set_session_thinking_level(
                std::path::Path::new(runtime_cwd),
                &context.session_dir,
                &created.record.id,
                &role.thinking_level,
            )?;
            connection
                .execute(
                    "UPDATE role_instances SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![role_instance.id, created.record.id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to refresh role instance session {}: {error}",
                        role_instance.id
                    )
                })?;
            connection
                .execute(
                    "UPDATE task_lane_assignments SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![assignment.id, created.record.id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to refresh missing role assignment session {}: {error}",
                        assignment.id
                    )
                })?;
            Ok(created.record.id)
        }
        other => Err(format!(
            "Unsupported assignment worker type {other} for session recovery"
        )),
    }
}

fn start_assignment_prompt(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    prompt: &str,
) -> Result<(), String> {
    let Some((session_id, runtime)) =
        ensure_assignment_runtime(app, state, session_dir, assignment)?
    else {
        return Ok(());
    };

    let run_id = generate_id("task-run");
    state.begin_session_run(&session_id, &run_id)?;
    match runtime.start_run(&run_id, prompt) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.end_session_run(&session_id, &run_id);
            Err(error)
        }
    }
}

fn start_assignment_delivery(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    delivery_type: &str,
    message: &str,
) -> Result<(), String> {
    let Some((_session_id, runtime)) =
        ensure_assignment_runtime(app, state, session_dir, assignment)?
    else {
        return Ok(());
    };

    let run_id = generate_id("task-delivery");
    runtime.start_delivery(&run_id, delivery_type, message)
}

fn build_unread_comment_delivery_message(task_id: &str, comment: &TaskComment) -> String {
    format!(
        "New task comment from {} on task {}. Call get_unread_task_comments for this task now, read and incorporate any unread comments, then call mark_task_comments_read for the same task before you continue or complete the lane.",
        comment.author, task_id
    )
}

pub(crate) enum TaskCommentNotificationTarget {
    ActiveWorker(TaskLaneAssignment),
    QueuedWorker(TaskLaneAssignment),
    UserMailbox,
}

/// Route task comments to the current attention owner for the lane.
///
/// Active and queued worker-owned lanes notify the worker, while review/user-paused
/// states and user-owned lanes notify the user mailbox instead. This avoids waking a
/// paused worker when the task is explicitly waiting on the user.
pub(crate) fn resolve_task_comment_notification_target(
    connection: &Connection,
    task: &TaskDetail,
    comment: &TaskComment,
) -> Result<Option<TaskCommentNotificationTarget>, String> {
    let current_assignment = get_current_lane_assignment(connection, &task.id)?;
    Ok(match current_assignment {
        Some(assignment) => match assignment.status.as_str() {
            ASSIGNMENT_STATUS_ACTIVE if assignment.worker_type != "user" => {
                Some(TaskCommentNotificationTarget::ActiveWorker(assignment))
            }
            ASSIGNMENT_STATUS_QUEUED if assignment.worker_type != "user" => {
                Some(TaskCommentNotificationTarget::QueuedWorker(assignment))
            }
            ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
            | ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION
            | ASSIGNMENT_STATUS_PAUSED_BY_USER => {
                if comment.origin_type == "user" {
                    None
                } else {
                    Some(TaskCommentNotificationTarget::UserMailbox)
                }
            }
            _ if assignment.worker_type == "user" => {
                if comment.origin_type == "user" {
                    None
                } else {
                    Some(TaskCommentNotificationTarget::UserMailbox)
                }
            }
            _ => None,
        },
        None if task.assignee_type == "user" => {
            if comment.origin_type == "user" {
                None
            } else {
                Some(TaskCommentNotificationTarget::UserMailbox)
            }
        }
        None => None,
    })
}

pub(crate) fn dispatch_task_comment_notification_target(
    app: Option<&AppHandle>,
    state: Option<&AppState>,
    connection: &Connection,
    task: &TaskDetail,
    comment: &TaskComment,
    target: &TaskCommentNotificationTarget,
) -> Option<String> {
    match target {
        TaskCommentNotificationTarget::ActiveWorker(assignment) => {
            let warning = match (app, state) {
                (Some(app), Some(state)) => {
                    match pi_sessions::session_context_for_project_id(&task.project_id) {
                        Ok(context) => notify_or_queue_unread_comment_delivery(
                            connection,
                            assignment,
                            comment,
                            || {
                                notify_active_assignment_of_unread_comments(
                                    app.clone(),
                                    state,
                                    context.session_dir.clone(),
                                    assignment,
                                    comment,
                                )
                            },
                        ),
                        Err(error) => match queue_comment_delivery(connection, assignment, comment) {
                            Ok(()) => Some(format!(
                                "Live comment delivery context was unavailable and Orchestra queued a fallback delivery instead: {error}"
                            )),
                            Err(queue_error) => Some(format!(
                                "Live comment delivery context was unavailable after the comment was already saved: {error}. Fallback queueing also failed: {queue_error}"
                            )),
                        },
                    }
                }
                _ => match queue_comment_delivery(connection, assignment, comment) {
                    Ok(()) => Some(
                        "No app handle was available for live comment delivery, so Orchestra queued a fallback delivery instead."
                            .into(),
                    ),
                    Err(error) => Some(format!(
                        "No app handle was available for live comment delivery, and fallback queueing also failed: {error}"
                    )),
                },
            };
            if let (Some(app), Some(session_id)) = (app, assignment.session_id.as_ref()) {
                let _ = crate::services::app_events::emit_session_change(
                    app,
                    "task.comment.unread",
                    [session_id.clone()],
                );
            }
            warning
        }
        TaskCommentNotificationTarget::QueuedWorker(assignment) => {
            queue_comment_delivery(connection, assignment, comment)
                .err()
                .map(|error| {
                    format!(
                        "Queued comment delivery failed after the comment was already saved: {error}"
                    )
                })
        }
        TaskCommentNotificationTarget::UserMailbox => {
            match messages::create_user_mailbox_message_for_task_comment(connection, task, comment)
            {
                Ok(message) => {
                    if let Some(app) = app {
                        let _ = crate::services::app_events::emit_inbox_change(
                            app,
                            "mailbox.sent",
                            [message.delivery_id.clone()],
                        );
                        if let Some(task_id) = message.task_id.clone() {
                            let _ = crate::services::app_events::emit_task_change(
                                app,
                                "mailbox.sent",
                                [task_id],
                            );
                        }
                        let _ = crate::services::notifications::publish_mailbox_notification(
                            Some(app),
                            connection,
                            &message,
                        );
                    }
                    None
                }
                Err(error) => Some(format!(
                    "User mailbox comment delivery failed after the comment was already saved: {error}"
                )),
            }
        }
    }
}

pub fn queue_comment_delivery(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    comment: &TaskComment,
) -> Result<(), String> {
    let message = build_unread_comment_delivery_message(&assignment.task_id, comment);

    match assignment.worker_type.as_str() {
        "agent" => {
            let Some(agent_id) = assignment.worker_id.as_deref() else {
                return Err("Agent assignment is missing an agent id".into());
            };
            let project_id = connection
                .query_row(
                    "SELECT project_id FROM tasks WHERE id = ?1",
                    [assignment.task_id.as_str()],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to resolve task project {}: {error}",
                        assignment.task_id
                    )
                })?
                .unwrap_or_else(|| "orchestra".to_string());
            let _ = agent_runtime::enqueue_agent_work_for_project(
                connection,
                &project_id,
                crate::models::AgentQueueEntryInput {
                    agent_id: agent_id.to_string(),
                    source_type: "task_comment".into(),
                    source_task_id: Some(assignment.task_id.clone()),
                    source_workflow_id: Some(assignment.workflow_id.clone()),
                    source_lane_id: Some(assignment.lane_id.clone()),
                    delivery_mode: if comment.interrupt_agent {
                        "steer".into()
                    } else {
                        "follow_up".into()
                    },
                    title: format!("Comment for task {}", assignment.task_id),
                    message,
                },
            )?;
            Ok(())
        }
        "role" => {
            let Some(role_id) = assignment.worker_id.as_deref() else {
                return Err("Role assignment is missing a role id".into());
            };
            let _ = role_runtime::enqueue_role_work(
                &mut crate::services::database::open_connection()?,
                crate::models::RoleQueueEntryInput {
                    role_id: role_id.to_string(),
                    source_type: "task_comment".into(),
                    source_task_id: Some(assignment.task_id.clone()),
                    source_workflow_id: Some(assignment.workflow_id.clone()),
                    source_lane_id: Some(assignment.lane_id.clone()),
                    title: format!("Comment for task {}", assignment.task_id),
                    summary: Some(comment.author.clone()),
                    entry_prompt: Some(message),
                },
            )?;
            Ok(())
        }
        _ => Ok(()),
    }
}

pub fn notify_or_queue_unread_comment_delivery<F>(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    comment: &TaskComment,
    notify: F,
) -> Option<String>
where
    F: FnOnce() -> Result<(), String>,
{
    match notify() {
        Ok(()) => None,
        Err(notify_error) => match queue_comment_delivery(connection, assignment, comment) {
            Ok(()) => Some(format!(
                "Live comment delivery failed and Orchestra queued a fallback delivery instead: {notify_error}"
            )),
            Err(queue_error) => Some(format!(
                "Live comment delivery failed after the comment was already saved: {notify_error}. Fallback queueing also failed: {queue_error}"
            )),
        },
    }
}

fn notify_active_assignment_delivery(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    run_prefix: &str,
    message: &str,
    interrupt: bool,
) -> Result<(), String> {
    if assignment.status != ASSIGNMENT_STATUS_ACTIVE {
        return Ok(());
    }

    let Some(session_id) = assignment.session_id.as_deref() else {
        return Ok(());
    };
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(());
    };

    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        session_dir,
        session_id,
    )?;

    let run_id = generate_id(run_prefix);
    state.begin_session_run(session_id, &run_id)?;
    match runtime.start_delivery(
        &run_id,
        if interrupt { "steer" } else { "follow_up" },
        message,
    ) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.end_session_run(session_id, &run_id);
            Err(error)
        }
    }
}

pub fn notify_active_assignment_of_unread_comments(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    comment: &TaskComment,
) -> Result<(), String> {
    let message = build_unread_comment_delivery_message(&assignment.task_id, comment);
    notify_active_assignment_delivery(
        app,
        state,
        session_dir,
        assignment,
        "task-comment",
        &message,
        comment.interrupt_agent,
    )
}

pub fn notify_active_assignment_of_unread_mail(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    message: &str,
    interrupt: bool,
) -> Result<(), String> {
    notify_active_assignment_delivery(
        app,
        state,
        session_dir,
        assignment,
        "task-mail",
        message,
        interrupt,
    )
}

pub fn complete_lane_as_success(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    notes: Option<String>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    complete_lane_as_success_with_app(
        connection,
        project_root,
        session_dir,
        task_id,
        notes,
        None,
        authorization,
    )
}

pub fn complete_lane_as_success_with_app(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    notes: Option<String>,
    app: Option<&AppHandle>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    complete_lane(
        connection,
        project_root,
        session_dir,
        task_id,
        "success",
        notes,
        app,
        authorization,
    )
}

pub fn complete_lane_as_failure(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    notes: Option<String>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    complete_lane_as_failure_with_app(
        connection,
        project_root,
        session_dir,
        task_id,
        notes,
        None,
        authorization,
    )
}

pub fn complete_lane_as_failure_with_app(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    notes: Option<String>,
    app: Option<&AppHandle>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    complete_lane(
        connection,
        project_root,
        session_dir,
        task_id,
        "failure",
        notes,
        app,
        authorization,
    )
}

pub fn request_user_intervention(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    notes: Option<String>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    request_user_intervention_with_app(
        connection,
        project_root,
        session_dir,
        task_id,
        notes,
        None,
        authorization,
    )
}

pub fn request_user_intervention_with_app(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    notes: Option<String>,
    app: Option<&AppHandle>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    complete_lane(
        connection,
        project_root,
        session_dir,
        task_id,
        "needs_user",
        notes,
        app,
        authorization,
    )
}

fn dispatch_role_lane(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task: &TaskDetail,
    workflow: &WorkflowDefinition,
    lane: &WorkflowLane,
    assignment_id: &str,
    now: &str,
) -> Result<TaskLaneAssignment, String> {
    let role_slug = lane
        .assigned_entity_id
        .as_deref()
        .ok_or_else(|| format!("Lane {} is missing a role reference", lane.name))?;
    let role = get_role_by_slug(connection, role_slug)?;
    let worker_prompt = WorkerPromptContext {
        worker_type: "role",
        worker_type_label: "role",
        worker_name: role.name.clone(),
        worker_slug: role.slug.clone(),
        system_prompt: normalize_optional(role.system_prompt.clone()),
        project_overlay_prompt: load_worker_overlay_prompt(connection, task, "role", &role.slug)?,
    };
    let queued_workspace_cwd = if lane_uses_separate_worktree(lane) {
        None
    } else {
        Some(resolve_lane_workspace_cwd(
            connection,
            project_root,
            task,
            lane,
            None,
        )?)
    };
    let prompt = build_lane_prompt(
        connection,
        task,
        workflow,
        lane,
        queued_workspace_cwd.as_deref(),
        Some(&worker_prompt),
    );

    let queue_entry = role_runtime::enqueue_role_work(
        connection,
        crate::models::RoleQueueEntryInput {
            role_id: role.id.clone(),
            source_type: "workflow_lane".into(),
            source_task_id: Some(task.id.clone()),
            source_workflow_id: Some(workflow.id.clone()),
            source_lane_id: Some(lane.id.clone()),
            title: format!("{} · {}", task.number, task.title),
            summary: task.description.clone(),
            entry_prompt: Some(prompt.to_string()),
        },
    )?;

    let _ = role_dispatch::dispatch_role_queue(connection, project_root, session_dir, &role.id)?;
    let queue_entry = role_runtime::get_role_queue_entry(connection, &queue_entry.id)?;

    let (status, session_id, runtime_cwd, role_instance_id) =
        if let Some(instance_id) = queue_entry.assigned_instance_id.as_deref() {
            let instance = role_runtime::get_role_instance(connection, instance_id)?;
            if let Some(base_cwd) = instance.worktree_path.as_deref() {
                ensure_task_repository_workspaces(task, base_cwd)?;
            }
            (
                ASSIGNMENT_STATUS_ACTIVE.to_string(),
                instance.session_id.clone(),
                instance.worktree_path.clone(),
                Some(instance.id),
            )
        } else {
            (ASSIGNMENT_STATUS_QUEUED.to_string(), None, None, None)
        };

    let prompt = build_lane_prompt(
        connection,
        task,
        workflow,
        lane,
        runtime_cwd.as_deref(),
        Some(&worker_prompt),
    );

    let assignment = TaskLaneAssignment {
        id: assignment_id.to_string(),
        task_id: task.id.clone(),
        workflow_id: workflow.id.clone(),
        lane_id: lane.id.clone(),
        worker_type: "role".into(),
        worker_id: Some(role.id.clone()),
        status,
        session_id: session_id.clone(),
        runtime_cwd: runtime_cwd.clone(),
        role_queue_entry_id: Some(queue_entry.id.clone()),
        role_instance_id,
        prompt: Some(prompt.to_string()),
        pending_outcome: None,
        completion_notes: None,
        whip_count: 0,
        last_whip_at: None,
        started_at: now.to_string(),
        completed_at: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    };

    insert_assignment(connection, &assignment)?;
    if let Some(session_id) = session_id.as_deref() {
        ensure_lane_run(
            connection,
            task.id.as_str(),
            lane.id.as_str(),
            session_id,
            now,
        )?;
    }
    Ok(assignment)
}

fn dispatch_agent_lane(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task: &TaskDetail,
    workflow: &WorkflowDefinition,
    lane: &WorkflowLane,
    assignment_id: &str,
    now: &str,
) -> Result<TaskLaneAssignment, String> {
    let agent_slug = lane
        .assigned_entity_id
        .as_deref()
        .ok_or_else(|| format!("Lane {} is missing an agent reference", lane.name))?;
    let agent = get_agent_by_slug(connection, &task.project_id, agent_slug)?;
    let worker_prompt = WorkerPromptContext {
        worker_type: "agent",
        worker_type_label: "agent",
        worker_name: agent.name.clone(),
        worker_slug: agent.slug.clone(),
        system_prompt: normalize_optional(agent.system_prompt.clone()),
        project_overlay_prompt: load_worker_overlay_prompt(connection, task, "agent", &agent.slug)?,
    };

    let runtime_state = agent_runtime::ensure_agent_runtime_state_for_project(
        connection,
        &task.project_id,
        &agent.id,
    )?;
    let runtime_cwd = runtime_state
        .runtime_cwd
        .clone()
        .unwrap_or_else(|| project_root.display().to_string());
    let task_workspace_cwd = resolve_lane_workspace_cwd(
        connection,
        project_root,
        task,
        lane,
        Some(runtime_cwd.as_str()),
    )?;
    ensure_task_repository_workspaces(task, &task_workspace_cwd)?;
    let session_id = if let Some(existing_session_id) = runtime_state.main_session_id.clone() {
        if pi_sessions::find_session_context_for_session(&existing_session_id).is_ok() {
            existing_session_id
        } else {
            let created = pi_sessions::create_session_file(
                project_root,
                session_dir,
                Some(&format!("{} main session", agent.name)),
                false,
            )?;
            created.record.id
        }
    } else {
        let created = pi_sessions::create_session_file(
            Path::new(&runtime_cwd),
            session_dir,
            Some(&format!("{} main session", agent.name)),
            false,
        )?;
        created.record.id
    };

    let prompt = build_lane_prompt(
        connection,
        task,
        workflow,
        lane,
        Some(&task_workspace_cwd),
        Some(&worker_prompt),
    );

    apply_agent_session_defaults(project_root, session_dir, &session_id, &agent)?;
    // Always update the runtime_cwd to the task's project_root for the current dispatch
    let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
        connection,
        &runtime_state.project_id,
        &agent.id,
        Some(&session_id),
        Some(project_root.display().to_string().as_str()),
        runtime_state.current_queue_entry_id.as_deref(),
        &runtime_state.status,
        runtime_state.last_error.as_deref(),
    )?;
    ensure_lane_run(
        connection,
        task.id.as_str(),
        lane.id.as_str(),
        &session_id,
        now,
    )?;
    let queue_entry = agent_runtime::enqueue_agent_work_for_project(
        connection,
        &task.project_id,
        crate::models::AgentQueueEntryInput {
            agent_id: agent.id.clone(),
            source_type: "workflow_lane".into(),
            source_task_id: Some(task.id.clone()),
            source_workflow_id: Some(workflow.id.clone()),
            source_lane_id: Some(lane.id.clone()),
            delivery_mode: "prompt".into(),
            title: format!("{} · {}", task.number, task.title),
            message: prompt.to_string(),
        },
    )?;
    let run_id = generate_id("agent-queue-run");
    let queue_entry = agent_runtime::mark_agent_queue_entry_dispatched(
        connection,
        &queue_entry.id,
        &session_id,
        &run_id,
    )?
    .ok_or_else(|| {
        format!(
            "Unable to mark agent queue entry {} dispatched",
            queue_entry.id
        )
    })?;
    let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
        connection,
        &runtime_state.project_id,
        &agent.id,
        Some(&session_id),
        Some(project_root.display().to_string().as_str()),
        Some(&queue_entry.id),
        "running",
        None,
    )?;

    let assignment = TaskLaneAssignment {
        id: assignment_id.to_string(),
        task_id: task.id.clone(),
        workflow_id: workflow.id.clone(),
        lane_id: lane.id.clone(),
        worker_type: "agent".into(),
        worker_id: Some(agent.id.clone()),
        status: ASSIGNMENT_STATUS_ACTIVE.into(),
        session_id: Some(session_id.clone()),
        runtime_cwd: Some(project_root.display().to_string()),
        role_queue_entry_id: None,
        role_instance_id: None,
        prompt: Some(prompt.to_string()),
        pending_outcome: None,
        completion_notes: None,
        whip_count: 0,
        last_whip_at: None,
        started_at: now.to_string(),
        completed_at: None,
        created_at: now.to_string(),
        updated_at: now.to_string(),
    };
    insert_assignment(connection, &assignment)?;
    Ok(TaskLaneAssignment {
        session_id: Some(session_id),
        ..assignment
    })
}

fn complete_lane(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    outcome: &str,
    notes: Option<String>,
    app: Option<&AppHandle>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    let active_assignment = get_active_lane_assignment(connection, task_id)?;
    let current_assignment = get_current_lane_assignment(connection, task_id)?;
    let task = tasks::get_task_context(connection, task_id)?;
    let workflow = load_task_workflow(connection, &task)?;
    let lane_id = active_assignment
        .as_ref()
        .map(|assignment| assignment.lane_id.clone())
        .or_else(|| task.current_lane_id.clone())
        .ok_or_else(|| format!("Task {} has no current lane", task.id))?;
    let lane = workflow
        .lanes
        .iter()
        .find(|lane| lane.id == lane_id)
        .cloned()
        .ok_or_else(|| format!("Unable to resolve current lane for task {}", task.id))?;

    if let Some(assignment) = active_assignment.as_ref() {
        if assignment.status != ASSIGNMENT_STATUS_ACTIVE {
            return Err(format!("Task {task_id} is not currently running"));
        }
        validate_assignment_authorization(assignment, authorization)?;
        let unread_comments = tasks::list_unread_task_comments(connection, task_id, assignment)?;
        if !unread_comments.is_empty() {
            return Err(format!(
                "Task {task_id} has {} unread comment(s). Call get_unread_task_comments({task_id}), review them, then call mark_task_comments_read({task_id}) before using a completion tool.",
                unread_comments.len()
            ));
        }
        let unread_mail = messages::list_unread_mail_for_authorization(
            connection,
            authorization,
            assignment.session_id.as_deref(),
            Some(task_id),
        )?;
        if !unread_mail.is_empty() {
            return Err(format!(
                "Task {task_id} has {} unread mail message(s). Call get_unread_mail({task_id}), review them, then call mark_mail_read({task_id}) before using a completion tool.",
                unread_mail.len()
            ));
        }
        let unfinished_todos = tasks::list_unfinished_task_todos(
            connection,
            task_id,
            Some(assignment.lane_id.as_str()),
        )?;
        if !unfinished_todos.is_empty() {
            return Err(format!(
                "Task {task_id} still has {} unfinished todo item(s) for lane {}. Call list_unfinished_task_todos({task_id}, laneId={}) to review them, then finish or reopen them before using a completion tool.",
                unfinished_todos.len(),
                assignment.lane_id,
                assignment.lane_id,
            ));
        }
    } else {
        if current_assignment.as_ref().is_some_and(|assignment| {
            matches!(
                assignment.status.as_str(),
                ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
                    | ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION
            )
        }) {
            return Err(format!(
                "Task {task_id} is paused for user review. Use the dedicated review actions to approve, resume, or re-lane it instead of a completion tool."
            ));
        }
        if !(task.assignee_type == "user" && task.status == "in_review") {
            return Err(format!("Task {task_id} has no active lane assignment"));
        }
    }

    if task.status == "blocked" || task.dependency_blocked {
        if active_assignment.is_none() {
            return Err(format!(
                "Task {task_id} is blocked by unresolved dependencies or unfinished subtasks and cannot progress until those blockers are resolved."
            ));
        }
    }

    let now = now_iso();
    let normalized_notes = normalize_optional(notes);

    if let Some(assignment) = active_assignment.as_ref() {
        if task.status == "blocked" || task.dependency_blocked {
            update_open_lane_run(
                connection,
                task_id,
                &assignment.lane_id,
                assignment.session_id.as_deref(),
                "blocked",
                normalized_notes.clone(),
                &now,
            )?;
            finalize_worker_assignment(
                connection,
                project_root,
                session_dir,
                &task,
                assignment,
                "success",
                normalized_notes.clone(),
                &now,
            )?;
            if task.status != "blocked" {
                tasks::reconcile_dependency_statuses(connection, vec![task.id.clone()], &now)?;
            }
            let updated = tasks::get_task_context(connection, task_id)?;
            let _ = session_list::auto_archive_session_for_task_status(
                connection,
                assignment,
                &updated.status,
            )?;
            return Ok(updated);
        }

        if outcome == "success"
            && lane.require_user_approval_on_success
            && matches!(assignment.worker_type.as_str(), "agent" | "role")
        {
            mark_assignment_awaiting_user_approval(
                connection,
                &assignment.id,
                normalized_notes.clone(),
                &now,
            )?;
            mark_assignment_worker_waiting_for_user_response(connection, assignment, &now)?;
            move_task_to_user_review(connection, &task.id, &lane.id, &now)?;
            let updated = tasks::get_task_context(connection, task_id)?;
            let _ = notifications::publish_task_attention_notification(
                app,
                connection,
                &updated,
                &lane,
                "awaiting_user_approval",
                normalized_notes.as_deref(),
            );
            return Ok(updated);
        }

        if outcome == "needs_user" && matches!(assignment.worker_type.as_str(), "agent" | "role") {
            mark_assignment_awaiting_user_intervention(
                connection,
                &assignment.id,
                normalized_notes.clone(),
                &now,
            )?;
            mark_assignment_worker_waiting_for_user_response(connection, assignment, &now)?;
            move_task_to_user_review(connection, &task.id, &lane.id, &now)?;
            let updated = tasks::get_task_context(connection, task_id)?;
            let _ = notifications::publish_task_attention_notification(
                app,
                connection,
                &updated,
                &lane,
                "awaiting_user_intervention",
                normalized_notes.as_deref(),
            );
            return Ok(updated);
        }

        update_open_lane_run(
            connection,
            task_id,
            &assignment.lane_id,
            assignment.session_id.as_deref(),
            outcome,
            normalized_notes.clone(),
            &now,
        )?;

        finalize_worker_assignment(
            connection,
            project_root,
            session_dir,
            &task,
            assignment,
            outcome,
            normalized_notes.clone(),
            &now,
        )?;
    }

    transition_task_after_completion(connection, &task, &lane, outcome, &now)?;
    let updated = tasks::get_task_context(connection, task_id)?;
    if let Some(assignment) = active_assignment.as_ref() {
        let _ = session_list::auto_archive_session_for_task_status(
            connection,
            assignment,
            &updated.status,
        )?;
    }
    if outcome == "needs_user" {
        let _ = notifications::publish_task_attention_notification(
            app,
            connection,
            &updated,
            &lane,
            "needs_user",
            normalized_notes.as_deref(),
        );
    }
    Ok(updated)
}

pub fn approve_task_review(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
) -> Result<TaskDetail, String> {
    let assignment = get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Task {task_id} has no lane assignment awaiting approval"))?;
    let task = tasks::get_task_context(connection, task_id)?;
    if effective_task_review_assignment_status(&task, &assignment)
        != ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
    {
        return Err(format!("Task {task_id} is not awaiting user approval"));
    }
    let workflow = load_task_workflow(connection, &task)?;
    let lane = workflow
        .lanes
        .iter()
        .find(|lane| lane.id == assignment.lane_id)
        .cloned()
        .ok_or_else(|| format!("Unable to resolve current lane for task {}", task.id))?;
    let now = now_iso();

    update_open_lane_run(
        connection,
        task_id,
        &assignment.lane_id,
        assignment.session_id.as_deref(),
        "success",
        assignment.completion_notes.clone(),
        &now,
    )?;
    finalize_worker_assignment(
        connection,
        project_root,
        session_dir,
        &task,
        &assignment,
        "success",
        assignment.completion_notes.clone(),
        &now,
    )?;
    transition_task_after_completion(connection, &task, &lane, "success", &now)?;
    let updated = tasks::get_task_context(connection, task_id)?;
    let _ = session_list::auto_archive_session_for_task_status(
        connection,
        &assignment,
        &updated.status,
    )?;
    Ok(updated)
}

pub fn approve_pending_lane_completion(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
) -> Result<TaskDetail, String> {
    approve_task_review(connection, project_root, session_dir, task_id)
}

pub fn reassign_task_to_lane(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
    lane_id: &str,
    notes: Option<String>,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    let workflow = load_task_workflow(connection, &task)?;
    let target_lane = workflow
        .lanes
        .iter()
        .find(|lane| lane.id == lane_id)
        .cloned()
        .ok_or_else(|| format!("Workflow lane {lane_id} does not exist for task {task_id}"))?;

    if task.current_lane_id.as_deref() == Some(target_lane.id.as_str()) {
        return Err(format!(
            "Task {task_id} is already in lane {}. Use the lane's normal completion or rework actions instead.",
            target_lane.id
        ));
    }

    let current_assignment = get_current_lane_assignment(connection, task_id)?;
    if let Some(context) = authorization {
        match context.actor_type.as_str() {
            "user" => {}
            "agent" | "role_instance" => {
                let assignment = current_assignment.as_ref().ok_or_else(|| {
                    format!(
                        "Task {task_id} does not have an active worker-owned lane assignment to re-lane"
                    )
                })?;
                if !matches!(
                    assignment.status.as_str(),
                    ASSIGNMENT_STATUS_ACTIVE
                        | ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
                        | ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION
                ) {
                    return Err(format!(
                        "Only the user can re-lane task {task_id} while it has no active worker-owned assignment"
                    ));
                }
                validate_assignment_authorization(assignment, authorization)?;
            }
            other => {
                return Err(format!(
                    "Unsupported actor type for task re-lane action: {other}"
                ));
            }
        }
    }

    let now = now_iso();
    let normalized_notes = normalize_optional(notes);

    if let Some(assignment) = current_assignment.as_ref() {
        match assignment.status.as_str() {
            ASSIGNMENT_STATUS_ACTIVE
            | ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
            | ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION => {
                update_open_lane_run(
                    connection,
                    task_id,
                    &assignment.lane_id,
                    assignment.session_id.as_deref(),
                    "failure",
                    normalized_notes.clone(),
                    &now,
                )?;
                finalize_worker_assignment(
                    connection,
                    project_root,
                    session_dir,
                    &task,
                    assignment,
                    "failure",
                    normalized_notes.clone(),
                    &now,
                )?;
            }
            ASSIGNMENT_STATUS_QUEUED => {
                cancel_queued_assignment_for_relane(
                    connection,
                    &task,
                    assignment,
                    normalized_notes.clone(),
                    &now,
                )?;
            }
            _ => {}
        }
    }

    move_task_to_specific_lane(connection, &task, &target_lane, &now)?;
    tasks::get_task_context(connection, task_id)
}

fn reactivate_task_lane_assignment(
    connection: &Connection,
    task_id: &str,
    allowed_statuses: &[&str],
    missing_error: &str,
    invalid_error: &str,
) -> Result<TaskLaneAssignment, String> {
    let assignment = get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| missing_error.to_string())?;
    let task = tasks::get_task_context(connection, task_id)?;
    let effective_status = effective_task_review_assignment_status(&task, &assignment);
    if !allowed_statuses.contains(&effective_status.as_str()) {
        return Err(invalid_error.to_string());
    }

    let now = now_iso();
    let mut next_assignment_status = ASSIGNMENT_STATUS_ACTIVE;
    if assignment.status == ASSIGNMENT_STATUS_PAUSED_BY_USER
        && assignment.worker_type == "role"
        && assignment.session_id.is_none()
    {
        next_assignment_status = ASSIGNMENT_STATUS_QUEUED;
    }

    connection
        .execute(
            r#"
            UPDATE task_lane_assignments
            SET status = ?2,
                pending_outcome = NULL,
                completion_notes = NULL,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![assignment.id, next_assignment_status, now],
        )
        .map_err(|error| {
            format!(
                "Unable to reactivate lane assignment {}: {error}",
                assignment.id
            )
        })?;

    if let Some(role_queue_entry_id) = assignment.role_queue_entry_id.as_deref() {
        if next_assignment_status == ASSIGNMENT_STATUS_QUEUED {
            let assigned_instance_id = connection
                .query_row(
                    "SELECT assigned_instance_id FROM role_queue_entries WHERE id = ?1",
                    [role_queue_entry_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to inspect role queue entry {} for task {}: {error}",
                        role_queue_entry_id, task_id
                    )
                })?
                .flatten();
            let next_queue_status = if assigned_instance_id.is_some() {
                "assigned"
            } else {
                "queued"
            };
            connection
                .execute(
                    r#"
                    UPDATE role_queue_entries
                    SET status = ?2,
                        completed_at = NULL,
                        updated_at = ?3
                    WHERE id = ?1
                    "#,
                    params![role_queue_entry_id, next_queue_status, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to restore role queue entry {} for task {}: {error}",
                        role_queue_entry_id, task_id
                    )
                })?;
        } else {
            connection
                .execute(
                    r#"
                    UPDATE role_queue_entries
                    SET status = 'assigned',
                        completed_at = NULL,
                        updated_at = ?2
                    WHERE id = ?1 AND status = 'paused_by_user'
                    "#,
                    params![role_queue_entry_id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to reactivate role queue entry {} for task {}: {error}",
                        role_queue_entry_id, task_id
                    )
                })?;
        }
    }

    if let Some(role_instance_id) = assignment.role_instance_id.as_deref() {
        connection
            .execute(
                r#"
                UPDATE role_instances
                SET status = 'running',
                    updated_at = ?2
                WHERE id = ?1
                "#,
                params![role_instance_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to reactivate role instance {} for task {}: {error}",
                    role_instance_id, task_id
                )
            })?;
    }

    if assignment.worker_type == "agent" {
        if let Some(worker_id) = assignment.worker_id.as_deref() {
            let task = tasks::get_task_context(connection, task_id)?;
            connection
                .execute(
                    r#"
                    UPDATE agent_runtime_states
                    SET status = 'running',
                        updated_at = ?3
                    WHERE project_id = ?1 AND agent_id = ?2
                    "#,
                    params![task.project_id, worker_id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to reactivate agent runtime state for task {}: {error}",
                        task_id
                    )
                })?;
        }

        connection
            .execute(
                r#"
                UPDATE agent_queue_entries
                SET status = 'dispatched',
                    completed_at = NULL,
                    updated_at = ?2
                WHERE source_task_id = ?1 AND status = 'paused_by_user'
                "#,
                params![task_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to reactivate queued agent work for task {}: {error}",
                    task_id
                )
            })?;
    }

    connection
        .execute(
            r#"
            UPDATE tasks
            SET current_lane_id = ?2,
                assignee_type = ?3,
                assignee_id = ?4,
                status = 'in_progress',
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![
                task_id,
                assignment.lane_id,
                assignment.worker_type,
                assignment.worker_id,
                now,
            ],
        )
        .map_err(|error| format!("Unable to reactivate task {} for work: {error}", task_id))?;

    if next_assignment_status == ASSIGNMENT_STATUS_QUEUED {
        activate_queued_role_assignments(connection)?;
    }

    get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Unable to reload reactivated lane assignment for task {task_id}"))
}

pub fn mark_task_needs_work(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskLaneAssignment, String> {
    reactivate_task_lane_assignment(
        connection,
        task_id,
        &[ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL],
        &format!("Task {task_id} has no review-paused lane assignment to resume"),
        &format!("Task {task_id} is not awaiting user approval"),
    )
}

pub fn resume_task_lane(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskLaneAssignment, String> {
    reactivate_task_lane_assignment(
        connection,
        task_id,
        &[
            ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION,
            ASSIGNMENT_STATUS_PAUSED_BY_USER,
        ],
        &format!("Task {task_id} has no paused lane assignment to resume"),
        &format!("Task {task_id} is not paused for user intervention or user-directed pause"),
    )
}

pub fn pause_task_lane(
    connection: &Connection,
    task_id: &str,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let assignment = get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Task {task_id} has no lane assignment to pause"))?;
    if !matches!(
        assignment.status.as_str(),
        ASSIGNMENT_STATUS_ACTIVE | ASSIGNMENT_STATUS_QUEUED
    ) {
        return Err(format!(
            "Task {task_id} is not active or queued and cannot be paused"
        ));
    }

    let task = tasks::get_task_context(connection, task_id)?;
    let now = now_iso();
    let normalized_notes = normalize_optional(notes);

    connection
        .execute(
            r#"
            UPDATE task_lane_assignments
            SET status = ?2,
                pending_outcome = 'paused',
                completion_notes = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![
                assignment.id,
                ASSIGNMENT_STATUS_PAUSED_BY_USER,
                normalized_notes.as_deref(),
                now,
            ],
        )
        .map_err(|error| format!("Unable to pause lane assignment {}: {error}", assignment.id))?;

    if let Some(queue_entry_id) = assignment.role_queue_entry_id.as_deref() {
        connection
            .execute(
                r#"
                UPDATE role_queue_entries
                SET status = 'paused_by_user',
                    updated_at = ?2
                WHERE id = ?1 AND status IN ('queued', 'assigned')
                "#,
                params![queue_entry_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to pause role queue entry {} for task {}: {error}",
                    queue_entry_id, task_id
                )
            })?;
    }

    if let Some(role_instance_id) = assignment.role_instance_id.as_deref() {
        connection
            .execute(
                r#"
                UPDATE role_instances
                SET status = 'waiting',
                    updated_at = ?2
                WHERE id = ?1
                "#,
                params![role_instance_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to pause role instance {} for task {}: {error}",
                    role_instance_id, task_id
                )
            })?;
    }

    if assignment.worker_type == "agent" {
        if let Some(worker_id) = assignment.worker_id.as_deref() {
            connection
                .execute(
                    r#"
                    UPDATE agent_runtime_states
                    SET status = 'waiting',
                        last_error = ?4,
                        updated_at = ?3
                    WHERE project_id = ?1 AND agent_id = ?2
                    "#,
                    params![task.project_id, worker_id, now, normalized_notes.as_deref()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to pause agent runtime state for task {}: {error}",
                        task_id
                    )
                })?;
        }

        connection
            .execute(
                r#"
                UPDATE agent_queue_entries
                SET status = 'paused_by_user',
                    updated_at = ?2
                WHERE source_task_id = ?1 AND status IN ('queued', 'dispatched')
                "#,
                params![task_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to pause queued agent work for task {}: {error}",
                    task_id
                )
            })?;
    }

    move_task_to_user_review(connection, task_id, &assignment.lane_id, &now)?;
    tasks::get_task_context(connection, task_id)
}

pub fn send_lane_back_for_work(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskLaneAssignment, String> {
    let assignment = get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Task {task_id} has no paused lane assignment to resume"))?;
    let task = tasks::get_task_context(connection, task_id)?;
    match effective_task_review_assignment_status(&task, &assignment).as_str() {
        ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL => mark_task_needs_work(connection, task_id),
        ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION => resume_task_lane(connection, task_id),
        _ => Err(format!("Task {task_id} is not paused for user review")),
    }
}

fn mark_assignment_awaiting_user_approval(
    connection: &Connection,
    assignment_id: &str,
    notes: Option<String>,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE task_lane_assignments
            SET status = ?2,
                pending_outcome = 'success',
                completion_notes = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![
                assignment_id,
                ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL,
                notes,
                now
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to mark task lane assignment {} awaiting user approval: {error}",
                assignment_id
            )
        })?;
    Ok(())
}

fn mark_assignment_awaiting_user_intervention(
    connection: &Connection,
    assignment_id: &str,
    notes: Option<String>,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE task_lane_assignments
            SET status = ?2,
                pending_outcome = 'needs_user',
                completion_notes = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![
                assignment_id,
                ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION,
                notes,
                now
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to mark task lane assignment {} awaiting user intervention: {error}",
                assignment_id
            )
        })?;
    Ok(())
}

fn mark_assignment_worker_waiting_for_user_response(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    now: &str,
) -> Result<(), String> {
    let Some(role_instance_id) = assignment.role_instance_id.as_deref() else {
        return Ok(());
    };

    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = 'waiting',
                updated_at = ?2
            WHERE id = ?1
            "#,
            params![role_instance_id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to mark role instance {} waiting for user response: {error}",
                role_instance_id
            )
        })?;
    Ok(())
}

fn move_task_to_user_review(
    connection: &Connection,
    task_id: &str,
    lane_id: &str,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE tasks
            SET current_lane_id = ?2,
                assignee_type = 'user',
                assignee_id = NULL,
                status = 'in_review',
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![task_id, lane_id, now],
        )
        .map_err(|error| format!("Unable to move task {} to user review: {error}", task_id))?;
    Ok(())
}

fn move_task_to_specific_lane(
    connection: &Connection,
    task: &TaskDetail,
    lane: &WorkflowLane,
    now: &str,
) -> Result<(), String> {
    let status = if lane.assigned_entity_type == "user" {
        "in_review"
    } else {
        "ready"
    };
    connection
        .execute(
            r#"
            UPDATE tasks
            SET current_lane_id = ?2,
                assignee_type = ?3,
                assignee_id = ?4,
                status = ?5,
                updated_at = ?6
            WHERE id = ?1
            "#,
            params![
                task.id,
                lane.id,
                lane.assigned_entity_type,
                lane.assigned_entity_id,
                status,
                now,
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to move task {} to workflow lane {}: {error}",
                task.id, lane.id
            )
        })?;
    Ok(())
}

fn cancel_queued_assignment_for_relane(
    connection: &Connection,
    task: &TaskDetail,
    assignment: &TaskLaneAssignment,
    notes: Option<String>,
    now: &str,
) -> Result<(), String> {
    complete_assignment(connection, &assignment.id, ASSIGNMENT_STATUS_CANCELED, now)?;

    if let Some(queue_entry_id) = assignment.role_queue_entry_id.as_deref() {
        let assigned_instance_id = connection
            .query_row(
                "SELECT assigned_instance_id FROM role_queue_entries WHERE id = ?1",
                [queue_entry_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to inspect role queue entry {} for task {}: {error}",
                    queue_entry_id, task.id
                )
            })?
            .flatten();

        connection
            .execute(
                r#"
                UPDATE role_queue_entries
                SET status = 'canceled',
                    completed_at = ?2,
                    updated_at = ?2
                WHERE id = ?1
                  AND status IN ('queued', 'assigned')
                "#,
                params![queue_entry_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to cancel role queue entry {} for task {}: {error}",
                    queue_entry_id, task.id
                )
            })?;

        if let Some(instance_id) = assigned_instance_id.as_deref() {
            clear_role_instance_for_reset(connection, instance_id, notes.clone(), now)?;
        }
    }

    if let Some(role_instance_id) = assignment.role_instance_id.as_deref() {
        clear_role_instance_for_reset(connection, role_instance_id, notes.clone(), now)?;
    }

    if let Some(worker_id) = assignment.worker_id.as_deref() {
        if assignment.worker_type == "agent" {
            connection
                .execute(
                    r#"
                    UPDATE agent_runtime_states
                    SET status = 'idle',
                        current_queue_entry_id = NULL,
                        last_error = ?4,
                        updated_at = ?3
                    WHERE project_id = ?1 AND agent_id = ?2
                    "#,
                    params![task.project_id, worker_id, now, notes.as_deref()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to reset agent runtime state for task {} during re-lane: {error}",
                        task.id
                    )
                })?;
        }
    }

    Ok(())
}

fn finalize_worker_assignment(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task: &TaskDetail,
    assignment: &TaskLaneAssignment,
    outcome: &str,
    notes: Option<String>,
    now: &str,
) -> Result<(), String> {
    if let Some(instance_id) = assignment.role_instance_id.as_deref() {
        let release_outcome = if outcome == "failure" {
            "failure"
        } else {
            "success"
        };
        let _ = role_dispatch::release_role_instance(
            connection,
            project_root,
            session_dir,
            instance_id,
            release_outcome,
            if outcome == "failure" {
                notes.clone()
            } else {
                None
            },
        )?;
    }

    if assignment.worker_type == "agent" {
        if let Some(agent_id) = assignment.worker_id.as_deref() {
            if let Some(runtime_state) = agent_runtime::get_agent_runtime_state_for_project(
                connection,
                &task.project_id,
                agent_id,
            )? {
                if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
                    if outcome == "failure" {
                        agent_runtime::mark_agent_queue_entry_failed(connection, queue_entry_id)?;
                    } else {
                        agent_runtime::mark_agent_queue_entry_completed(
                            connection,
                            queue_entry_id,
                        )?;
                    }
                }
                let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                    connection,
                    &runtime_state.project_id,
                    agent_id,
                    assignment.session_id.as_deref(),
                    assignment.runtime_cwd.as_deref(),
                    None,
                    if outcome == "failure" {
                        "needs_attention"
                    } else {
                        "idle"
                    },
                    if outcome == "failure" {
                        notes.as_deref()
                    } else {
                        None
                    },
                )?;
            }
        }
    }

    let assignment_status = match outcome {
        "success" | "needs_user" => ASSIGNMENT_STATUS_COMPLETED,
        "failure" => ASSIGNMENT_STATUS_FAILED,
        _ => ASSIGNMENT_STATUS_CANCELED,
    };
    complete_assignment(connection, &assignment.id, assignment_status, now)
}

fn transition_task_after_completion(
    connection: &Connection,
    task: &TaskDetail,
    lane: &WorkflowLane,
    outcome: &str,
    now: &str,
) -> Result<(), String> {
    if outcome == "needs_user" {
        connection
            .execute(
                r#"
                UPDATE tasks
                SET current_lane_id = ?2,
                    assignee_type = 'user',
                    assignee_id = NULL,
                    status = 'in_review',
                    updated_at = ?3
                WHERE id = ?1
                "#,
                params![task.id, task.current_lane_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to move task {} to user intervention: {error}",
                    task.id
                )
            })?;
        return Ok(());
    }

    let (next_lane_id, next_status, next_assignee_type, next_assignee_id) = match outcome {
        "success" => match lane.success_transition_type.as_str() {
            "lane" => (
                lane.success_target_lane_id.clone(),
                "ready".to_string(),
                None,
                None,
            ),
            "end" => (
                None,
                "completed".to_string(),
                Some("unassigned".to_string()),
                None,
            ),
            _ => (
                None,
                "in_review".to_string(),
                Some("user".to_string()),
                None,
            ),
        },
        "failure" => match lane.failure_transition_type.as_str() {
            "lane" => (
                lane.failure_target_lane_id.clone(),
                "ready".to_string(),
                None,
                None,
            ),
            _ => (None, "blocked".to_string(), Some("user".to_string()), None),
        },
        "needs_user" => (
            Some(lane.id.clone()),
            "in_review".to_string(),
            Some("user".to_string()),
            None,
        ),
        _ => (
            Some(lane.id.clone()),
            task.status.clone(),
            Some(task.assignee_type.clone()),
            task.assignee_id.clone(),
        ),
    };

    let (resolved_assignee_type, resolved_assignee_id, resolved_lane_id, resolved_status) =
        if let Some(next_lane_id) = next_lane_id {
            let workflow = workflows::get_workflow(
                connection,
                task.workflow_id
                    .as_deref()
                    .ok_or_else(|| format!("Task {} has no workflow", task.id))?,
            )?;
            if let Some(next_lane) = workflow.lanes.iter().find(|entry| entry.id == next_lane_id) {
                let status = if next_lane.assigned_entity_type == "user" {
                    if outcome == "needs_user" {
                        "in_review"
                    } else {
                        "in_review"
                    }
                } else {
                    &resolved_status_candidate(&next_status)
                };
                (
                    next_lane.assigned_entity_type.clone(),
                    next_lane.assigned_entity_id.clone(),
                    Some(next_lane.id.clone()),
                    status.to_string(),
                )
            } else {
                (
                    next_assignee_type.unwrap_or_else(|| task.assignee_type.clone()),
                    next_assignee_id.or_else(|| task.assignee_id.clone()),
                    Some(next_lane_id),
                    next_status,
                )
            }
        } else {
            (
                next_assignee_type.unwrap_or_else(|| task.assignee_type.clone()),
                next_assignee_id.or_else(|| task.assignee_id.clone()),
                None,
                next_status,
            )
        };

    connection
        .execute(
            r#"
            UPDATE tasks
            SET current_lane_id = ?2,
                assignee_type = ?3,
                assignee_id = ?4,
                status = ?5,
                updated_at = ?6
            WHERE id = ?1
            "#,
            params![
                task.id,
                resolved_lane_id,
                resolved_assignee_type,
                resolved_assignee_id,
                resolved_status,
                now,
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to update task {} after lane completion: {error}",
                task.id
            )
        })?;
    tasks::reconcile_dependency_statuses(
        connection,
        tasks::collect_task_refresh_ids(connection, &task.id)?,
        now,
    )?;
    Ok(())
}

fn resolved_status_candidate(status: &str) -> String {
    if status == "completed" {
        "completed".into()
    } else {
        "ready".into()
    }
}

pub(crate) fn validate_assignment_authorization(
    assignment: &TaskLaneAssignment,
    authorization: Option<&AuthorizationContext>,
) -> Result<(), String> {
    let Some(authorization) = authorization else {
        return Ok(());
    };

    match authorization.actor_type.as_str() {
        "role_instance" => {
            if assignment.role_instance_id.as_deref() == Some(authorization.actor_id.as_str()) {
                Ok(())
            } else {
                Err("This role instance does not own the active task lane assignment".into())
            }
        }
        "agent" => {
            if assignment.worker_type == "agent"
                && assignment.worker_id.as_deref() == Some(authorization.actor_id.as_str())
            {
                Ok(())
            } else {
                Err("This agent does not own the active task lane assignment".into())
            }
        }
        "user" => Ok(()),
        other => Err(format!(
            "Unsupported actor type for task lane completion: {other}"
        )),
    }
}

pub fn transitioned_assignment_session_to_retire(
    previous_assignment: Option<&TaskLaneAssignment>,
    updated_task: &TaskDetail,
) -> Option<String> {
    let previous_assignment = previous_assignment?;
    if previous_assignment.worker_type != "role" {
        return None;
    }

    let session_id = previous_assignment.session_id.clone()?;
    let still_active_same_session =
        updated_task
            .active_lane_assignment
            .as_ref()
            .is_some_and(|assignment| {
                assignment.session_id.as_deref() == Some(session_id.as_str())
                    && matches!(
                        assignment.status.as_str(),
                        ASSIGNMENT_STATUS_ACTIVE | ASSIGNMENT_STATUS_QUEUED
                    )
            });

    if still_active_same_session {
        None
    } else {
        Some(session_id)
    }
}

pub(crate) fn assignment_owned_by_worker_authorization(
    assignment: &TaskLaneAssignment,
    authorization: Option<&AuthorizationContext>,
) -> bool {
    match authorization {
        Some(authorization) if authorization.actor_type == "role_instance" => {
            assignment.role_instance_id.as_deref() == Some(authorization.actor_id.as_str())
        }
        Some(authorization) if authorization.actor_type == "agent" => {
            assignment.worker_type == "agent"
                && assignment.worker_id.as_deref() == Some(authorization.actor_id.as_str())
        }
        _ => false,
    }
}

fn sync_task_lane_owner(
    connection: &Connection,
    task: &TaskDetail,
    lane: &WorkflowLane,
    status: &str,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE tasks
            SET workflow_id = ?2,
                current_lane_id = ?3,
                assignee_type = ?4,
                assignee_id = ?5,
                status = ?6,
                updated_at = ?7
            WHERE id = ?1
            "#,
            params![
                task.id,
                task.workflow_id,
                lane.id,
                lane.assigned_entity_type,
                lane.assigned_entity_id,
                status,
                now_iso(),
            ],
        )
        .map_err(|error| format!("Unable to update task {} lane owner: {error}", task.id))?;
    Ok(())
}

fn insert_assignment(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO task_lane_assignments (
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20)
            "#,
            params![
                assignment.id,
                assignment.task_id,
                assignment.workflow_id,
                assignment.lane_id,
                assignment.worker_type,
                assignment.worker_id,
                assignment.status,
                assignment.session_id,
                assignment.runtime_cwd,
                assignment.role_queue_entry_id,
                assignment.role_instance_id,
                assignment.prompt,
                assignment.pending_outcome,
                assignment.completion_notes,
                assignment.whip_count,
                assignment.last_whip_at,
                assignment.started_at,
                assignment.completed_at,
                assignment.created_at,
                assignment.updated_at,
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to insert task lane assignment {}: {error}",
                assignment.id
            )
        })?;
    Ok(())
}

fn complete_assignment(
    connection: &Connection,
    assignment_id: &str,
    status: &str,
    now: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE task_lane_assignments SET status = ?2, pending_outcome = NULL, completed_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![assignment_id, status, now],
        )
        .map_err(|error| format!("Unable to complete lane assignment {assignment_id}: {error}"))?;
    Ok(())
}

fn ensure_lane_run(
    connection: &Connection,
    task_id: &str,
    lane_id: &str,
    session_id: &str,
    now: &str,
) -> Result<(), String> {
    let existing = connection
        .query_row(
            r#"
            SELECT id FROM task_lane_runs
            WHERE task_id = ?1 AND lane_id = ?2 AND session_id = ?3 AND completed_at IS NULL
            ORDER BY started_at DESC, id DESC
            LIMIT 1
            "#,
            params![task_id, lane_id, session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up open lane run: {error}"))?;

    if existing.is_some() {
        return Ok(());
    }

    connection
        .execute(
            r#"
            INSERT INTO task_lane_runs (id, task_id, lane_id, session_id, result, notes, started_at, completed_at)
            VALUES (?1, ?2, ?3, ?4, 'needs_user', NULL, ?5, NULL)
            "#,
            params![format!("lane-run-{}", Uuid::new_v4().simple()), task_id, lane_id, session_id, now],
        )
        .map_err(|error| format!("Unable to create lane run for task {task_id}: {error}"))?;
    Ok(())
}

fn update_open_lane_run(
    connection: &Connection,
    task_id: &str,
    lane_id: &str,
    session_id: Option<&str>,
    result: &str,
    notes: Option<String>,
    now: &str,
) -> Result<(), String> {
    let lane_run_id = if let Some(session_id) = session_id {
        connection
            .query_row(
                r#"
                SELECT id FROM task_lane_runs
                WHERE task_id = ?1 AND lane_id = ?2 AND session_id = ?3 AND completed_at IS NULL
                ORDER BY started_at DESC, id DESC
                LIMIT 1
                "#,
                params![task_id, lane_id, session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Unable to load open lane run: {error}"))?
    } else {
        None
    };

    if let Some(lane_run_id) = lane_run_id {
        connection
            .execute(
                "UPDATE task_lane_runs SET result = ?2, notes = ?3, completed_at = ?4 WHERE id = ?1",
                params![lane_run_id, result, notes, now],
            )
            .map_err(|error| format!("Unable to update lane run {lane_run_id}: {error}"))?;
    }
    Ok(())
}

fn load_task_workflow(
    connection: &Connection,
    task: &TaskDetail,
) -> Result<WorkflowDefinition, String> {
    let workflow_id = task
        .workflow_id
        .as_deref()
        .ok_or_else(|| format!("Task {} is missing a workflow", task.id))?;
    workflows::get_workflow(connection, workflow_id)
}

fn resolve_task_lane(
    workflow: &WorkflowDefinition,
    task: &TaskDetail,
) -> Result<WorkflowLane, String> {
    if let Some(current_lane_id) = task.current_lane_id.as_deref() {
        workflow
            .lanes
            .iter()
            .find(|lane| lane.id == current_lane_id)
            .cloned()
            .ok_or_else(|| {
                format!(
                    "Current lane {} was not found in workflow {}",
                    current_lane_id, workflow.id
                )
            })
    } else {
        workflow
            .lanes
            .iter()
            .min_by_key(|lane| lane.order)
            .cloned()
            .ok_or_else(|| format!("Workflow {} has no lanes", workflow.id))
    }
}

fn get_role_by_slug(connection: &Connection, role_slug: &str) -> Result<RoleDefinition, String> {
    let role_id = connection
        .query_row(
            "SELECT id FROM roles WHERE slug = ?1 LIMIT 1",
            [role_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query role slug {role_slug}: {error}"))?
        .ok_or_else(|| format!("Role {role_slug} was not found"))?;
    crate::services::roles::get_role(connection, &role_id)
}

fn get_agent_by_slug(
    connection: &Connection,
    project_id: &str,
    agent_slug: &str,
) -> Result<AgentDefinition, String> {
    let agent_id = connection
        .query_row(
            "SELECT id FROM agents WHERE slug = ?1 LIMIT 1",
            [agent_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query agent slug {agent_slug}: {error}"))?
        .ok_or_else(|| format!("Agent {agent_slug} was not found"))?;
    let agent = agents::get_agent(connection, &agent_id)?;
    if agents::agent_visible_in_project(&agent, project_id) {
        Ok(agent)
    } else {
        Err(format!(
            "Agent {agent_slug} is not available in project {project_id}"
        ))
    }
}

pub fn preferred_lane_session_id(
    connection: &Connection,
    task_id: &str,
    lane_id: &str,
    worker_type: &str,
    worker_id: Option<&str>,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT session_id
            FROM task_lane_assignments
            WHERE task_id = ?1
              AND lane_id = ?2
              AND worker_type = ?3
              AND (?4 IS NULL OR worker_id = ?4)
              AND session_id IS NOT NULL
            ORDER BY updated_at DESC, created_at DESC, id DESC
            LIMIT 1
            "#,
            params![task_id, lane_id, worker_type, worker_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query preferred lane session: {error}"))
}

pub(crate) fn apply_agent_session_defaults(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    agent: &AgentDefinition,
) -> Result<(), String> {
    let context = pi_sessions::find_session_context_for_session(session_id).ok();
    let session_project_root = context
        .as_ref()
        .map(|entry| entry.project_root.as_path())
        .unwrap_or(project_root);
    let session_dir = context
        .as_ref()
        .map(|entry| entry.session_dir.as_path())
        .unwrap_or(session_dir);

    if let (Some(provider), Some(model)) = (agent.provider.as_deref(), agent.model.as_deref()) {
        let _ = pi_sessions::set_session_model(
            session_project_root,
            session_dir,
            session_id,
            provider,
            model,
        )?;
    }
    let _ = pi_sessions::set_session_thinking_level(
        session_project_root,
        session_dir,
        session_id,
        &agent.thinking_level,
    )?;
    Ok(())
}

pub fn lane_rework_follow_up_prompt() -> String {
    [
        "The user has requested more work be done on this lane.",
        "Reload the latest task context, comments, and mail before continuing so you are working from current Orchestra state.",
        "Continue the lane using the same session and finish by calling the appropriate Orchestra completion tool when the work is actually done.",
    ]
    .join("\n\n")
}

fn orchestra_working_rules_block() -> String {
    [
        "How to work effectively in this session:",
        "1. Start by understanding the task in Orchestra terms, not just the latest message.",
        "2. Immediately call get_task_context using the canonical task ID shown above so you are working from fresh live state before making decisions.",
        "3. If anything is still unclear or may have changed again, call get_task_context again to refresh the live task state.",
        "4. Do the reasoning/work needed for the lane.",
        "5. Whenever you resume this lane, restart after an interruption, or suspect new feedback may have arrived, call get_unread_task_comments using the canonical task ID. After you read and incorporate those comments, call mark_task_comments_read so Orchestra knows you saw them.",
        "6. Whenever you resume this lane, restart after an interruption, or Orchestra tells you to check mail, call get_unread_mail using the canonical task ID. After you read and incorporate unread mail, call mark_mail_read so Orchestra knows you handled it.",
        "7. Whenever you take or finish a large action, leave a durable comment with comment_on_task describing what you did and why. If you are responding to a specific existing comment, reply in-thread by setting parentCommentId instead of starting a new top-level comment.",
        "8. When you identify a smaller follow-up item for this lane that should stay visible but does not deserve its own subtask, add it with add_task_todo and an explicit laneId target. Use subtasks only for separately tracked work.",
        "9. If the work needs to be split into a separately tracked child task, create_subtask and describe the smaller unit clearly.",
        "10. If another task must finish first, add_task_dependency. If a dependency is no longer correct, remove_task_dependency.",
        "11. Attach important artifacts with add_task_attachment when they would help review, handoff, or future execution.",
        "12. If you create or materially change a large or central repository file that should stay visible on the task — such as a design doc, architecture note, ADR, diagram source, migration plan, runbook, or other non-source artifact — record it with add_task_file_reference.",
        "13. Do not add normal source code or test file edits as task file references unless the human explicitly asked for that file to be tracked on the task.",
        "14. Use list_task_comments when you need the full threaded discussion instead of only the recent comment summary in task context.",
        "15. If you need to come back to something after a short wait, external delay, or timed checkpoint, call remind_me with a concrete message and a delay in seconds or minutes so Orchestra can re-prompt you later.",
        "16. Before you transition the task or request help, add a comment explaining exactly what happened, what changed, and why you are choosing that transition or asking for help.",
        "17. Immediately before any completion tool, call list_unfinished_task_todos for the canonical task ID and current lane. Finish or explicitly reopen every remaining lane todo before you try to transition.",
        "18. When the lane is finished, explicitly transition it with the correct completion tool.",
    ]
    .join("\n")
}

fn orchestra_tool_help_block() -> String {
    [
        "Available Orchestra task tools and exactly how to use them:",
        "- These names are real Orchestra tools/functions exposed in this session. You must invoke them as tool calls, not merely mention them in prose.",
        "- get_task_context(taskId): Call this tool when you need the freshest full task state. Use it before making decisions if comments, attachments, dependencies, subtasks, or assignment state may have changed.",
        "- list_task_comments(taskId): Call this tool when you need the full threaded task discussion, including replies and parent-child comment relationships.",
        "- list_task_todos(taskId): Call this tool to inspect every todo recorded on the task across lanes.",
        "- list_unfinished_task_todos(taskId, laneId?): Call this tool to inspect only unfinished todos. Use it before any completion tool, usually scoped to the current lane.",
        "- get_task_repositories(taskId): Call this tool to list the task-associated repositories and their current workspace paths before you read or modify repository files.",
        "- list_task_file_references(taskId): Call this tool to inspect which repository files are already tracked on the task before adding more.",
        "- add_task_file_reference(taskId, repositoryId, relativePath): Call this tool when you create or materially change a large or central repository file that should stay visible on the task. Provide the repository id plus a repository-relative path such as docs/design.md. Good candidates are design docs, diagrams, plans, ADRs, runbooks, and similar non-source artifacts. Do not use this for ordinary source code changes unless explicitly asked.",
        "- remove_task_file_reference(referenceId): Call this tool if a tracked repository file reference is no longer relevant or was added by mistake.",
        "- comment_on_task(taskId, author, message, interruptAgent?, parentCommentId?): Call this tool to leave a durable note in Orchestra. Set parentCommentId when you are replying to a specific existing comment so the discussion stays threaded.",
        "- get_unread_task_comments(taskId): Call this tool whenever you resume work, when Orchestra tells you to check unread mail, and again immediately before any completion tool. It returns task comments you have not yet acknowledged for the active session.",
        "- mark_task_comments_read(taskId, commentIds?): After you read and incorporate unread task comments, call this tool to acknowledge them. If commentIds is omitted, it marks all current unread comments for the active session as read.",
        "- get_unread_mail(taskId?): Call this tool whenever you resume work, when Orchestra tells you to check mail, and again immediately before any completion tool. With a taskId it includes both the active assignment mailbox and any direct unread agent mail for the current worker; without taskId it returns direct unread mail for the current worker session.",
        "- mark_mail_read(taskId?, deliveryIds?): After you read and handle unread mail, call this tool to acknowledge it. If deliveryIds is omitted, it marks all currently visible unread mail for the worker session as read.",
        "- send_mail(projectId?, taskId?, recipientType, recipientId?, body, priority?): Call this tool to send mailbox messages to the user, another agent, or the active assignment mailbox for a task. Use recipientType user, agent, or active_assignment. Set priority to interrupt when the recipient should be steered immediately.",
        "- remind_me(message, delaySeconds? | delayMinutes?): Call this tool to schedule a message back to yourself after a short delay. Use it when you need Orchestra to nudge you after waiting, polling, or giving another process time to finish.",
        "- add_task_todo(taskId?, input): Call this tool when you discover a smaller follow-up item that should remain visible on the task but does not deserve its own subtask. Always provide input.laneId explicitly; in a worker session you may omit taskId to use the current task, but worker-owned sessions may target only their current lane or directly connected workflow handoff lanes.",
        "- mark_task_todo_finished(todoId): Call this tool as soon as a todo item is complete so Orchestra knows the lane is closer to done.",
        "- mark_task_todo_unfinished(todoId): Call this tool if a previously completed todo becomes relevant again or needs rework.",
        "- create_subtask(parent_task_id, input): Call this tool when the current task should be broken into a separately tracked child task. Make the title/action clear and specific so the new task can stand on its own.",
        "- add_task_dependency(blocker_task_id, blocked_task_id): Call this tool when another task must be completed before the current one can proceed safely.",
        "- remove_task_dependency(dependency_id): Call this tool only when an existing blocking relationship is no longer true.",
        "- add_task_attachment(task_id, input): Call this tool for artifacts that matter to execution or review, such as notes, logs, screenshots, examples, or generated outputs.",
        "- remove_task_attachment(attachment_id): Call this tool only to clean up an attachment that is incorrect, outdated, or should not remain attached.",
        "- complete_lane_as_success(task_id, notes?): Call this tool when you finished the lane's goal and the task should follow the workflow's success transition.",
        "- complete_lane_as_failure(task_id, notes?): Call this tool when you attempted the lane but the correct workflow outcome is failure, so Orchestra should follow the failure transition.",
        "- request_user_intervention(task_id, notes?): Call this tool when you are blocked, missing information or permissions, hit a failing transition/completion step, or need a human decision before proceeding.",
    ]
    .join("\n")
}

fn orchestra_completion_rules_block() -> String {
    [
        "Critical completion rules:",
        "- You must end this lane by invoking exactly one Orchestra completion tool: complete_lane_as_success, complete_lane_as_failure, or request_user_intervention.",
        "- You are not done and cannot stop until you have actually called one of those tools.",
        "- Immediately before any completion tool, call get_unread_task_comments for the canonical task ID, review any unread comments, and then call mark_task_comments_read before completing the lane.",
        "- Immediately before any completion tool, call get_unread_mail for the canonical task ID, review any unread mail, and then call mark_mail_read before completing the lane.",
        "- Immediately before any completion tool, call list_unfinished_task_todos for the canonical task ID and current lane. Finish or intentionally reopen every remaining lane todo before you transition.",
        "- If any completion or transition step fails, add a task comment describing the failure and then call request_user_intervention instead of silently stopping.",
        "- If you are unsure whether the lane is complete, refresh with get_task_context, leave a comment explaining the uncertainty, and then choose the correct transition deliberately.",
        "- Do not just summarize what you would do. Actually call the Orchestra tools to update the task state and leave comments that explain what happened and why.",
    ]
    .join("\n")
}

fn slugify_task_title(value: &str) -> String {
    let normalized = value
        .trim()
        .to_lowercase()
        .replace(|ch: char| !ch.is_ascii_alphanumeric(), "-");
    let collapsed = normalized
        .split('-')
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        "task".into()
    } else {
        collapsed
    }
}

fn optional_section(title: &str, body: Option<String>) -> String {
    body.filter(|value| !value.trim().is_empty())
        .map(|value| format!("{}:\n{}", title, value.trim()))
        .unwrap_or_default()
}

fn render_recent_task_comments(comments: &[TaskComment], limit: usize) -> String {
    if comments.is_empty() {
        return String::new();
    }

    let recent_comments = comments
        .iter()
        .rev()
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    let recent_ids = recent_comments
        .iter()
        .map(|comment| comment.id.as_str())
        .collect::<std::collections::HashSet<_>>();
    let mut rendered = Vec::new();

    for comment in comments
        .iter()
        .filter(|comment| recent_ids.contains(comment.id.as_str()))
    {
        if comment.parent_comment_id.is_some() {
            continue;
        }
        let anchor_label = comment
            .relative_path
            .as_deref()
            .zip(comment.line_start)
            .map(|(path, line_start)| {
                let line_end = comment.line_end.unwrap_or(line_start);
                if line_start == line_end {
                    format!(" ({path} line {line_start})")
                } else {
                    format!(" ({path} lines {line_start}-{line_end})")
                }
            })
            .unwrap_or_default();
        rendered.push(format!(
            "- {}{}: {}",
            comment.author, anchor_label, comment.message
        ));
        if let Some(selected_text) = comment.selected_text.as_deref() {
            rendered.push(format!("  ↳ selected text: {}", selected_text));
        }
        for reply in comments.iter().filter(|reply| {
            reply.parent_comment_id.as_deref() == Some(comment.id.as_str())
                && recent_ids.contains(reply.id.as_str())
        }) {
            let reply_anchor_label = reply
                .relative_path
                .as_deref()
                .zip(reply.line_start)
                .map(|(path, line_start)| {
                    let line_end = reply.line_end.unwrap_or(line_start);
                    if line_start == line_end {
                        format!(" ({path} line {line_start})")
                    } else {
                        format!(" ({path} lines {line_start}-{line_end})")
                    }
                })
                .unwrap_or_default();
            rendered.push(format!(
                "  ↳ {}{}: {}",
                reply.author, reply_anchor_label, reply.message
            ));
            if let Some(selected_text) = reply.selected_text.as_deref() {
                rendered.push(format!("    ↳ selected text: {}", selected_text));
            }
        }
    }

    rendered.join("\n")
}

fn build_worker_context_block(worker_prompt: Option<&WorkerPromptContext>) -> String {
    let Some(worker_prompt) = worker_prompt else {
        return String::new();
    };

    let mut sections = vec![format!(
        "Assigned worker: {} {} ({})",
        worker_prompt.worker_type_label, worker_prompt.worker_name, worker_prompt.worker_slug,
    )];

    let mut worker_sections = Vec::new();
    if let Some(system_prompt) = worker_prompt
        .system_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        worker_sections.push(format!(
            "Base {} prompt:\n{}",
            worker_prompt.worker_type_label,
            system_prompt.trim()
        ));
    }
    if let Some(overlay_prompt) = worker_prompt
        .project_overlay_prompt
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        worker_sections.push(format!(
            "Project-specific {} overlay prompt:\n{}",
            worker_prompt.worker_type_label,
            overlay_prompt.trim()
        ));
    }
    if !worker_sections.is_empty() {
        sections.push(format!(
            "Worker-specific prompt context — follow this together with the lane instructions below:\n{}",
            worker_sections.join("\n\n")
        ));
    }

    sections.join("\n\n")
}

fn build_lane_prompt(
    connection: &Connection,
    task: &TaskDetail,
    workflow: &WorkflowDefinition,
    lane: &WorkflowLane,
    task_workspace_cwd: Option<&str>,
    worker_prompt: Option<&WorkerPromptContext>,
) -> String {
    let project_slug = projects::get_project(connection, &task.project_id)
        .map(|project| project.slug)
        .unwrap_or_else(|_| "orchestra".into());
    let orchestra_root = crate::services::orchestra_paths::default_orchestra_root().ok();
    let prompt_settings = project_settings::get_session_prompt_settings_with_connection(
        connection,
        orchestra_root.as_deref(),
        &project_slug,
    )
    .unwrap_or_else(|_| crate::models::ProjectSessionPromptSettings {
        project_slug: project_slug.clone(),
        template: project_settings::default_task_session_context_template(),
        default_template: project_settings::default_task_session_context_template(),
        available_tokens: project_settings::available_session_prompt_tokens(),
        updated_at: None,
    });
    let source_control_context = worker_prompt
        .map(|worker_prompt| {
            if worker_prompt.worker_type == "role" {
                project_settings::SourceControlTemplateContext {
                    role_slug: Some(worker_prompt.worker_slug.clone()),
                    agent_slug: None,
                }
            } else {
                project_settings::SourceControlTemplateContext {
                    role_slug: None,
                    agent_slug: Some(worker_prompt.worker_slug.clone()),
                }
            }
        })
        .unwrap_or_default();
    let resolved_source_control =
        project_settings::resolve_effective_source_control_settings_with_connection(
            connection,
            orchestra_root.as_deref(),
            Some(&project_slug),
            &source_control_context,
        )
        .unwrap_or_default();
    let source_control_context_block =
        project_settings::render_source_control_context_block(&resolved_source_control);

    let blocked_by_block = if task.blocked_by.is_empty() {
        String::new()
    } else {
        task.blocked_by
            .iter()
            .map(|dependency| {
                format!(
                    "- {} — {}",
                    dependency.blocker.number, dependency.blocker.title
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let repositories_block = if task.task_repositories.is_empty() {
        String::new()
    } else {
        task.task_repositories
            .iter()
            .map(|repository| {
                let workspace_path = task_workspace_cwd.map(|workspace_root| {
                    task_repositories::task_repository_worktree_path(
                        workspace_root,
                        &repository.repository_slug,
                    )
                });
                match workspace_path.as_deref() {
                    Some(path) => format!(
                        "- {} ({}) available in this session at {}",
                        repository.repository_name, repository.repository_slug, path
                    ),
                    None => format!(
                        "- {} ({}) managed source at {}",
                        repository.repository_name,
                        repository.repository_slug,
                        repository.managed_repository_path.as_deref().unwrap_or("—")
                    ),
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let file_references_block = if task.file_references.is_empty() {
        String::new()
    } else {
        task.file_references
            .iter()
            .map(|reference| {
                let status = if reference.exists {
                    "available"
                } else {
                    "missing"
                };
                match reference.absolute_path.as_deref() {
                    Some(path) => format!(
                        "- {}/{} ({}) at {}",
                        reference.repository_slug, reference.relative_path, status, path
                    ),
                    None => format!(
                        "- {}/{} ({})",
                        reference.repository_slug, reference.relative_path, status
                    ),
                }
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let attachments_block = if task.attachments.is_empty() {
        String::new()
    } else {
        task.attachments
            .iter()
            .map(|attachment| {
                format!(
                    "- {} ({}) at {}",
                    attachment.file_name, attachment.media_type, attachment.stored_path
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let comments_block = render_recent_task_comments(&task.comments, 5);
    let todos_block = if task.todos.is_empty() {
        "No task todos recorded yet.".to_string()
    } else {
        task.todos
            .iter()
            .map(|todo| {
                format!(
                    "- [{}] {} ({})",
                    if todo.completed { "x" } else { " " },
                    todo.description,
                    todo.lane_id
                )
            })
            .collect::<Vec<_>>()
            .join("\n")
    };

    let mut rendered = prompt_settings.template;
    let template_has_explicit_source_control_tokens = rendered.contains("{SOURCE_CONTROL.");
    let worker_context_block = build_worker_context_block(worker_prompt);
    let worker_context_with_source_control_fallback = if template_has_explicit_source_control_tokens
    {
        worker_context_block.clone()
    } else {
        [
            worker_context_block.as_str(),
            source_control_context_block.as_str(),
        ]
        .into_iter()
        .filter(|value| !value.trim().is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
    };
    let replacements = vec![
        ("{TASK.ID}", task.id.clone()),
        ("{TASK.NUMBER}", task.number.clone()),
        ("{TASK.SLUG}", slugify_task_title(&task.title)),
        ("{TASK.NAME}", task.title.clone()),
        ("{TASK.STATUS}", task.status.clone()),
        (
            "{TASK.ASSIGNEE}",
            task.assignee_id
                .clone()
                .unwrap_or_else(|| task.assignee_type.clone()),
        ),
        (
            "{TASK.DESCRIPTION}",
            optional_section("Task description", task.description.clone()),
        ),
        (
            "{TASK.COMMENTS}",
            optional_section("Recent task comments", Some(comments_block)),
        ),
        (
            "{TASK.BLOCKED_BY}",
            optional_section("Blocking tasks", Some(blocked_by_block)),
        ),
        (
            "{TASK.REPOSITORIES}",
            optional_section(
                "Task repositories associated to this task",
                Some(repositories_block),
            ),
        ),
        (
            "{TASK.FILE_REFERENCES}",
            optional_section(
                "Referenced project files (live repository files, not imported snapshots)",
                Some(file_references_block),
            ),
        ),
        (
            "{TASK.ATTACHMENTS}",
            optional_section("Task attachments", Some(attachments_block)),
        ),
        (
            "{TASK.TODOS}",
            optional_section("Task todos", Some(todos_block)),
        ),
        ("{WORKFLOW.NAME}", workflow.name.clone()),
        ("{LANE.NAME}", lane.name.clone()),
        ("{LANE.OWNER}", lane.assigned_entity_type.clone()),
        (
            "{LANE.INSTRUCTION}",
            optional_section(
                "Lane-specific instruction",
                lane.entry_prompt_template.clone(),
            ),
        ),
        (
            "{WORKER.CONTEXT}",
            worker_context_with_source_control_fallback,
        ),
        ("{SOURCE_CONTROL.CONTEXT}", source_control_context_block),
        (
            "{SOURCE_CONTROL.GIT.USER_NAME}",
            resolved_source_control
                .git_user_name
                .clone()
                .unwrap_or_default(),
        ),
        (
            "{SOURCE_CONTROL.GIT.EMAIL}",
            resolved_source_control
                .git_email
                .clone()
                .unwrap_or_default(),
        ),
        (
            "{RUNTIME.CWD}",
            task_workspace_cwd.unwrap_or("").to_string(),
        ),
        ("{ORCHESTRA.WORKING_RULES}", orchestra_working_rules_block()),
        ("{ORCHESTRA.TOOL_HELP}", orchestra_tool_help_block()),
        (
            "{ORCHESTRA.COMPLETION_RULES}",
            orchestra_completion_rules_block(),
        ),
    ];

    for (token, value) in replacements {
        rendered = rendered.replace(token, &value);
    }

    if lane.require_user_approval_on_success
        && matches!(lane.assigned_entity_type.as_str(), "agent" | "role")
    {
        rendered.push_str("\n\nThis lane requires user approval after you report success. When you call complete_lane_as_success, Orchestra will pause the task for human review on this same lane until the user either approves it or sends it back for more work.");
    }

    rendered
        .lines()
        .map(str::trim_end)
        .collect::<Vec<_>>()
        .join("\n")
        .replace("\n\n\n", "\n\n")
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn read_assignment(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLaneAssignment> {
    Ok(TaskLaneAssignment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        workflow_id: row.get(2)?,
        lane_id: row.get(3)?,
        worker_type: row.get(4)?,
        worker_id: row.get(5)?,
        status: row.get(6)?,
        session_id: row.get(7)?,
        runtime_cwd: row.get(8)?,
        role_queue_entry_id: row.get(9)?,
        role_instance_id: row.get(10)?,
        prompt: row.get(11)?,
        pending_outcome: row.get(12)?,
        completion_notes: row.get(13)?,
        whip_count: row.get(14)?,
        last_whip_at: row.get(15)?,
        started_at: row.get(16)?,
        completed_at: row.get(17)?,
        created_at: row.get(18)?,
        updated_at: row.get(19)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::{self, File},
        io::Write,
        path::Path,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::{
        models::{
            AgentUpsertInput, RoleUpsertInput, TaskDetail, TaskLaneAssignment, TaskUpsertInput,
            WorkflowLaneInput, WorkflowUpsertInput,
        },
        services::{
            agents, database, pi_sessions, projects, roles, session_list, tasks, workflows,
        },
    };

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn ensure_default_project(connection: &Connection) {
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("default project should seed");
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        ))
    }

    fn init_test_repo(label: &str) -> PathBuf {
        let root = unique_temp_dir(label);
        let repo = root.join("repository");
        fs::create_dir_all(&repo).expect("repository dir should create");
        fs::create_dir_all(root.join("sessions")).expect("session dir should create");

        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "-b", "main"])
            .status()
            .expect("git init should run")
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .expect("git config email should run")
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "user.name", "Test User"])
            .status()
            .expect("git config name should run")
            .success());

        let mut file = File::create(repo.join("README.md")).expect("README should create");
        writeln!(file, "test repo").expect("README should write");

        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "README.md"])
            .status()
            .expect("git add should run")
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-m", "init"])
            .status()
            .expect("git commit should run")
            .success());

        repo
    }

    fn build_test_task_detail(
        status: &str,
        assignee_type: &str,
        current_lane_id: Option<&str>,
    ) -> TaskDetail {
        let now = now_iso();
        TaskDetail {
            id: "task-test".into(),
            project_id: "project-test".into(),
            number: "ORC-TEST".into(),
            title: "Test task".into(),
            description: None,
            task_type: "task".into(),
            tags: Vec::new(),
            status: status.into(),
            priority: "P2".into(),
            workflow_id: Some("workflow-test".into()),
            current_lane_id: current_lane_id.map(|value| value.to_string()),
            assignee_type: assignee_type.into(),
            assignee_id: None,
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: 10,
            archived: false,
            comment_count: 0,
            unread_comment_count: 0,
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
            active_lane_assignment_status: None,
            ready_for_dispatch: false,
            parent: None,
            lineage: Vec::new(),
            children: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            attachments: Vec::new(),
            task_repositories: Vec::new(),
            file_references: Vec::new(),
            comments: Vec::new(),
            todos: Vec::new(),
            lane_runs: Vec::new(),
            active_lane_assignment: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn build_test_task_lane_assignment(status: &str, pending_outcome: Option<&str>) -> TaskLaneAssignment {
        let now = now_iso();
        TaskLaneAssignment {
            id: "assignment-test".into(),
            task_id: "task-test".into(),
            workflow_id: "workflow-test".into(),
            lane_id: "lane-test".into(),
            worker_type: "role".into(),
            worker_id: Some("developer".into()),
            status: status.into(),
            session_id: Some("session-test".into()),
            runtime_cwd: None,
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: None,
            pending_outcome: pending_outcome.map(|value| value.to_string()),
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: now.clone(),
            completed_at: None,
            created_at: now.clone(),
            updated_at: now,
        }
    }

    fn create_workflow_with_lanes(
        connection: &mut Connection,
        role_slug: &str,
        agent_slug: &str,
    ) -> crate::models::WorkflowDefinition {
        workflows::create_workflow(
            connection,
            WorkflowUpsertInput {
                name: "Runtime Flow".into(),
                description: None,
                lanes: vec![
                    WorkflowLaneInput {
                        id: Some("lane-plan".into()),
                        key: "plan".into(),
                        name: "Plan".into(),
                        description: None,
                        order: Some(0),
                        assigned_entity_type: "user".into(),
                        assigned_entity_id: None,
                        entry_prompt_template: Some("Draft the plan.".into()),
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "lane".into(),
                        success_target_lane_id: Some("lane-implement".into()),
                        failure_transition_type: "user_intervention".into(),
                        failure_target_lane_id: None,
                    },
                    WorkflowLaneInput {
                        id: Some("lane-implement".into()),
                        key: "implement".into(),
                        name: "Implement".into(),
                        description: None,
                        order: Some(1),
                        assigned_entity_type: "role".into(),
                        assigned_entity_id: Some(role_slug.into()),
                        entry_prompt_template: Some("Implement the task.".into()),
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "lane".into(),
                        success_target_lane_id: Some("lane-review".into()),
                        failure_transition_type: "lane".into(),
                        failure_target_lane_id: Some("lane-plan".into()),
                    },
                    WorkflowLaneInput {
                        id: Some("lane-review".into()),
                        key: "review".into(),
                        name: "Review".into(),
                        description: None,
                        order: Some(2),
                        assigned_entity_type: "agent".into(),
                        assigned_entity_id: Some(agent_slug.into()),
                        entry_prompt_template: Some(
                            "Review the work and summarize findings.".into(),
                        ),
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "end".into(),
                        success_target_lane_id: None,
                        failure_transition_type: "lane".into(),
                        failure_target_lane_id: Some("lane-implement".into()),
                    },
                ],
            },
        )
        .expect("workflow should create")
    }

    fn insert_project_and_repository(
        connection: &Connection,
        project_id: &str,
        project_slug: &str,
        repo_id: &str,
        repo_slug: &str,
        repo_name: &str,
        repo_root: &Path,
    ) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'ORC', ?4, ?5, ?5)",
                params![project_id, project_slug, project_slug, repo_id, now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'main', ?6, ?6)",
                params![
                    repo_id,
                    project_id,
                    repo_slug,
                    repo_name,
                    repo_root.display().to_string(),
                    now.as_str()
                ],
            )
            .expect("repository should insert");
    }

    #[test]
    fn lane_prompt_lists_tools_and_requires_an_explicit_transition() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let now = now_iso();
        let repo_root = unique_temp_dir("task-runtime-file-reference");
        std::fs::create_dir_all(repo_root.join("docs")).expect("docs dir should create");
        std::fs::write(repo_root.join("docs/design.md"), "# Design\n")
            .expect("design file should write");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', 'repo-prompt', ?1, ?1)",
                params![now],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-prompt', 'orchestra', 'orchestra', 'Orchestra repository', ?1, NULL, 'main', ?2, ?2)",
                params![repo_root.display().to_string(), now],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Prompt rules task".into(),
                description: Some("Exercise the generated lane prompt.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-prompt".into()),
                repository_ids: vec!["repo-prompt".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        crate::services::task_file_references::add_task_file_reference(
            &mut connection,
            &task.id,
            crate::models::TaskFileReferenceInput {
                repository_id: "repo-prompt".into(),
                relative_path: "docs/design.md".into(),
            },
        )
        .expect("file reference should add");

        let task =
            tasks::get_task_context(&connection, &task.id).expect("task context should load");
        let lane = workflow
            .lanes
            .iter()
            .find(|lane| lane.id == "lane-implement")
            .cloned()
            .expect("implement lane should exist");

        let prompt = build_lane_prompt(
            &connection,
            &task,
            &workflow,
            &lane,
            Some(repo_root.to_string_lossy().as_ref()),
            None,
        );
        assert!(prompt.contains("You are an agent working inside Orchestra"));
        assert!(prompt.contains("Canonical task ID:"));
        assert!(prompt.contains("- Workflow: the overall process definition attached to a task."));
        assert!(prompt.contains("- Lane: the current step of the workflow."));
        assert!(prompt.contains("How to work effectively in this session:"));
        assert!(prompt.contains(
            "2. Immediately call get_task_context using the canonical task ID shown above"
        ));
        assert!(prompt.contains("Task repositories associated to this task:"));
        assert!(prompt.contains("Orchestra repository"));
        assert!(prompt
            .contains("Referenced project files (live repository files, not imported snapshots):"));
        assert!(prompt.contains("docs/design.md"));
        assert!(prompt.contains("Available Orchestra task tools and exactly how to use them:"));
        assert!(prompt
            .contains("These names are real Orchestra tools/functions exposed in this session."));
        assert!(prompt.contains("- get_task_context(taskId): Call this tool"));
        assert!(prompt.contains("- get_task_repositories(taskId): Call this tool"));
        assert!(prompt.contains("- list_task_file_references(taskId): Call this tool to inspect which repository files are already tracked on the task before adding more."));
        assert!(prompt.contains("- add_task_file_reference(taskId, repositoryId, relativePath): Call this tool when you create or materially change a large or central repository file that should stay visible on the task."));
        assert!(prompt.contains("- remove_task_file_reference(referenceId): Call this tool if a tracked repository file reference is no longer relevant or was added by mistake."));
        assert!(prompt.contains("- list_task_comments(taskId): Call this tool when you need the full threaded task discussion"));
        assert!(prompt.contains("- list_task_todos(taskId): Call this tool to inspect every todo recorded on the task across lanes."));
        assert!(prompt.contains("- list_unfinished_task_todos(taskId, laneId?): Call this tool to inspect only unfinished todos."));
        assert!(prompt.contains("- add_task_todo(taskId?, input): Call this tool when you discover a smaller follow-up item"));
        assert!(prompt.contains("Always provide input.laneId explicitly"));
        assert!(prompt.contains(
            "- mark_task_todo_finished(todoId): Call this tool as soon as a todo item is complete"
        ));
        assert!(prompt.contains("- mark_task_todo_unfinished(todoId): Call this tool if a previously completed todo becomes relevant again or needs rework."));
        assert!(prompt.contains("- comment_on_task(taskId, author, message, interruptAgent?, parentCommentId?): Call this tool to leave a durable note in Orchestra."));
        assert!(prompt.contains("call get_unread_task_comments using the canonical task ID"));
        assert!(prompt.contains("call mark_task_comments_read so Orchestra knows you saw them"));
        assert!(prompt.contains("call get_unread_mail using the canonical task ID"));
        assert!(prompt.contains("call mark_mail_read so Orchestra knows you handled it"));
        assert!(prompt.contains("Whenever you take or finish a large action, leave a durable comment with comment_on_task"));
        assert!(prompt.contains("add it with add_task_todo and an explicit laneId target"));
        assert!(prompt.contains("If you create or materially change a large or central repository file that should stay visible on the task"));
        assert!(prompt.contains("Do not add normal source code or test file edits as task file references unless the human explicitly asked"));
        assert!(prompt.contains("Before you transition the task or request help, add a comment explaining exactly what happened"));
        assert!(prompt.contains(
            "- get_unread_task_comments(taskId): Call this tool whenever you resume work"
        ));
        assert!(prompt.contains("- mark_task_comments_read(taskId, commentIds?): After you read and incorporate unread task comments"));
        assert!(
            prompt.contains("- get_unread_mail(taskId?): Call this tool whenever you resume work")
        );
        assert!(prompt.contains(
            "- mark_mail_read(taskId?, deliveryIds?): After you read and handle unread mail"
        ));
        assert!(prompt.contains("- complete_lane_as_success(task_id, notes?): Call this tool"));
        assert!(prompt.contains("- complete_lane_as_failure(task_id, notes?): Call this tool"));
        assert!(prompt.contains("- request_user_intervention(task_id, notes?): Call this tool"));
        assert!(prompt
            .contains("You must end this lane by invoking exactly one Orchestra completion tool"));
        assert!(prompt
            .contains("Immediately before any completion tool, call get_unread_task_comments"));
        assert!(prompt.contains("Immediately before any completion tool, call get_unread_mail"));
        assert!(prompt
            .contains("Immediately before any completion tool, call list_unfinished_task_todos"));
        assert!(prompt.contains(
            "If any completion or transition step fails, add a task comment describing the failure"
        ));
        assert!(prompt.contains("Do not just summarize what you would do. Actually call the Orchestra tools to update the task state and leave comments that explain what happened and why."));
    }

    #[test]
    fn lane_prompt_includes_worker_specific_prompt_context() {
        let task = TaskDetail {
            id: "task-123".into(),
            project_id: "project-1".into(),
            number: "ORC-123".into(),
            title: "Investigate runtime prompt".into(),
            description: Some("Confirm prompt assembly includes worker instructions.".into()),
            task_type: "task".into(),
            tags: Vec::new(),
            status: "ready".into(),
            priority: "P1".into(),
            workflow_id: Some("workflow-1".into()),
            current_lane_id: Some("lane-1".into()),
            assignee_type: "role".into(),
            assignee_id: Some("role-1".into()),
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: 10,
            archived: false,
            comment_count: 0,
            unread_comment_count: 0,
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
            active_lane_assignment_status: None,
            ready_for_dispatch: true,
            parent: None,
            lineage: Vec::new(),
            children: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            attachments: Vec::new(),
            task_repositories: Vec::new(),
            file_references: Vec::new(),
            active_lane_assignment: None,
            created_at: "2026-03-22T00:00:00Z".into(),
            updated_at: "2026-03-22T00:00:00Z".into(),
            comments: Vec::new(),
            todos: Vec::new(),
            lane_runs: Vec::new(),
        };
        let workflow = WorkflowDefinition {
            id: "workflow-1".into(),
            slug: "runtime-flow".into(),
            name: "Runtime Flow".into(),
            description: None,
            archived: false,
            lanes: Vec::new(),
            created_at: "2026-03-22T00:00:00Z".into(),
            updated_at: "2026-03-22T00:00:00Z".into(),
        };
        let lane = WorkflowLane {
            id: "lane-1".into(),
            key: "implement".into(),
            name: "Implement".into(),
            description: None,
            order: 0,
            assigned_entity_type: "role".into(),
            assigned_entity_id: Some("developer".into()),
            entry_prompt_template: Some("Ship the fix.".into()),
            use_separate_worktree: false,
            require_user_approval_on_success: false,
            success_transition_type: "end".into(),
            success_target_lane_id: None,
            failure_transition_type: "user_intervention".into(),
            failure_target_lane_id: None,
        };
        let worker_prompt = WorkerPromptContext {
            worker_type: "role",
            worker_type_label: "role",
            worker_name: "Developer".into(),
            worker_slug: "developer".into(),
            system_prompt: Some("You implement production-ready changes carefully.".into()),
            project_overlay_prompt: Some(
                "In Orchestra, prefer task-aware comments before transitions.".into(),
            ),
        };

        let connection = in_memory_connection();

        let prompt = build_lane_prompt(
            &connection,
            &task,
            &workflow,
            &lane,
            Some("/tmp/runtime"),
            Some(&worker_prompt),
        );

        assert!(prompt.contains("Assigned worker: role Developer (developer)"));
        assert!(prompt.contains("Worker-specific prompt context — follow this together with the lane instructions below:"));
        assert!(
            prompt.contains("Base role prompt:\nYou implement production-ready changes carefully.")
        );
        assert!(prompt.contains("Project-specific role overlay prompt:\nIn Orchestra, prefer task-aware comments before transitions."));
        assert!(prompt.contains("Lane-specific instruction:\nShip the fix."));
    }

    #[test]
    fn lane_prompt_uses_project_session_prompt_template_tokens() {
        let mut connection = in_memory_connection();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'prompt-project', 'Prompt Project', NULL, 'PRM', NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should insert");

        project_settings::update_session_prompt_settings_with_connection(
            &connection,
            None,
            "prompt-project",
            Some("Task {TASK.ID} {TASK.SLUG} {TASK.NAME} {WORKFLOW.NAME} {LANE.NAME} {LANE.OWNER} {TASK.STATUS} {TASK.ASSIGNEE}\n{TASK.DESCRIPTION}\n{TASK.COMMENTS}".into()),
        )
        .expect("session prompt template should save");

        let task = TaskDetail {
            id: "task-123".into(),
            project_id: "project-1".into(),
            number: "ORC-123".into(),
            title: "Investigate runtime prompt".into(),
            description: Some("Describe the task.".into()),
            task_type: "task".into(),
            tags: Vec::new(),
            status: "in_review".into(),
            priority: "P1".into(),
            workflow_id: Some("workflow-1".into()),
            current_lane_id: Some("lane-1".into()),
            assignee_type: "user".into(),
            assignee_id: Some("Data".into()),
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: 10,
            archived: false,
            comment_count: 1,
            unread_comment_count: 0,
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
            active_lane_assignment_status: None,
            ready_for_dispatch: false,
            parent: None,
            lineage: Vec::new(),
            children: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            attachments: Vec::new(),
            task_repositories: Vec::new(),
            file_references: Vec::new(),
            active_lane_assignment: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            comments: vec![crate::models::TaskComment {
                id: "comment-1".into(),
                task_id: "task-123".into(),
                parent_comment_id: None,
                author: "Reviewer".into(),
                origin_type: "user".into(),
                origin_id: None,
                message: "Check the prompt template output.".into(),
                interrupt_agent: false,
                repository_id: None,
                relative_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
                anchor_commit_hash: None,
                anchor_has_uncommitted_changes: None,
                created_at: now.clone(),
                updated_at: now.clone(),
            }],
            todos: Vec::new(),
            lane_runs: Vec::new(),
        };
        let workflow = WorkflowDefinition {
            id: "workflow-1".into(),
            slug: "runtime-flow".into(),
            name: "Runtime Flow".into(),
            description: None,
            archived: false,
            lanes: Vec::new(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let lane = WorkflowLane {
            id: "lane-1".into(),
            key: "review".into(),
            name: "Review".into(),
            description: None,
            order: 0,
            assigned_entity_type: "user".into(),
            assigned_entity_id: None,
            entry_prompt_template: None,
            use_separate_worktree: false,
            require_user_approval_on_success: false,
            success_transition_type: "end".into(),
            success_target_lane_id: None,
            failure_transition_type: "end".into(),
            failure_target_lane_id: None,
        };

        let prompt = build_lane_prompt(
            &connection,
            &task,
            &workflow,
            &lane,
            Some("/tmp/runtime"),
            None,
        );
        assert!(prompt.contains("Task task-123 investigate-runtime-prompt Investigate runtime prompt Runtime Flow Review user in_review Data"));
        assert!(prompt.contains("Task description:\nDescribe the task."));
        assert!(
            prompt.contains("Recent task comments:\n- Reviewer: Check the prompt template output.")
        );
    }

    #[test]
    fn lane_prompt_includes_explicit_source_control_tokens() {
        let mut connection = in_memory_connection();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-source-control', 'source-control-project', 'Source Control Project', NULL, 'SCP', NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should insert");
        project_settings::update_source_control_settings_with_connection(
            &connection,
            Some("Global {role}{agent}".into()),
            Some("global+{role}{agent}@example.com".into()),
        )
        .expect("global source control settings should save");
        project_settings::update_project_source_control_settings_with_connection(
            &connection,
            None,
            "source-control-project",
            None,
            Some("project+{role}{agent}@example.com".into()),
        )
        .expect("project source control settings should save");
        project_settings::update_session_prompt_settings_with_connection(
            &connection,
            None,
            "source-control-project",
            Some("{WORKER.CONTEXT}\n{SOURCE_CONTROL.CONTEXT}\nname={SOURCE_CONTROL.GIT.USER_NAME}\nemail={SOURCE_CONTROL.GIT.EMAIL}".into()),
        )
        .expect("prompt template should save");

        let task = TaskDetail {
            id: "task-source-control".into(),
            project_id: "project-source-control".into(),
            number: "SCP-1".into(),
            title: "Check source control prompt tokens".into(),
            description: None,
            task_type: "task".into(),
            tags: Vec::new(),
            status: "in_progress".into(),
            priority: "P1".into(),
            workflow_id: Some("workflow-source-control".into()),
            current_lane_id: Some("lane-source-control".into()),
            assignee_type: "role".into(),
            assignee_id: Some("developer".into()),
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: 10,
            archived: false,
            comment_count: 0,
            unread_comment_count: 0,
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
            active_lane_assignment_status: None,
            ready_for_dispatch: false,
            parent: None,
            lineage: Vec::new(),
            children: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            attachments: Vec::new(),
            task_repositories: Vec::new(),
            file_references: Vec::new(),
            active_lane_assignment: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            comments: Vec::new(),
            todos: Vec::new(),
            lane_runs: Vec::new(),
        };
        let workflow = WorkflowDefinition {
            id: "workflow-source-control".into(),
            slug: "workflow-source-control".into(),
            name: "Source Control Flow".into(),
            description: None,
            archived: false,
            lanes: Vec::new(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let lane = WorkflowLane {
            id: "lane-source-control".into(),
            key: "implement".into(),
            name: "Implement".into(),
            description: None,
            order: 0,
            assigned_entity_type: "role".into(),
            assigned_entity_id: Some("developer".into()),
            entry_prompt_template: None,
            use_separate_worktree: false,
            require_user_approval_on_success: false,
            success_transition_type: "end".into(),
            success_target_lane_id: None,
            failure_transition_type: "end".into(),
            failure_target_lane_id: None,
        };
        let worker_prompt = WorkerPromptContext {
            worker_type: "role",
            worker_type_label: "role",
            worker_name: "Developer".into(),
            worker_slug: "developer".into(),
            system_prompt: None,
            project_overlay_prompt: None,
        };

        let prompt = build_lane_prompt(
            &connection,
            &task,
            &workflow,
            &lane,
            Some("/tmp/runtime-source-control"),
            Some(&worker_prompt),
        );

        assert!(prompt.contains("Source control identity:"));
        assert!(prompt.contains("- git user.name: Global developer (global default)"));
        assert!(
            prompt.contains("- git user.email: project+developer@example.com (project override)")
        );
        assert!(prompt.contains("name=Global developer"));
        assert!(prompt.contains("email=project+developer@example.com"));
    }

    #[test]
    fn lane_prompt_appends_source_control_context_to_worker_context_for_legacy_templates() {
        let mut connection = in_memory_connection();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-legacy-source-control', 'legacy-source-control', 'Legacy Source Control', NULL, 'LSC', NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should insert");
        project_settings::update_source_control_settings_with_connection(
            &connection,
            Some("Global {role}".into()),
            Some("global+{role}@example.com".into()),
        )
        .expect("global source control settings should save");
        project_settings::update_session_prompt_settings_with_connection(
            &connection,
            None,
            "legacy-source-control",
            Some("{WORKER.CONTEXT}".into()),
        )
        .expect("legacy prompt template should save");

        let task = TaskDetail {
            id: "task-legacy-source-control".into(),
            project_id: "project-legacy-source-control".into(),
            number: "LSC-1".into(),
            title: "Legacy source control prompt fallback".into(),
            description: None,
            task_type: "task".into(),
            tags: Vec::new(),
            status: "in_progress".into(),
            priority: "P1".into(),
            workflow_id: Some("workflow-legacy-source-control".into()),
            current_lane_id: Some("lane-legacy-source-control".into()),
            assignee_type: "role".into(),
            assignee_id: Some("developer".into()),
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: 10,
            archived: false,
            comment_count: 0,
            unread_comment_count: 0,
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
            active_lane_assignment_status: None,
            ready_for_dispatch: false,
            parent: None,
            lineage: Vec::new(),
            children: Vec::new(),
            blocked_by: Vec::new(),
            blocking: Vec::new(),
            attachments: Vec::new(),
            task_repositories: Vec::new(),
            file_references: Vec::new(),
            active_lane_assignment: None,
            created_at: now.clone(),
            updated_at: now.clone(),
            comments: Vec::new(),
            todos: Vec::new(),
            lane_runs: Vec::new(),
        };
        let workflow = WorkflowDefinition {
            id: "workflow-legacy-source-control".into(),
            slug: "workflow-legacy-source-control".into(),
            name: "Legacy Flow".into(),
            description: None,
            archived: false,
            lanes: Vec::new(),
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        let lane = WorkflowLane {
            id: "lane-legacy-source-control".into(),
            key: "implement".into(),
            name: "Implement".into(),
            description: None,
            order: 0,
            assigned_entity_type: "role".into(),
            assigned_entity_id: Some("developer".into()),
            entry_prompt_template: None,
            use_separate_worktree: false,
            require_user_approval_on_success: false,
            success_transition_type: "end".into(),
            success_target_lane_id: None,
            failure_transition_type: "end".into(),
            failure_target_lane_id: None,
        };
        let worker_prompt = WorkerPromptContext {
            worker_type: "role",
            worker_type_label: "role",
            worker_name: "Developer".into(),
            worker_slug: "developer".into(),
            system_prompt: Some("Base prompt".into()),
            project_overlay_prompt: None,
        };

        let prompt = build_lane_prompt(
            &connection,
            &task,
            &workflow,
            &lane,
            Some("/tmp/runtime-legacy-source-control"),
            Some(&worker_prompt),
        );

        assert!(prompt.contains("Assigned worker: role Developer (developer)"));
        assert!(prompt.contains("Base role prompt:\nBase prompt"));
        assert!(prompt.contains("Source control identity:"));
        assert!(prompt.contains("- git user.name: Global developer (global default)"));
        assert!(prompt.contains("- git user.email: global+developer@example.com (global default)"));
    }

    #[test]
    fn dispatches_role_lane_and_transitions_to_agent_lane_on_success() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let project_root = init_test_repo("task-runtime-role");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-role', 'orchestra', 'runtime-role', 'Runtime Role Repo', ?1, NULL, 'main', ?2, ?2)",
                params![project_root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Runtime task".into(),
                description: Some("Make runtime orchestration real.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-role".into()),
                repository_ids: vec!["repo-role".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let session_dir = project_root.parent().unwrap().join("sessions");
        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("role lane should dispatch");
        assert_eq!(assignment.worker_type, "role");
        assert!(assignment.session_id.is_some());
        assert!(assignment.role_instance_id.is_some());
        let role_repo_workspace = assignment
            .runtime_cwd
            .as_deref()
            .map(|cwd| task_repositories::task_repository_worktree_path(cwd, "runtime-role"))
            .expect("role runtime cwd should exist");
        assert!(Path::new(&role_repo_workspace).exists());

        let updated = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Implementation finished".into()),
            None,
        )
        .expect("role lane should complete");
        assert_eq!(updated.current_lane_id.as_deref(), Some("lane-review"));
        assert_eq!(updated.assignee_type, "agent");
        assert_eq!(updated.assignee_id.as_deref(), Some(agent.slug.as_str()));
        assert!(updated.active_lane_assignment.is_none());
    }

    #[test]
    fn derives_effective_review_assignment_status_from_pending_outcome() {
        let approval_task = build_test_task_detail("in_review", "user", Some("lane-review"));
        let paused_assignment = build_test_task_lane_assignment(
            ASSIGNMENT_STATUS_PAUSED_BY_USER,
            Some("success"),
        );
        assert_eq!(
            effective_task_review_assignment_status(&approval_task, &paused_assignment),
            ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL
        );

        let intervention_task = build_test_task_detail("in_review", "user", Some("lane-review"));
        let approval_assignment = build_test_task_lane_assignment(
            ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL,
            Some("needs_user"),
        );
        assert_eq!(
            effective_task_review_assignment_status(&intervention_task, &approval_assignment),
            ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION
        );

        let explicit_pause_task = build_test_task_detail("in_progress", "role", Some("lane-work"));
        let explicit_pause_assignment = build_test_task_lane_assignment(
            ASSIGNMENT_STATUS_PAUSED_BY_USER,
            Some("paused"),
        );
        assert_eq!(
            effective_task_review_assignment_status(&explicit_pause_task, &explicit_pause_assignment),
            ASSIGNMENT_STATUS_PAUSED_BY_USER
        );
    }

    #[test]
    fn approval_gated_lane_pauses_for_review_and_resumes_same_session_for_rework() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Approval Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: true,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("task-runtime-approval");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-approval', 'orchestra', 'runtime-approval', 'Runtime Approval Repo', ?1, NULL, 'main', ?2, ?2)",
                params![project_root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Approval gated task".into(),
                description: Some("Hold for user approval after worker success.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-approval".into()),
                repository_ids: vec!["repo-approval".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let session_dir = project_root.parent().unwrap().join("sessions");
        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("role lane should dispatch");
        let session_id = assignment
            .session_id
            .clone()
            .expect("session id should exist");
        let role_instance_id = assignment
            .role_instance_id
            .clone()
            .expect("role instance id should exist");

        let awaiting_review = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Ready for review".into()),
            None,
        )
        .expect("lane should pause for approval");
        assert_eq!(awaiting_review.status, "in_review");
        assert_eq!(awaiting_review.assignee_type, "user");
        assert_eq!(
            awaiting_review.current_lane_id.as_deref(),
            Some("lane-implement")
        );
        assert_eq!(
            awaiting_review
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL)
        );
        assert_eq!(
            awaiting_review
                .active_lane_assignment
                .as_ref()
                .and_then(|entry| entry.session_id.as_deref()),
            Some(session_id.as_str())
        );
        assert_eq!(awaiting_review.lane_runs.len(), 1);
        assert!(awaiting_review.lane_runs[0].completed_at.is_none());
        let waiting_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load while awaiting approval");
        assert_eq!(waiting_ops.active_instance_count, 0);
        assert_eq!(waiting_ops.assigned_count, 1);
        assert_eq!(
            waiting_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("waiting")
        );

        connection
            .execute(
                "UPDATE task_lane_assignments SET status = ?2 WHERE task_id = ?1",
                params![task.id, ASSIGNMENT_STATUS_PAUSED_BY_USER],
            )
            .expect("assignment status should simulate stale paused approval state");

        let reactivated_assignment = send_lane_back_for_work(&connection, &task.id)
            .expect("lane should reactivate for rework");
        assert_eq!(reactivated_assignment.status, ASSIGNMENT_STATUS_ACTIVE);
        assert_eq!(
            reactivated_assignment.session_id.as_deref(),
            Some(session_id.as_str())
        );
        let reactivated_task =
            tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(reactivated_task.status, "in_progress");
        assert_eq!(reactivated_task.assignee_type, "role");
        let running_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load after reactivation");
        assert_eq!(running_ops.active_instance_count, 1);
        assert_eq!(
            running_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("running")
        );

        let awaiting_review_again = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Ready again".into()),
            None,
        )
        .expect("lane should pause for approval again");
        assert_eq!(
            awaiting_review_again
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL)
        );

        connection
            .execute(
                "UPDATE task_lane_assignments SET status = ?2 WHERE task_id = ?1",
                params![task.id, ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION],
            )
            .expect("assignment status should simulate stale intervention approval state");

        let approved =
            approve_pending_lane_completion(&mut connection, &project_root, &session_dir, &task.id)
                .expect("approval should finish the lane");
        assert_eq!(approved.status, "completed");
        assert!(approved.active_lane_assignment.is_none());
        assert_eq!(approved.lane_runs.len(), 1);
        assert_eq!(approved.lane_runs[0].result, "success");
        assert!(approved.lane_runs[0].completed_at.is_some());
        let completed_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load after approval");
        assert_eq!(completed_ops.active_instance_count, 0);
        assert_eq!(completed_ops.assigned_count, 0);
        assert_eq!(
            completed_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("completed")
        );
    }

    #[test]
    fn request_user_intervention_pauses_and_resumes_the_same_lane_session() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Intervention Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let now = now_iso();
        let project_root = init_test_repo("task-runtime-user-intervention-resume");
        let session_dir = project_root.parent().unwrap().join("sessions");
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "User intervention resume".into(),
                description: Some("Pause the lane for user intervention then resume it.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
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

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("role lane should dispatch");
        let session_id = assignment
            .session_id
            .clone()
            .expect("session id should exist");
        let role_instance_id = assignment
            .role_instance_id
            .clone()
            .expect("role instance id should exist");

        let awaiting_intervention = request_user_intervention(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Need help from the user".into()),
            None,
        )
        .expect("lane should pause for user intervention");
        assert_eq!(awaiting_intervention.status, "in_review");
        assert_eq!(awaiting_intervention.assignee_type, "user");
        assert_eq!(
            awaiting_intervention.current_lane_id.as_deref(),
            Some("lane-implement")
        );
        assert_eq!(
            awaiting_intervention
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION)
        );
        assert_eq!(
            awaiting_intervention
                .active_lane_assignment
                .as_ref()
                .and_then(|entry| entry.session_id.as_deref()),
            Some(session_id.as_str())
        );
        assert_eq!(awaiting_intervention.lane_runs.len(), 1);
        assert!(awaiting_intervention.lane_runs[0].completed_at.is_none());
        let waiting_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load while awaiting intervention");
        assert_eq!(waiting_ops.active_instance_count, 0);
        assert_eq!(waiting_ops.assigned_count, 1);
        assert_eq!(
            waiting_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("waiting")
        );

        let resumed_assignment = send_lane_back_for_work(&connection, &task.id)
            .expect("lane should resume after user intervention");
        assert_eq!(resumed_assignment.status, ASSIGNMENT_STATUS_ACTIVE);
        assert_eq!(
            resumed_assignment.session_id.as_deref(),
            Some(session_id.as_str())
        );
        let resumed_task =
            tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(resumed_task.status, "in_progress");
        assert_eq!(resumed_task.assignee_type, "role");
        let running_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load after resume");
        assert_eq!(running_ops.active_instance_count, 1);
        assert_eq!(
            running_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("running")
        );
    }

    #[test]
    fn pauses_and_resumes_the_same_lane_session_under_user_control() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Pause Resume Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Pause Resume Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let now = now_iso();
        let project_root = init_test_repo("task-runtime-pause-resume");
        let session_dir = project_root.parent().unwrap().join("sessions");
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Pause resume task".into(),
                description: Some(
                    "Pause and resume current lane work under user authority.".into(),
                ),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
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

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("task should dispatch");
        let session_id = assignment
            .session_id
            .clone()
            .expect("session id should exist");
        let role_instance_id = assignment
            .role_instance_id
            .clone()
            .expect("role instance should exist");

        let paused = pause_task_lane(&connection, &task.id, Some("Paused by operator".into()))
            .expect("task should pause");
        assert_eq!(paused.status, "in_review");
        assert_eq!(paused.assignee_type, "user");
        assert_eq!(
            paused
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_PAUSED_BY_USER)
        );
        assert_eq!(
            paused
                .active_lane_assignment
                .as_ref()
                .and_then(|entry| entry.session_id.as_deref()),
            Some(session_id.as_str())
        );
        let waiting_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load while paused");
        assert_eq!(
            waiting_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("waiting")
        );

        let resumed_assignment =
            resume_task_lane(&connection, &task.id).expect("task should resume from pause");
        assert_eq!(resumed_assignment.status, ASSIGNMENT_STATUS_ACTIVE);
        assert_eq!(
            resumed_assignment.session_id.as_deref(),
            Some(session_id.as_str())
        );
        let resumed_task =
            tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(resumed_task.status, "in_progress");
        assert_eq!(resumed_task.assignee_type, "role");
        let running_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load after resume");
        assert_eq!(
            running_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("running")
        );
    }

    #[test]
    fn pause_resume_and_stop_handle_queued_role_work() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Queued Control Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Queued Control Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let now = now_iso();
        let project_root = init_test_repo("task-runtime-queued-control");
        let session_dir = project_root.parent().unwrap().join("sessions");
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let first_task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Active queue owner".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("first task should create");
        let second_task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Queued control task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("second task should create");

        let active_assignment =
            dispatch_task_lane(&mut connection, &project_root, &session_dir, &first_task.id)
                .expect("first task should dispatch");
        assert_eq!(active_assignment.status, ASSIGNMENT_STATUS_ACTIVE);
        let queued_assignment = dispatch_task_lane(
            &mut connection,
            &project_root,
            &session_dir,
            &second_task.id,
        )
        .expect("second task should dispatch into queue");
        assert_eq!(queued_assignment.status, ASSIGNMENT_STATUS_QUEUED);
        assert!(queued_assignment.session_id.is_none());

        let paused = pause_task_lane(
            &connection,
            &second_task.id,
            Some("Hold queued work".into()),
        )
        .expect("queued task should pause");
        assert_eq!(paused.status, "in_review");
        assert_eq!(
            paused
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_PAUSED_BY_USER)
        );

        let resumed_assignment =
            resume_task_lane(&connection, &second_task.id).expect("queued task should resume");
        assert_eq!(resumed_assignment.status, ASSIGNMENT_STATUS_QUEUED);
        let resumed_task = tasks::get_task_context(&connection, &second_task.id)
            .expect("queued task should reload");
        assert_eq!(resumed_task.status, "in_progress");
        assert_eq!(resumed_task.assignee_type, "role");

        let stopped = stop_task_activity(
            &mut connection,
            &second_task.id,
            Some("Canceled queued work".into()),
        )
        .expect("queued task stop should succeed");
        assert_eq!(stopped.status, "ready");
        assert!(stopped.active_lane_assignment.is_none());
        assert_eq!(stopped.current_lane_id.as_deref(), Some("lane-implement"));
    }

    #[test]
    fn reassigns_awaiting_approval_work_to_a_specific_lane_and_auto_dispatches_it() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Relane Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Relane Flow".into(),
                description: None,
                lanes: vec![
                    WorkflowLaneInput {
                        id: Some("lane-implement".into()),
                        key: "implement".into(),
                        name: "Implement".into(),
                        description: None,
                        order: Some(0),
                        assigned_entity_type: "role".into(),
                        assigned_entity_id: Some(role.slug.clone()),
                        entry_prompt_template: Some("Implement the task".into()),
                        use_separate_worktree: false,
                        require_user_approval_on_success: true,
                        success_transition_type: "end".into(),
                        success_target_lane_id: None,
                        failure_transition_type: "end".into(),
                        failure_target_lane_id: None,
                    },
                    WorkflowLaneInput {
                        id: Some("lane-fix".into()),
                        key: "fix".into(),
                        name: "Fix".into(),
                        description: None,
                        order: Some(1),
                        assigned_entity_type: "role".into(),
                        assigned_entity_id: Some(role.slug.clone()),
                        entry_prompt_template: Some("Fix the failed lane".into()),
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "end".into(),
                        success_target_lane_id: None,
                        failure_transition_type: "end".into(),
                        failure_target_lane_id: None,
                    },
                ],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("task-runtime-relane");
        let session_dir = project_root.parent().unwrap().join("sessions");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-relane', 'orchestra', 'runtime-relane', 'Runtime Relane Repo', ?1, NULL, 'main', ?2, ?2)",
                params![project_root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Re-lane failed work".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-relane".into()),
                repository_ids: vec!["repo-relane".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("task lane should dispatch");
        let initial_session_id = assignment
            .session_id
            .clone()
            .expect("role assignment should have a session");
        let role_instance_id = assignment
            .role_instance_id
            .clone()
            .expect("role assignment should have an instance");

        let awaiting_review = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("This still needs more work".into()),
            None,
        )
        .expect("lane should pause for approval");
        assert_eq!(awaiting_review.status, "in_review");
        assert_eq!(
            awaiting_review
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL)
        );

        let relaned = reassign_task_to_lane(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            "lane-fix",
            Some("Implement lane failed review".into()),
            None,
        )
        .expect("task should move to the selected lane");
        assert_eq!(relaned.current_lane_id.as_deref(), Some("lane-fix"));
        assert_eq!(relaned.status, "ready");
        assert!(relaned.active_lane_assignment.is_none());
        assert_eq!(relaned.lane_runs.len(), 1);
        assert_eq!(relaned.lane_runs[0].result, "failure");
        assert!(relaned.lane_runs[0].completed_at.is_some());
        let waiting_ops = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role operations should load after relane");
        assert_eq!(waiting_ops.active_instance_count, 0);
        assert_eq!(waiting_ops.assigned_count, 0);
        assert_eq!(
            waiting_ops
                .instances
                .iter()
                .find(|instance| instance.id == role_instance_id)
                .map(|instance| instance.status.as_str()),
            Some("failed")
        );

        let next_assignment =
            dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
                .expect("re-laned task should dispatch into the selected lane");
        assert_eq!(next_assignment.lane_id, "lane-fix");
        assert_ne!(
            next_assignment.session_id.as_deref(),
            Some(initial_session_id.as_str())
        );

        let dispatched_task = tasks::get_task_context(&connection, &task.id)
            .expect("task should reload after dispatch");
        assert_eq!(dispatched_task.current_lane_id.as_deref(), Some("lane-fix"));
        assert_eq!(dispatched_task.status, "in_progress");
        assert_eq!(
            dispatched_task
                .active_lane_assignment
                .as_ref()
                .map(|entry| entry.lane_id.as_str()),
            Some("lane-fix")
        );
        assert_eq!(dispatched_task.lane_runs.len(), 2);
        assert!(dispatched_task.lane_runs[1].completed_at.is_none());
    }

    #[test]
    fn finds_missing_session_assignments_and_can_redispatch_them() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Recovery Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Recovery Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-recover".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Recover the task".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("task-runtime-stale-session-recovery");
        let session_dir = project_root.parent().unwrap().join("sessions");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-recover', 'orchestra', 'runtime-recover', 'Runtime Recovery Repo', ?1, NULL, 'main', ?2, ?2)",
                params![project_root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Recover stale session".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-recover".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-recover".into()),
                repository_ids: vec!["repo-recover".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("task should dispatch");
        let stale_session_id = assignment.session_id.clone().expect("session should exist");
        match pi_sessions::delete_session_file(&session_dir, &stale_session_id) {
            Ok(()) => {}
            Err(error) if error.contains("Unable to find session") => {}
            Err(error) => panic!("stale session file should delete: {error}"),
        }

        let reset =
            reset_task_runtime(&mut connection, &task.id).expect("task reset should succeed");
        assert_eq!(reset.status, "ready");
        assert!(reset.active_lane_assignment.is_none());

        let redispatched =
            maybe_auto_dispatch_task(&mut connection, &project_root, &session_dir, &task.id)
                .expect("task should redispatch")
                .expect("redispatched assignment should exist");
        assert_eq!(redispatched.status, "active");
        assert_ne!(
            redispatched.session_id.as_deref(),
            Some(stale_session_id.as_str())
        );
    }

    fn create_comment_notification_task(
        connection: &mut Connection,
        project_id: &str,
        title: &str,
        assignee_type: &str,
        assignee_id: Option<&str>,
        status: &str,
        current_lane_id: Option<&str>,
    ) -> crate::models::TaskDetail {
        let task = tasks::create_task(
            connection,
            Some(project_id),
            TaskUpsertInput {
                title: title.into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
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
        let now = now_iso();
        connection
            .execute(
                "UPDATE tasks SET current_lane_id = ?2, assignee_type = ?3, assignee_id = ?4, status = ?5, updated_at = ?6 WHERE id = ?1",
                params![
                    task.id.as_str(),
                    current_lane_id,
                    assignee_type,
                    assignee_id,
                    status,
                    now.as_str()
                ],
            )
            .expect("task should update for notification test");
        tasks::get_task(connection, &task.id).expect("task should reload")
    }

    fn seed_comment_notification_assignment(
        connection: &Connection,
        task_id: &str,
        lane_id: &str,
        worker_type: &str,
        worker_id: Option<&str>,
        status: &str,
        session_id: Option<&str>,
    ) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-comment-test', ?1, 'workflow-1', ?2, ?3, ?4, ?5, ?6, '/tmp/runtime', NULL, NULL, 'Prompt', NULL, NULL, 0, NULL, ?7, NULL, ?7, ?7)",
                params![task_id, lane_id, worker_type, worker_id, status, session_id, now],
            )
            .expect("assignment should seed");
    }

    fn add_comment_for_notification_test(
        connection: &mut Connection,
        task_id: &str,
        author: &str,
        origin_type: &str,
        message: &str,
    ) -> crate::models::TaskComment {
        tasks::add_task_comment(
            connection,
            task_id,
            crate::models::TaskCommentInput {
                author: author.into(),
                origin_type: Some(origin_type.into()),
                origin_id: None,
                message: message.into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
            },
        )
        .expect("comment should add")
    }

    fn assert_user_mailbox_delivery_for_assignment_status(status: &str) {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: format!("Mailbox {status}"),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let project = projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: format!("Comment mailbox {status}"),
                description: None,
                task_prefix: "MBX".into(),
            },
        )
        .expect("project should create");
        let task = create_comment_notification_task(
            &mut connection,
            &project.id,
            &format!("Mailbox notification {status}"),
            "user",
            None,
            "in_review",
            Some("lane-review"),
        );
        seed_comment_notification_assignment(
            &connection,
            &task.id,
            "lane-review",
            "agent",
            Some(&agent.id),
            status,
            Some("session-1"),
        );
        let comment = add_comment_for_notification_test(
            &mut connection,
            &task.id,
            "Reviewer",
            "role",
            &format!("Please review the latest {status} update."),
        );
        let target = resolve_task_comment_notification_target(&connection, &task, &comment)
            .expect("notification target should resolve")
            .expect("notification target should exist");
        assert!(matches!(
            &target,
            TaskCommentNotificationTarget::UserMailbox
        ));
        let warning = dispatch_task_comment_notification_target(
            None,
            None,
            &connection,
            &task,
            &comment,
            &target,
        );
        assert!(warning.is_none(), "unexpected warning: {warning:?}");

        let inbox =
            crate::services::messages::list_user_messages(&connection, Some(&project.id), false)
                .expect("user inbox should load");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].task_id.as_deref(), Some(task.id.as_str()));
        assert_eq!(inbox[0].sender_label, "Reviewer");
        assert!(inbox[0].body.contains(comment.message.as_str()));

        let queue_entries = crate::services::agent_runtime::list_agent_queue_entries_for_project(
            &connection,
            &project.id,
            Some(agent.id.as_str()),
            true,
        )
        .expect("agent queue entries should load");
        assert!(queue_entries.is_empty());
    }

    #[test]
    fn queues_non_interrupting_agent_comments_in_agent_queue() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Responder".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let assignment = TaskLaneAssignment {
            id: "assignment-1".into(),
            task_id: "task-1".into(),
            workflow_id: "workflow-1".into(),
            lane_id: "lane-1".into(),
            worker_type: "agent".into(),
            worker_id: Some(agent.id.clone()),
            status: ASSIGNMENT_STATUS_ACTIVE.into(),
            session_id: Some("session-1".into()),
            runtime_cwd: Some("/tmp/runtime".into()),
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: Some("Prompt".into()),
            pending_outcome: None,
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: now_iso(),
            completed_at: None,
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        let comment = crate::models::TaskComment {
            id: "comment-1".into(),
            task_id: "task-1".into(),
            parent_comment_id: None,
            author: "User".into(),
            origin_type: "user".into(),
            origin_id: None,
            message: "Please follow up later.".into(),
            interrupt_agent: false,
            repository_id: None,
            relative_path: None,
            line_start: None,
            line_end: None,
            column_start: None,
            column_end: None,
            selected_text: None,
            anchor_commit_hash: None,
            anchor_has_uncommitted_changes: None,
            created_at: now_iso(),
            updated_at: now_iso(),
        };

        queue_comment_delivery(&connection, &assignment, &comment).expect("queue comment delivery");
        let queue_entries = crate::services::agent_runtime::list_agent_queue_entries(
            &connection,
            Some(&agent.id),
            true,
        )
        .expect("agent queue entries");
        assert_eq!(queue_entries.len(), 1);
        assert_eq!(queue_entries[0].delivery_mode, "follow_up");
        assert_eq!(queue_entries[0].source_type, "task_comment");
        assert!(queue_entries[0]
            .message
            .contains("get_unread_task_comments"));
        assert!(queue_entries[0].message.contains("mark_task_comments_read"));
    }

    #[test]
    fn notify_or_queue_unread_comment_delivery_falls_back_to_queue_without_failing() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Deliverer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let project = crate::services::projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "Comment Queue Project".into(),
                description: None,
                task_prefix: "CQP".into(),
            },
        )
        .expect("project should create");
        let task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Queued comment task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "agent".into(),
                assignee_id: Some(agent.id.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let assignment = TaskLaneAssignment {
            id: "assignment-1".into(),
            task_id: task.id.clone(),
            workflow_id: "workflow-1".into(),
            lane_id: "lane-1".into(),
            worker_type: "agent".into(),
            worker_id: Some(agent.id.clone()),
            status: ASSIGNMENT_STATUS_ACTIVE.into(),
            session_id: Some("session-1".into()),
            runtime_cwd: Some("/tmp/runtime".into()),
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: Some("Prompt".into()),
            pending_outcome: None,
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: now_iso(),
            completed_at: None,
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        let comment = crate::models::TaskComment {
            id: "comment-1".into(),
            task_id: task.id.clone(),
            parent_comment_id: None,
            author: "User".into(),
            origin_type: "user".into(),
            origin_id: None,
            message: "Please follow up later.".into(),
            interrupt_agent: false,
            repository_id: None,
            relative_path: None,
            line_start: None,
            line_end: None,
            column_start: None,
            column_end: None,
            selected_text: None,
            anchor_commit_hash: None,
            anchor_has_uncommitted_changes: None,
            created_at: now_iso(),
            updated_at: now_iso(),
        };

        let warning =
            notify_or_queue_unread_comment_delivery(&connection, &assignment, &comment, || {
                Err("runtime unavailable".into())
            });

        assert!(warning
            .as_deref()
            .is_some_and(|message| message.contains("runtime unavailable")));
        let queue_entries = crate::services::agent_runtime::list_agent_queue_entries_for_project(
            &connection,
            &project.id,
            Some(agent.id.as_str()),
            true,
        )
        .expect("agent queue entries");
        assert_eq!(queue_entries.len(), 1);
        assert_eq!(queue_entries[0].delivery_mode, "follow_up");
        assert_eq!(queue_entries[0].source_type, "task_comment");
    }

    #[test]
    fn queued_worker_comment_notifications_create_queue_entries() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Queued Comment Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let project = projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "Queued Comment Delivery".into(),
                description: None,
                task_prefix: "QCD".into(),
            },
        )
        .expect("project should create");
        let task = create_comment_notification_task(
            &mut connection,
            &project.id,
            "Queued comment routing",
            "agent",
            Some(&agent.id),
            "in_progress",
            Some("lane-implementation"),
        );
        seed_comment_notification_assignment(
            &connection,
            &task.id,
            "lane-implementation",
            "agent",
            Some(&agent.id),
            ASSIGNMENT_STATUS_QUEUED,
            None,
        );
        let comment = add_comment_for_notification_test(
            &mut connection,
            &task.id,
            "Reviewer",
            "user",
            "Please pick this up when you start the lane.",
        );

        let target = resolve_task_comment_notification_target(&connection, &task, &comment)
            .expect("notification target should resolve")
            .expect("notification target should exist");
        assert!(matches!(
            &target,
            TaskCommentNotificationTarget::QueuedWorker(_)
        ));
        let warning = dispatch_task_comment_notification_target(
            None,
            None,
            &connection,
            &task,
            &comment,
            &target,
        );
        assert!(warning.is_none(), "unexpected warning: {warning:?}");

        let queue_entries = crate::services::agent_runtime::list_agent_queue_entries_for_project(
            &connection,
            &project.id,
            Some(agent.id.as_str()),
            true,
        )
        .expect("agent queue entries should load");
        assert_eq!(queue_entries.len(), 1);
        assert_eq!(queue_entries[0].source_type, "task_comment");
        assert_eq!(
            queue_entries[0].source_task_id.as_deref(),
            Some(task.id.as_str())
        );

        let inbox =
            crate::services::messages::list_user_messages(&connection, Some(&project.id), false)
                .expect("user inbox should load");
        assert!(inbox.is_empty());
    }

    #[test]
    fn awaiting_user_approval_comment_notifications_go_to_user_mailbox() {
        assert_user_mailbox_delivery_for_assignment_status(
            ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL,
        );
    }

    #[test]
    fn awaiting_user_intervention_comment_notifications_go_to_user_mailbox() {
        assert_user_mailbox_delivery_for_assignment_status(
            ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION,
        );
    }

    #[test]
    fn paused_by_user_comment_notifications_go_to_user_mailbox() {
        assert_user_mailbox_delivery_for_assignment_status(ASSIGNMENT_STATUS_PAUSED_BY_USER);
    }

    #[test]
    fn user_owned_lanes_without_assignments_still_notify_user_mailbox() {
        let mut connection = in_memory_connection();
        let project = projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "User-owned comment delivery".into(),
                description: None,
                task_prefix: "UCD".into(),
            },
        )
        .expect("project should create");
        let task = create_comment_notification_task(
            &mut connection,
            &project.id,
            "User-owned comment routing",
            "user",
            None,
            "in_review",
            Some("lane-review"),
        );
        let comment = add_comment_for_notification_test(
            &mut connection,
            &task.id,
            "Developer",
            "role",
            "Ready for your review.",
        );

        let target = resolve_task_comment_notification_target(&connection, &task, &comment)
            .expect("notification target should resolve")
            .expect("notification target should exist");
        assert!(matches!(
            &target,
            TaskCommentNotificationTarget::UserMailbox
        ));
        let warning = dispatch_task_comment_notification_target(
            None,
            None,
            &connection,
            &task,
            &comment,
            &target,
        );
        assert!(warning.is_none(), "unexpected warning: {warning:?}");

        let inbox =
            crate::services::messages::list_user_messages(&connection, Some(&project.id), false)
                .expect("user inbox should load");
        assert_eq!(inbox.len(), 1);
        assert_eq!(inbox[0].task_id.as_deref(), Some(task.id.as_str()));
    }

    #[test]
    fn user_authored_comments_on_user_facing_states_do_not_self_notify_mailbox() {
        let mut connection = in_memory_connection();
        let project = projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "User self comment delivery".into(),
                description: None,
                task_prefix: "USR".into(),
            },
        )
        .expect("project should create");
        let task = create_comment_notification_task(
            &mut connection,
            &project.id,
            "User self comment routing",
            "user",
            None,
            "in_review",
            Some("lane-review"),
        );
        let comment = add_comment_for_notification_test(
            &mut connection,
            &task.id,
            "User",
            "user",
            "I left myself a note.",
        );

        let target = resolve_task_comment_notification_target(&connection, &task, &comment)
            .expect("notification target should resolve");
        assert!(target.is_none());

        let inbox =
            crate::services::messages::list_user_messages(&connection, Some(&project.id), false)
                .expect("user inbox should load");
        assert!(inbox.is_empty());
    }

    #[test]
    fn completion_requires_unread_comments_to_be_acknowledged() {
        let mut connection = in_memory_connection();
        let _role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Completer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, "developer", &agent.slug);
        let now = now_iso();
        let project_root = init_test_repo("task-runtime-unread-comments");
        let session_dir = project_root.parent().unwrap().join("sessions");
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Unread completion guard".into(),
                description: Some("Do not finish before reading comments.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-review".into()),
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

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("agent lane should dispatch");
        let _comment = tasks::add_task_comment(
            &mut connection,
            &task.id,
            crate::models::TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: None,
                origin_id: None,
                message: "Please address the latest notes before finishing.".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
            },
        )
        .expect("task comment should add");

        let error = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            None,
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: agent.id.clone(),
            }),
        )
        .expect_err("completion should fail while unread comments remain");
        assert!(error.contains("unread comment"));
        assert!(error.contains("get_unread_task_comments"));

        let unread = tasks::list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("unread comments should load");
        assert_eq!(unread.len(), 1);
        tasks::mark_task_comments_read(&connection, &task.id, &assignment, None)
            .expect("unread comments should mark read");

        let updated = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Handled the unread feedback".into()),
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: agent.id.clone(),
            }),
        )
        .expect("completion should succeed after acknowledging comments");
        assert_eq!(updated.status, "completed");
    }

    #[test]
    fn completion_fails_while_current_lane_todos_remain_unfinished() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Todo Completer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let now = now_iso();
        let project_root = init_test_repo("task-runtime-todos");
        let session_dir = project_root.parent().unwrap().join("sessions");
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Todo gated completion".into(),
                description: Some("Do not complete while lane todos remain.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-review".into()),
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

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("agent lane should dispatch");
        let todo = tasks::add_task_todo(
            &mut connection,
            &task.id,
            crate::models::TaskTodoInput {
                lane_id: Some(assignment.lane_id.clone()),
                description: "Confirm reviewer checklist is done".into(),
            },
        )
        .expect("todo should add");

        let error = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Tried to finish too early".into()),
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: agent.id.clone(),
            }),
        )
        .expect_err("completion should fail while todos remain");
        assert!(error.contains("unfinished todo item"));
        assert!(error.contains("list_unfinished_task_todos"));

        let unfinished = tasks::list_unfinished_task_todos(
            &connection,
            &task.id,
            Some(assignment.lane_id.as_str()),
        )
        .expect("unfinished todos should list");
        assert_eq!(unfinished.len(), 1);
        assert_eq!(unfinished[0].id, todo.id);

        tasks::mark_task_todo_finished(&connection, &todo.id).expect("todo should mark finished");
        let updated = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Todo finished".into()),
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: agent.id.clone(),
            }),
        )
        .expect("completion should succeed once todos are finished");
        assert_eq!(updated.status, "completed");
    }

    #[test]
    fn finds_idle_agent_whip_candidates_and_enqueues_a_whip() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Whip Target".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Needs a whip".into(),
                description: Some("Agent should keep working.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "agent".into(),
                assignee_id: Some(agent.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(2),
                archived: None,
            },
        )
        .expect("task should create");
        connection
            .execute(
                "UPDATE tasks SET whip_max_attempts = 2 WHERE id = ?1",
                params![task.id.as_str()],
            )
            .expect("task whip max attempts should update");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-whip', ?1, 'workflow-whip', 'lane-agent', 'agent', ?2, 'active', 'session-whip', '/tmp/runtime-whip', NULL, NULL, 'Prompt', 0, NULL, ?3, NULL, ?3, ?3)",
                params![task.id.as_str(), agent.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'idle', 'session-whip', '/tmp/runtime-whip', NULL, NULL, NULL, ?2, ?2)",
                params![agent.id.as_str(), now.as_str()],
            )
            .expect("agent runtime state should insert");

        let candidates =
            find_task_whip_candidates(&connection).expect("whip candidates should resolve");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].task_id, task.id);
        assert_eq!(candidates[0].worker_type, "agent");
        assert_eq!(candidates[0].whip_max_attempts, 2);

        let queued = send_task_whip(&connection, &candidates[0]).expect("whip should enqueue");
        assert_eq!(queued.source_type, "task_whip");
        assert_eq!(queued.source_task_id.as_deref(), Some(task.id.as_str()));
        assert!(queued.message.contains(TASK_WHIP_PROMPT));
        assert!(queued
            .message
            .contains(&format!("Canonical task ID: {}", task.id)));

        let assignment = get_active_lane_assignment(&connection, &task.id)
            .expect("assignment should reload")
            .expect("assignment should exist");
        assert_eq!(assignment.whip_count, 1);
        assert!(assignment.last_whip_at.is_some());

        let candidates_after_queue = find_task_whip_candidates(&connection)
            .expect("whip candidates should resolve after queueing");
        assert!(candidates_after_queue.is_empty());
    }

    #[test]
    fn refresh_task_whip_candidate_skips_assignments_after_lane_completion() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Completed Whip Target".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Whip completion flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent-complete".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Finish the task.".into()),
                    use_separate_worktree: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                    require_user_approval_on_success: false,
                }],
            },
        )
        .expect("workflow should create");
        let root = unique_temp_dir("task-whip-complete");
        fs::create_dir_all(&root).expect("root should create");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "No whip after complete".into(),
                description: Some("Completed work should not be whipped again.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent-complete".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(3),
                archived: None,
            },
        )
        .expect("task should create");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-complete-whip', ?1, ?2, 'lane-agent-complete', 'agent', ?3, 'active', 'session-complete-whip', '/tmp/runtime-complete-whip', NULL, NULL, 'Prompt', 0, NULL, ?4, NULL, ?4, ?4)",
                params![task.id.as_str(), workflow.id.as_str(), agent.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'idle', 'session-complete-whip', '/tmp/runtime-complete-whip', NULL, NULL, NULL, ?2, ?2)",
                params![agent.id.as_str(), now.as_str()],
            )
            .expect("agent runtime state should insert");

        let stale_candidate = find_task_whip_candidates(&connection)
            .expect("whip candidates should resolve")
            .into_iter()
            .next()
            .expect("candidate should exist");

        let updated =
            complete_lane_as_success(&mut connection, &root, &session_dir, &task.id, None, None)
                .expect("lane should complete");
        assert_eq!(updated.status, "completed");
        assert!(updated.active_lane_assignment.is_none());

        let refreshed = refresh_task_whip_candidate(&connection, &stale_candidate.assignment_id)
            .expect("candidate should revalidate");
        assert!(refreshed.is_none());
    }

    #[test]
    fn finds_idle_role_whip_candidates() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Whip Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Role needs a whip".into(),
                description: Some("Role should keep working.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "role".into(),
                assignee_id: Some(role.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(4),
                archived: None,
            },
        )
        .expect("task should create");
        connection
            .execute(
                "UPDATE tasks SET whip_max_attempts = 4 WHERE id = ?1",
                params![task.id.as_str()],
            )
            .expect("task whip max attempts should update");
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-whip', ?1, 'Whip Role 1', 'idle', NULL, 'session-role-whip', '/tmp/runtime-role-whip', NULL, NULL, ?2, ?2)",
                params![role.id.as_str(), now.as_str()],
            )
            .expect("role instance should insert");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-role-whip', ?1, 'workflow-whip', 'lane-role', 'role', ?2, 'active', 'session-role-whip', '/tmp/runtime-role-whip', NULL, 'instance-whip', 'Prompt', 0, NULL, ?3, NULL, ?3, ?3)",
                params![task.id.as_str(), role.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");

        let candidates =
            find_task_whip_candidates(&connection).expect("role whip candidates should resolve");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].worker_type, "role");
        assert_eq!(candidates[0].worker_id, role.id);
        assert_eq!(
            candidates[0].role_instance_id.as_deref(),
            Some("instance-whip")
        );
        assert_eq!(
            candidates[0].runtime_cwd.as_deref(),
            Some("/tmp/runtime-role-whip")
        );
        assert_eq!(candidates[0].whip_max_attempts, 4);
    }

    #[test]
    fn finds_running_role_whip_candidates_when_assignment_session_is_idle() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Running Whip Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Running role needs a whip".into(),
                description: Some("Role should keep working after its session goes idle.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "role".into(),
                assignee_id: Some(role.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(4),
                archived: None,
            },
        )
        .expect("task should create");
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-running-whip', ?1, 'Running Whip Role 1', 'running', 'queue-role-whip', 'session-running-role-whip', '/tmp/runtime-running-role-whip', NULL, NULL, ?2, ?2)",
                params![role.id.as_str(), now.as_str()],
            )
            .expect("role instance should insert");
        connection
            .execute(
                "INSERT INTO role_queue_entries (id, role_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, title, summary, entry_prompt, assigned_instance_id, created_at, updated_at, started_at, completed_at) VALUES ('queue-role-whip', ?1, 'assigned', 'workflow_lane', ?2, 'workflow-whip', 'lane-role', 'Running whip', NULL, 'Prompt', 'instance-running-whip', ?3, ?3, ?3, NULL)",
                params![role.id.as_str(), task.id.as_str(), now.as_str()],
            )
            .expect("role queue entry should insert");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-running-role-whip', ?1, 'workflow-whip', 'lane-role', 'role', ?2, 'active', 'session-running-role-whip', '/tmp/runtime-running-role-whip', 'queue-role-whip', 'instance-running-whip', 'Prompt', 0, NULL, ?3, NULL, ?3, ?3)",
                params![task.id.as_str(), role.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");

        let candidates = find_task_whip_candidates(&connection)
            .expect("running role whip candidates should resolve");
        assert_eq!(candidates.len(), 1);
        assert_eq!(candidates[0].worker_type, "role");
        assert_eq!(candidates[0].worker_id, role.id);
        assert_eq!(
            candidates[0].role_instance_id.as_deref(),
            Some("instance-running-whip")
        );
        assert_eq!(candidates[0].session_id, "session-running-role-whip");
    }

    #[test]
    fn escalates_to_user_intervention_after_whip_limit_is_reached() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Escalation Target".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Whip Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent-whip".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Keep going until done.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = unique_temp_dir("task-whip-escalation");
        fs::create_dir_all(&root).expect("root should create");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Escalate me".into(),
                description: Some("This task should ask the user for help.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent-whip".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(1),
                archived: None,
            },
        )
        .expect("task should create");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-escalate', ?1, ?2, 'lane-agent-whip', 'agent', ?3, 'active', 'session-escalate', '/tmp/runtime-escalate', NULL, NULL, 'Prompt', 1, ?4, ?4, NULL, ?4, ?4)",
                params![task.id.as_str(), workflow.id.as_str(), agent.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'idle', 'session-escalate', '/tmp/runtime-escalate', NULL, NULL, NULL, ?2, ?2)",
                params![agent.id.as_str(), now.as_str()],
            )
            .expect("agent runtime state should insert");

        let candidates =
            find_task_whip_candidates(&connection).expect("whip candidates should resolve");
        assert_eq!(candidates.len(), 1);
        let updated =
            escalate_task_whip_limit_exceeded(&mut connection, &root, &session_dir, &candidates[0])
                .expect("task should escalate to user intervention");
        assert_eq!(updated.status, "in_review");
        assert_eq!(updated.assignee_type, "user");
        assert_eq!(
            updated
                .active_lane_assignment
                .as_ref()
                .map(|assignment| assignment.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION)
        );
        assert!(updated.comments.iter().any(|comment| comment
            .message
            .contains("Automatic user intervention requested after 1 whip attempts")));
    }

    #[test]
    fn dispatches_agent_lane_and_completes_workflow() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("low".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Agent Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Do the work.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-agent");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-agent', 'orchestra', 'runtime-agent', 'Runtime Agent Repo', ?1, NULL, 'main', ?2, ?2)",
                params![root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Agent runtime task".into(),
                description: Some("Run through an agent-owned lane.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-agent".into()),
                repository_ids: vec!["repo-agent".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let assignment = dispatch_task_lane(&mut connection, &root, &session_dir, &task.id)
            .expect("agent lane should dispatch");
        assert_eq!(assignment.worker_type, "agent");
        assert_eq!(assignment.worker_id.as_deref(), Some(agent.id.as_str()));
        assert!(assignment.session_id.is_some());
        let runtime_cwd = assignment
            .runtime_cwd
            .as_deref()
            .expect("agent assignment should expose a runtime cwd");
        assert!(Path::new(runtime_cwd).exists());

        let updated =
            complete_lane_as_success(&mut connection, &root, &session_dir, &task.id, None, None)
                .expect("agent lane should complete");
        assert_eq!(updated.status, "completed");
        assert!(updated.active_lane_assignment.is_none());
        assert_eq!(
            session_list::load_hidden_session_reason(
                &connection,
                assignment
                    .session_id
                    .as_deref()
                    .expect("agent session should exist"),
            )
            .expect("hidden reason should load")
            .as_deref(),
            Some(session_list::SESSION_HIDDEN_REASON_TASK_COMPLETED)
        );
    }

    #[test]
    fn completing_role_lane_auto_archives_session_list_entry() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Role Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-role-complete".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-role-complete-archive");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-role-complete', 'orchestra', 'runtime-role-complete', 'Runtime Role Repo', ?1, NULL, 'main', ?2, ?2)",
                params![root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Role runtime task".into(),
                description: Some("Run through a role-owned lane to completion.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-role-complete".into()),
                assignee_type: "role".into(),
                assignee_id: Some(role.id.clone()),
                repository_id: Some("repo-role-complete".into()),
                repository_ids: vec!["repo-role-complete".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-role-complete', ?1, 'Developer 1', 'running', NULL, 'session-role-complete', ?2, NULL, NULL, ?3, ?3)",
                params![role.id.as_str(), root.display().to_string(), now.as_str()],
            )
            .expect("role instance should insert");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-role-complete', ?1, ?2, 'lane-role-complete', 'role', ?3, 'active', 'session-role-complete', ?4, NULL, 'instance-role-complete', 'Prompt', 0, NULL, ?5, NULL, ?5, ?5)",
                params![task.id.as_str(), workflow.id.as_str(), role.id.as_str(), root.display().to_string(), now.as_str()],
            )
            .expect("assignment should insert");

        let updated =
            complete_lane_as_success(&mut connection, &root, &session_dir, &task.id, None, None)
                .expect("role lane should complete");
        assert_eq!(updated.status, "completed");
        assert_eq!(
            session_list::load_hidden_session_reason(&connection, "session-role-complete")
                .expect("hidden reason should load")
                .as_deref(),
            Some(session_list::SESSION_HIDDEN_REASON_TASK_COMPLETED)
        );
    }

    #[test]
    fn completing_agent_lane_auto_archives_session_list_entry() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("project".into()),
                project_id: Some("orchestra".into()),
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Agent Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent-complete".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Do the work.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-agent-complete-archive");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-agent-complete', 'orchestra', 'runtime-agent-complete', 'Runtime Agent Repo', ?1, NULL, 'main', ?2, ?2)",
                params![root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Agent runtime task".into(),
                description: Some("Run through an agent-owned lane to completion.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent-complete".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.id.clone()),
                repository_id: Some("repo-agent-complete".into()),
                repository_ids: vec!["repo-agent-complete".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'running', 'session-agent-complete', ?2, NULL, NULL, NULL, ?3, ?3)",
                params![agent.id.as_str(), root.display().to_string(), now.as_str()],
            )
            .expect("agent runtime should insert");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-agent-complete', ?1, ?2, 'lane-agent-complete', 'agent', ?3, 'active', 'session-agent-complete', ?4, NULL, NULL, 'Prompt', 0, NULL, ?5, NULL, ?5, ?5)",
                params![task.id.as_str(), workflow.id.as_str(), agent.id.as_str(), root.display().to_string(), now.as_str()],
            )
            .expect("assignment should insert");

        let updated =
            complete_lane_as_success(&mut connection, &root, &session_dir, &task.id, None, None)
                .expect("agent lane should complete");
        assert_eq!(updated.status, "completed");
        assert_eq!(
            session_list::load_hidden_session_reason(&connection, "session-agent-complete")
                .expect("hidden reason should load")
                .as_deref(),
            Some(session_list::SESSION_HIDDEN_REASON_TASK_COMPLETED)
        );
    }

    #[test]
    fn parent_tasks_with_unfinished_subtasks_cannot_dispatch() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Parent Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-parent".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the parent task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-parent-subtask-block");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-parent', 'orchestra', 'parent-repo', 'Parent Repo', ?1, NULL, 'main', ?2, ?2)",
                params![root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");

        let parent = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Parent task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-parent".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-parent".into()),
                repository_ids: vec!["repo-parent".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("parent should create");
        let _child = tasks::create_subtask(
            &mut connection,
            &parent.id,
            TaskUpsertInput {
                title: "Child task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("child should create");

        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let error = dispatch_task_lane(&mut connection, &root, &session_dir, &parent.id)
            .expect_err("parent dispatch should be blocked by unfinished subtasks");
        assert!(
            error.contains("unfinished subtasks")
                || error.contains("blocked and cannot be dispatched")
                || error.contains("blocked by unresolved dependencies")
        );
    }

    #[test]
    fn child_completion_can_auto_dispatch_an_unblocked_parent() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Parent Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-parent".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the parent task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-child-unblocks-parent");
        insert_project_and_repository(
            &connection,
            "project-parent-auto",
            "project-parent-auto",
            "repo-parent-auto",
            "parent-auto-repo",
            "Parent Auto Repo",
            &root,
        );

        let parent = tasks::create_task(
            &mut connection,
            Some("project-parent-auto"),
            TaskUpsertInput {
                title: "Parent task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-parent".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-parent-auto".into()),
                repository_ids: vec!["repo-parent-auto".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("parent should create");
        let child = tasks::create_subtask(
            &mut connection,
            &parent.id,
            TaskUpsertInput {
                title: "Child task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("child should create");

        let blocked_parent =
            tasks::get_task(&connection, &parent.id).expect("parent should reload");
        assert_eq!(blocked_parent.status, "blocked");
        assert!(blocked_parent.dependency_blocked);
        assert!(!blocked_parent.ready_for_dispatch);

        let _completed_child = tasks::update_task(
            &mut connection,
            &child.id,
            TaskUpsertInput {
                title: child.title.clone(),
                description: child.description.clone(),
                task_type: child.task_type.clone(),
                tags: Vec::new(),
                status: "completed".into(),
                priority: child.priority.clone(),
                workflow_id: child.workflow_id.clone(),
                current_lane_id: child.current_lane_id.clone(),
                assignee_type: child.assignee_type.clone(),
                assignee_id: child.assignee_id.clone(),
                repository_id: child.repository_id.clone(),
                repository_ids: child.repository_ids.clone(),
                parent_task_id: child.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("child should complete");

        let unblocked_parent = tasks::get_task(&connection, &parent.id)
            .expect("parent should reload after child completion");
        assert_eq!(unblocked_parent.status, "ready");
        assert!(!unblocked_parent.dependency_blocked);
        assert!(unblocked_parent.ready_for_dispatch);

        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let parents = auto_dispatchable_unblocked_parents(&connection, &child.id)
            .expect("parent auto-dispatch candidates should load");
        assert_eq!(parents, vec![parent.id.clone()]);

        let assignment = maybe_auto_dispatch_task(&mut connection, &root, &session_dir, &parent.id)
            .expect("parent auto-dispatch should succeed")
            .expect("parent should become dispatchable");
        assert_eq!(assignment.task_id, parent.id);
    }

    #[test]
    fn blocker_completion_restores_a_dependency_blocked_task_to_ready() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Dependent Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let blocker_workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Blocker Review Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-blocker-review".into()),
                    key: "review".into(),
                    name: "Review".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "user".into(),
                    assigned_entity_id: None,
                    entry_prompt_template: Some("Review the blocker.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("blocker workflow should create");
        let dependent_workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Dependent Role Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-dependent-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the dependent task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("dependent workflow should create");
        let root = init_test_repo("task-runtime-blocker-completion-unblocks-dependent");
        insert_project_and_repository(
            &connection,
            "project-blocker-completion",
            "project-blocker-completion",
            "repo-blocker-completion",
            "repo-blocker-completion",
            "Blocker Completion Repo",
            &root,
        );

        let blocker = tasks::create_task(
            &mut connection,
            Some("project-blocker-completion"),
            TaskUpsertInput {
                title: "Blocker task".into(),
                description: Some("Completing this should unblock the dependent task.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_review".into(),
                priority: "P1".into(),
                workflow_id: Some(blocker_workflow.id.clone()),
                current_lane_id: Some("lane-blocker-review".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: Some("repo-blocker-completion".into()),
                repository_ids: vec!["repo-blocker-completion".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("blocker task should create");
        let dependent = tasks::create_task(
            &mut connection,
            Some("project-blocker-completion"),
            TaskUpsertInput {
                title: "Dependent task".into(),
                description: Some("Should return to ready once the blocker completes.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(dependent_workflow.id.clone()),
                current_lane_id: Some("lane-dependent-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-blocker-completion".into()),
                repository_ids: vec!["repo-blocker-completion".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("dependent task should create");
        tasks::add_task_dependency(&mut connection, &blocker.id, &dependent.id)
            .expect("dependency should add");

        let blocked_dependent =
            tasks::get_task(&connection, &dependent.id).expect("dependent should reload blocked");
        assert_eq!(blocked_dependent.status, "blocked");
        assert!(blocked_dependent.dependency_blocked);
        assert!(!blocked_dependent.ready_for_dispatch);

        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let completed_blocker = complete_lane_as_success(
            &mut connection,
            &root,
            &session_dir,
            &blocker.id,
            Some("Resolved the blocker".into()),
            None,
        )
        .expect("blocker completion should succeed");
        assert_eq!(completed_blocker.status, "completed");

        let unblocked_dependent = tasks::get_task(&connection, &dependent.id)
            .expect("dependent should reload ready after blocker completion");
        assert_eq!(unblocked_dependent.status, "ready");
        assert!(!unblocked_dependent.dependency_blocked);
        assert!(unblocked_dependent.ready_for_dispatch);
    }

    #[test]
    fn blocker_implementation_to_test_transition_restores_dependent_to_ready() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Dependent Test Lane Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let blocker_workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Blocker Implement To Test Flow".into(),
                description: None,
                lanes: vec![
                    WorkflowLaneInput {
                        id: Some("lane-blocker-implement".into()),
                        key: "implement".into(),
                        name: "Implement".into(),
                        description: None,
                        order: Some(0),
                        assigned_entity_type: "user".into(),
                        assigned_entity_id: None,
                        entry_prompt_template: Some("Implement the blocker.".into()),
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "lane".into(),
                        success_target_lane_id: Some("lane-blocker-test".into()),
                        failure_transition_type: "end".into(),
                        failure_target_lane_id: None,
                    },
                    WorkflowLaneInput {
                        id: Some("lane-blocker-test".into()),
                        key: "test".into(),
                        name: "Test".into(),
                        description: None,
                        order: Some(1),
                        assigned_entity_type: "user".into(),
                        assigned_entity_id: None,
                        entry_prompt_template: Some("Test the blocker.".into()),
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "end".into(),
                        success_target_lane_id: None,
                        failure_transition_type: "lane".into(),
                        failure_target_lane_id: Some("lane-blocker-implement".into()),
                    },
                ],
            },
        )
        .expect("blocker workflow should create");
        let dependent_workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Dependent Test Lane Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-dependent-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the dependent task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("dependent workflow should create");
        let root = init_test_repo("task-runtime-blocker-test-lane-unblocks-dependent");
        insert_project_and_repository(
            &connection,
            "project-blocker-test-lane",
            "project-blocker-test-lane",
            "repo-blocker-test-lane",
            "repo-blocker-test-lane",
            "Blocker Test Lane Repo",
            &root,
        );

        let blocker = tasks::create_task(
            &mut connection,
            Some("project-blocker-test-lane"),
            TaskUpsertInput {
                title: "Blocker task".into(),
                description: Some(
                    "Advancing this to Test should unblock the dependent task.".into(),
                ),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_review".into(),
                priority: "P1".into(),
                workflow_id: Some(blocker_workflow.id.clone()),
                current_lane_id: Some("lane-blocker-implement".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: Some("repo-blocker-test-lane".into()),
                repository_ids: vec!["repo-blocker-test-lane".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("blocker task should create");
        let dependent = tasks::create_task(
            &mut connection,
            Some("project-blocker-test-lane"),
            TaskUpsertInput {
                title: "Dependent task".into(),
                description: Some("Should return to ready once the blocker reaches Test.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(dependent_workflow.id.clone()),
                current_lane_id: Some("lane-dependent-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-blocker-test-lane".into()),
                repository_ids: vec!["repo-blocker-test-lane".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("dependent task should create");
        tasks::add_task_dependency(&mut connection, &blocker.id, &dependent.id)
            .expect("dependency should add");

        let blocked_dependent =
            tasks::get_task(&connection, &dependent.id).expect("dependent should reload blocked");
        assert_eq!(blocked_dependent.status, "blocked");
        assert!(blocked_dependent.dependency_blocked);
        assert!(!blocked_dependent.ready_for_dispatch);

        let session_dir = root.join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let transitioned_blocker = complete_lane_as_success(
            &mut connection,
            &root,
            &session_dir,
            &blocker.id,
            Some("Implementation ready for Test".into()),
            None,
        )
        .expect("blocker transition should succeed");
        assert_eq!(transitioned_blocker.status, "in_review");
        assert_eq!(
            transitioned_blocker.current_lane_id.as_deref(),
            Some("lane-blocker-test")
        );

        let unblocked_dependent = tasks::get_task(&connection, &dependent.id)
            .expect("dependent should reload ready after blocker enters Test");
        assert_eq!(unblocked_dependent.status, "ready");
        assert!(!unblocked_dependent.dependency_blocked);
        assert!(unblocked_dependent.ready_for_dispatch);
    }

    #[test]
    fn active_task_blocked_by_a_new_subtask_keeps_running_until_transition() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Parent Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Parent Agent Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-parent-agent".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Implement the parent task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-blocked-parent-subtask-mid-run");
        insert_project_and_repository(
            &connection,
            "project-parent-subtask-mid-run",
            "project-parent-subtask-mid-run",
            "repo-parent-subtask-mid-run",
            "repo-parent-subtask-mid-run",
            "Parent Mid-run Repo",
            &root,
        );

        let parent = tasks::create_task(
            &mut connection,
            Some("project-parent-subtask-mid-run"),
            TaskUpsertInput {
                title: "Parent task".into(),
                description: Some("Creates a child while already running.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-parent-agent".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.id.clone()),
                repository_id: Some("repo-parent-subtask-mid-run".into()),
                repository_ids: vec!["repo-parent-subtask-mid-run".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("parent should create");
        let session_dir = root.parent().unwrap().join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let session = pi_sessions::create_session_file(
            &root,
            &session_dir,
            Some("parent mid-run session"),
            false,
        )
        .expect("session should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-parent-mid-run', ?1, ?2, 'lane-parent-agent', 'agent', ?3, 'active', ?4, ?5, NULL, NULL, 'Prompt', 0, NULL, ?6, NULL, ?6, ?6)",
                params![
                    parent.id.as_str(),
                    workflow.id.as_str(),
                    agent.id.as_str(),
                    session.record.id.as_str(),
                    root.display().to_string(),
                    now.as_str(),
                ],
            )
            .expect("active assignment should insert");
        ensure_lane_run(
            &connection,
            parent.id.as_str(),
            "lane-parent-agent",
            session.record.id.as_str(),
            &now,
        )
        .expect("lane run should create");

        let dispatched = get_current_lane_assignment(&connection, &parent.id)
            .expect("current assignment should load")
            .expect("active assignment should exist");
        assert_eq!(dispatched.status, ASSIGNMENT_STATUS_ACTIVE);
        assert!(dispatched.session_id.is_some());

        let child = tasks::create_subtask(
            &mut connection,
            &parent.id,
            TaskUpsertInput {
                title: "Child task".into(),
                description: Some("Blocks the parent until it is finished.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("child should create");

        let blocked_parent =
            tasks::get_task(&connection, &parent.id).expect("parent should reload blocked");
        assert_eq!(blocked_parent.status, "blocked");
        assert!(blocked_parent.dependency_blocked);
        assert!(blocked_parent.active_lane_assignment.is_some());
        assert_eq!(blocked_parent.blocked_child_count, 1);

        let transitioned = complete_lane_as_success(
            &mut connection,
            &root,
            &session_dir,
            &parent.id,
            Some("Tried to finish while child work remained open.".into()),
            None,
        )
        .expect("blocked parent transition attempt should succeed by stopping the session");
        assert_eq!(transitioned.status, "blocked");
        assert!(transitioned.dependency_blocked);
        assert!(transitioned.active_lane_assignment.is_none());
        assert_eq!(
            transitioned.current_lane_id.as_deref(),
            Some("lane-parent-agent")
        );
        assert_eq!(transitioned.blocked_child_count, 1);
        assert_eq!(
            transitioned.lane_runs.last().map(|run| run.result.as_str()),
            Some("blocked")
        );

        let assignment_status: String = connection
            .query_row(
                "SELECT status FROM task_lane_assignments WHERE id = ?1",
                [dispatched.id.as_str()],
                |row| row.get(0),
            )
            .expect("assignment should reload after blocked transition attempt");
        assert_eq!(assignment_status, ASSIGNMENT_STATUS_COMPLETED);

        let child_reloaded = tasks::get_task(&connection, &child.id).expect("child should reload");
        assert_eq!(child_reloaded.status, "ready");
    }

    #[test]
    fn user_review_can_fail_without_an_active_assignment() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("low".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Agent Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Do the work.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let root = init_test_repo("task-runtime-user-review-failure");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-agent-review', 'orchestra', 'runtime-agent-review', 'Runtime Agent Review Repo', ?1, NULL, 'main', ?2, ?2)",
                params![root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Agent review task".into(),
                description: Some("Escalate to user review then mark needs work.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-agent-review".into()),
                repository_ids: vec!["repo-agent-review".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = root.join("sessions");
        std::fs::create_dir_all(&session_dir).expect("session dir should create");

        let _assignment = dispatch_task_lane(&mut connection, &root, &session_dir, &task.id)
            .expect("agent lane should dispatch");
        let awaiting_review = request_user_intervention(
            &mut connection,
            &root,
            &session_dir,
            &task.id,
            Some("Need human review".into()),
            None,
        )
        .expect("task should move to user review");
        assert_eq!(awaiting_review.status, "in_review");
        assert_eq!(awaiting_review.assignee_type, "user");
        assert_eq!(
            awaiting_review
                .active_lane_assignment
                .as_ref()
                .map(|assignment| assignment.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_INTERVENTION)
        );

        let error = complete_lane_as_failure(
            &mut connection,
            &root,
            &session_dir,
            &task.id,
            Some("Needs more work".into()),
            None,
        )
        .expect_err("paused user intervention work should require dedicated review actions");
        assert!(error.contains("paused for user review"));
    }

    #[test]
    fn agent_lane_uses_project_scoped_runtime_state_instead_of_default_project_runtime() {
        let mut connection = in_memory_connection();
        let project_root = init_test_repo("task-runtime-project-scoped-agent");
        let wrong_runtime = unique_temp_dir("wrong-agent-runtime");
        fs::create_dir_all(&wrong_runtime).expect("wrong runtime dir should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-client', 'client-project', 'Client Project', NULL, 'CLI', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-client', 'project-client', 'client-repo', 'Client Repo', ?1, NULL, 'main', ?2, ?2)",
                params![project_root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Project Agent".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("project".into()),
                project_id: Some("project-client".into()),
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let _role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Unused Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Agent-only flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent-project".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Handle the task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        // Create a runtime state with a wrong runtime path for the project-scoped agent
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-client', ?1, 'idle', NULL, ?2, NULL, NULL, NULL, ?3, ?3)",
                params![agent.id.as_str(), wrong_runtime.display().to_string(), now.as_str()],
            )
            .expect("runtime state with wrong path should insert");

        let task = tasks::create_task(
            &mut connection,
            Some("project-client"),
            TaskUpsertInput {
                title: "Project-scoped agent task".into(),
                description: Some("Ensure runtime cwd comes from the task project.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent-project".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-client".into()),
                repository_ids: vec!["repo-client".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("agent lane should dispatch with project-scoped runtime");
        assert_eq!(
            assignment.runtime_cwd.as_deref(),
            Some(project_root.to_string_lossy().as_ref())
        );
        assert_ne!(
            assignment.runtime_cwd.as_deref(),
            Some(wrong_runtime.to_string_lossy().as_ref())
        );
    }

    #[test]
    fn blocked_role_task_cleanup_cancels_open_claims_without_unblocking() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Blocked Cleanup Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("low".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let project_root = init_test_repo("task-runtime-blocked-role-cleanup");
        insert_project_and_repository(
            &connection,
            "project-role-blocked",
            "project-role-blocked",
            "repo-role-blocked",
            "repo-role-blocked",
            "Blocked Role Repo",
            &project_root,
        );

        let task = tasks::create_task(
            &mut connection,
            Some("project-role-blocked"),
            TaskUpsertInput {
                title: "Role blocked cleanup".into(),
                description: Some("Dispatch, then block it.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-role-blocked".into()),
                repository_ids: vec!["repo-role-blocked".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("role task should dispatch");
        assert_eq!(assignment.worker_type, "role");
        assert!(assignment.session_id.is_some());
        let role_instance_id = assignment
            .role_instance_id
            .clone()
            .expect("role assignment should have instance");

        let blocked = tasks::update_task(
            &mut connection,
            &task.id,
            TaskUpsertInput {
                title: task.title.clone(),
                description: task.description.clone(),
                task_type: task.task_type.clone(),
                tags: task.tags.clone(),
                status: "blocked".into(),
                priority: task.priority.clone(),
                workflow_id: task.workflow_id.clone(),
                current_lane_id: task.current_lane_id.clone(),
                assignee_type: task.assignee_type.clone(),
                assignee_id: task.assignee_id.clone(),
                repository_id: task.repository_id.clone(),
                repository_ids: task.repository_ids.clone(),
                parent_task_id: task.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should become blocked");
        assert_eq!(blocked.status, "blocked");
        assert!(blocked.active_lane_assignment.is_some());

        let cleanup = clear_task_runtime_claims_preserving_status(
            &mut connection,
            &task.id,
            Some("Task is blocked".into()),
        )
        .expect("blocked cleanup should succeed");
        assert!(cleanup.changed);
        assert_eq!(cleanup.assignments.len(), 1);

        let reloaded = tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(reloaded.status, "blocked");
        assert!(reloaded.active_lane_assignment.is_none());

        let assignment_status: String = connection
            .query_row(
                "SELECT status FROM task_lane_assignments WHERE id = ?1",
                [assignment.id.as_str()],
                |row| row.get(0),
            )
            .expect("assignment should load");
        assert_eq!(assignment_status, "canceled");

        let role_queue_status: String = connection
            .query_row(
                "SELECT status FROM role_queue_entries WHERE source_task_id = ?1 ORDER BY created_at DESC LIMIT 1",
                [task.id.as_str()],
                |row| row.get(0),
            )
            .expect("role queue entry should load");
        assert_eq!(role_queue_status, "canceled");

        let (role_instance_status, role_instance_session): (String, Option<String>) = connection
            .query_row(
                "SELECT status, session_id FROM role_instances WHERE id = ?1",
                [role_instance_id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("role instance should load");
        assert_eq!(role_instance_status, "canceled");
        assert!(role_instance_session.is_none());
    }

    #[test]
    fn blocked_agent_task_cleanup_releases_runtime_capacity() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Blocked Cleanup Agent".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("low".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Agent Blocked Cleanup Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Handle the task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("task-runtime-blocked-agent-cleanup");
        insert_project_and_repository(
            &connection,
            "project-agent-blocked",
            "project-agent-blocked",
            "repo-agent-blocked",
            "repo-agent-blocked",
            "Blocked Agent Repo",
            &project_root,
        );

        let task = tasks::create_task(
            &mut connection,
            Some("project-agent-blocked"),
            TaskUpsertInput {
                title: "Agent blocked cleanup".into(),
                description: Some("Dispatch, then block it.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-agent-blocked".into()),
                repository_ids: vec!["repo-agent-blocked".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("agent task should dispatch");
        assert_eq!(assignment.worker_type, "agent");
        assert!(assignment.session_id.is_some());

        let blocked = tasks::update_task(
            &mut connection,
            &task.id,
            TaskUpsertInput {
                title: task.title.clone(),
                description: task.description.clone(),
                task_type: task.task_type.clone(),
                tags: task.tags.clone(),
                status: "blocked".into(),
                priority: task.priority.clone(),
                workflow_id: task.workflow_id.clone(),
                current_lane_id: task.current_lane_id.clone(),
                assignee_type: task.assignee_type.clone(),
                assignee_id: task.assignee_id.clone(),
                repository_id: task.repository_id.clone(),
                repository_ids: task.repository_ids.clone(),
                parent_task_id: task.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should become blocked");
        assert_eq!(blocked.status, "blocked");
        assert!(blocked.active_lane_assignment.is_some());

        let cleanup = clear_task_runtime_claims_preserving_status(
            &mut connection,
            &task.id,
            Some("Task is blocked".into()),
        )
        .expect("blocked cleanup should succeed");
        assert!(cleanup.changed);

        let reloaded = tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(reloaded.status, "blocked");
        assert!(reloaded.active_lane_assignment.is_none());

        let queue_status: String = connection
            .query_row(
                "SELECT status FROM agent_queue_entries WHERE source_task_id = ?1 ORDER BY created_at DESC LIMIT 1",
                [task.id.as_str()],
                |row| row.get(0),
            )
            .expect("agent queue entry should load");
        assert_eq!(queue_status, "canceled");

        let (runtime_status, current_queue_entry_id): (String, Option<String>) = connection
            .query_row(
                "SELECT status, current_queue_entry_id FROM agent_runtime_states WHERE project_id = ?1 AND agent_id = ?2",
                ["orchestra", agent.id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .expect("agent runtime should load");
        assert_eq!(runtime_status, "idle");
        assert!(current_queue_entry_id.is_none());
    }

    #[test]
    fn initially_blocked_tasks_cannot_dispatch_or_validate_queue_sources() {
        let mut connection = in_memory_connection();
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Dispatch Guard Role".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Blocked Dispatch Guard Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-role".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("task-runtime-initially-blocked");
        insert_project_and_repository(
            &connection,
            "project-initially-blocked",
            "project-initially-blocked",
            "repo-initially-blocked",
            "repo-initially-blocked",
            "Initially Blocked Repo",
            &project_root,
        );

        let task = tasks::create_task(
            &mut connection,
            Some("project-initially-blocked"),
            TaskUpsertInput {
                title: "Initially blocked task".into(),
                description: Some("Should not dispatch while blocked.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "blocked".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-role".into()),
                assignee_type: "role".into(),
                assignee_id: Some(role.slug.clone()),
                repository_id: Some("repo-initially-blocked".into()),
                repository_ids: vec!["repo-initially-blocked".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let error = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect_err("initially blocked task should not dispatch");
        assert!(error.contains("blocked and cannot be dispatched"));
        assert!(!task_lane_queue_source_is_valid(
            &connection,
            &task.id,
            task.workflow_id.as_deref(),
            task.current_lane_id
                .as_deref()
                .expect("task should have lane"),
        )
        .expect("queue source validation should succeed"));
    }

    #[test]
    fn blocked_active_tasks_are_not_reported_as_stale_runtime_claims() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Stale Guard Agent".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Blocked Active Stale Guard Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
                    entry_prompt_template: Some("Implement the task.".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("task-runtime-blocked-active-stale-guard");
        insert_project_and_repository(
            &connection,
            "project-blocked-active-stale",
            "project-blocked-active-stale",
            "repo-blocked-active-stale",
            "repo-blocked-active-stale",
            "Blocked Active Stale Repo",
            &project_root,
        );

        let task = tasks::create_task(
            &mut connection,
            Some("project-blocked-active-stale"),
            TaskUpsertInput {
                title: "Blocked active task".into(),
                description: Some("Should stay active until it tries to transition.".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.id.clone()),
                repository_id: Some("repo-blocked-active-stale".into()),
                repository_ids: vec!["repo-blocked-active-stale".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = pi_sessions::detect_session_context(Some("orchestra"))
            .expect("session context should resolve")
            .session_dir;
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let session = pi_sessions::create_session_file(
            &project_root,
            &session_dir,
            Some("blocked active stale guard session"),
            false,
        )
        .expect("session should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-blocked-active-stale', ?1, ?2, 'lane-agent', 'agent', ?3, 'active', ?4, ?5, NULL, NULL, 'Prompt', 0, NULL, ?6, NULL, ?6, ?6)",
                params![
                    task.id.as_str(),
                    workflow.id.as_str(),
                    agent.id.as_str(),
                    session.record.id.as_str(),
                    project_root.display().to_string(),
                    now.as_str(),
                ],
            )
            .expect("active assignment should insert");

        let blocked = tasks::update_task(
            &mut connection,
            &task.id,
            TaskUpsertInput {
                title: task.title.clone(),
                description: task.description.clone(),
                task_type: task.task_type.clone(),
                tags: task.tags.clone(),
                status: "blocked".into(),
                priority: task.priority.clone(),
                workflow_id: task.workflow_id.clone(),
                current_lane_id: task.current_lane_id.clone(),
                assignee_type: task.assignee_type.clone(),
                assignee_id: task.assignee_id.clone(),
                repository_id: task.repository_id.clone(),
                repository_ids: task.repository_ids.clone(),
                parent_task_id: task.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should become blocked");
        assert_eq!(blocked.status, "blocked");
        assert!(blocked.active_lane_assignment.is_some());

        let candidates = find_stale_task_assignment_candidates(&connection)
            .expect("stale assignment candidates should load");
        assert!(
            candidates
                .iter()
                .all(|candidate| candidate.task_id != task.id),
            "blocked active assignment should not be reported as stale"
        );
    }

    #[test]
    fn preferred_lane_session_is_scoped_to_the_current_worker_owner() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Session reuse test".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
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
        let now = now_iso();

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-role', ?2, 'workflow-1', 'lane-1', 'role', 'role-1', 'failed',
                    'session-role', NULL, NULL, 'instance-1', NULL,
                    ?1, ?1, ?1, ?1
                )
                "#,
                params![now.as_str(), task.id.as_str()],
            )
            .expect("role assignment should insert");

        let role_session = preferred_lane_session_id(
            &connection,
            task.id.as_str(),
            "lane-1",
            "role",
            Some("role-1"),
        )
        .expect("role preferred session should resolve");
        assert_eq!(role_session.as_deref(), Some("session-role"));

        let changed_role_session = preferred_lane_session_id(
            &connection,
            task.id.as_str(),
            "lane-1",
            "role",
            Some("role-2"),
        )
        .expect("different role should not reuse old session");
        assert!(changed_role_session.is_none());

        let agent_session = preferred_lane_session_id(
            &connection,
            task.id.as_str(),
            "lane-1",
            "agent",
            Some("agent-1"),
        )
        .expect("agent lookup should not reuse role session");
        assert!(agent_session.is_none());
    }

    #[test]
    fn complete_lane_ignores_newer_open_assignment_on_a_different_lane() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let project_root = init_test_repo("task-runtime-stale-lane-owner");
        let session_dir = project_root.parent().unwrap().join("sessions");
        std::fs::create_dir_all(&session_dir).expect("session dir should create");

        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "False lane owner failure".into(),
                description: Some(
                    "Current lane assignment should win over stale open rows.".into(),
                ),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-review".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let now = now_iso();
        let later = "2999-01-01T00:00:00Z";

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    pending_outcome, completion_notes, whip_count, last_whip_at,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-stale', ?1, ?2, 'lane-implement', 'role', ?3, 'active',
                    'session-stale', NULL, NULL, 'instance-stale', 'Stale assignment',
                    NULL, NULL, 0, NULL,
                    ?4, NULL, ?4, ?5
                )
                "#,
                params![
                    task.id.as_str(),
                    workflow.id.as_str(),
                    role.id.as_str(),
                    now.as_str(),
                    later
                ],
            )
            .expect("stale assignment should insert");
        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    pending_outcome, completion_notes, whip_count, last_whip_at,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-current', ?1, ?2, 'lane-review', 'agent', ?3, 'active',
                    'session-current', NULL, NULL, NULL, 'Current assignment',
                    NULL, NULL, 0, NULL,
                    ?4, NULL, ?4, ?4
                )
                "#,
                params![
                    task.id.as_str(),
                    workflow.id.as_str(),
                    agent.id.as_str(),
                    now.as_str()
                ],
            )
            .expect("current assignment should insert");

        let updated = complete_lane_as_success(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
            Some("Finished review".into()),
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: agent.id.clone(),
            }),
        )
        .expect("completion should use the current lane assignment");
        assert_eq!(updated.status, "completed");
        assert!(updated.active_lane_assignment.is_none());
    }

    #[test]
    fn session_assignment_lookup_ignores_open_rows_for_non_current_lanes() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Developer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let workflow = create_workflow_with_lanes(&mut connection, &role.slug, &agent.slug);
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Session auth lookup".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-review".into()),
                assignee_type: "agent".into(),
                assignee_id: Some(agent.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let now = now_iso();
        let later = "2999-01-01T00:00:00Z";

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    pending_outcome, completion_notes, whip_count, last_whip_at,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-session-stale', ?1, ?2, 'lane-implement', 'agent', 'agent-old', 'active',
                    'session-shared', NULL, NULL, NULL, 'Stale',
                    NULL, NULL, 0, NULL,
                    ?3, NULL, ?3, ?4
                )
                "#,
                params![task.id.as_str(), workflow.id.as_str(), now.as_str(), later],
            )
            .expect("stale session assignment should insert");
        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    pending_outcome, completion_notes, whip_count, last_whip_at,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-session-current', ?1, ?2, 'lane-review', 'agent', ?3, 'active',
                    'session-shared', NULL, NULL, NULL, 'Current',
                    NULL, NULL, 0, NULL,
                    ?4, NULL, ?4, ?4
                )
                "#,
                params![
                    task.id.as_str(),
                    workflow.id.as_str(),
                    agent.id.as_str(),
                    now.as_str()
                ],
            )
            .expect("current session assignment should insert");

        let assignment = get_active_assignment_for_session(&connection, "session-shared")
            .expect("session lookup should succeed")
            .expect("session should resolve an active assignment");
        assert_eq!(assignment.id, "assignment-session-current");
        assert_eq!(assignment.lane_id, "lane-review");
    }
}
