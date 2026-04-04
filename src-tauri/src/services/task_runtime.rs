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
        agent_runtime, agents, live_sessions, messages, pi_sessions, project_settings,
        projects, role_dispatch, role_runtime, task_repositories, tasks, workflows,
    },
    state::{generate_id, now_iso, AppState},
};

const ASSIGNMENT_STATUS_QUEUED: &str = "queued";
const ASSIGNMENT_STATUS_ACTIVE: &str = "active";
const ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL: &str = "awaiting_user_approval";
const ASSIGNMENT_STATUS_COMPLETED: &str = "completed";
const ASSIGNMENT_STATUS_FAILED: &str = "failed";
const ASSIGNMENT_STATUS_CANCELED: &str = "canceled";
const DEFAULT_TASK_WHIP_MAX_ATTEMPTS: i64 = 10;
const TASK_WHIP_PROMPT: &str = "Keep working until you are done - when you are done use tool `complete_lane_as_success` (with the task ID and optional notes) unless you believe either you or the task that was sent to you failed - then use tool `complete_lane_as_failure` (with task ID and optional notes). If you believe you need to escalate to the user - use tool `request_user_intervention` (with task ID and optional notes).";

pub fn get_active_lane_assignment(
    connection: &Connection,
    task_id: &str,
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
            WHERE task_id = ?1 AND status IN ('queued', 'active')
            ORDER BY updated_at DESC, created_at DESC
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
            WHERE task_id = ?1 AND status IN ('queued', 'active', 'awaiting_user_approval')
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            "#,
            [task_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| format!("Unable to query current assignment for task {task_id}: {error}"))
}

pub fn get_active_assignment_for_session(
    connection: &Connection,
    session_id: &str,
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
            WHERE session_id = ?1 AND status IN ('queued', 'active')
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            "#,
            [session_id],
            read_assignment,
        )
        .optional()
        .map_err(|error| format!("Unable to query assignment for session {session_id}: {error}"))
}

pub fn reset_task_runtime(
    connection: &mut Connection,
    task_id: &str,
) -> Result<TaskDetail, String> {
    let task = tasks::get_task_context(connection, task_id)?;
    let assignment = get_current_lane_assignment(connection, task_id)?;
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task reset transaction: {error}"))?;

    tx.execute(
        "UPDATE task_lane_assignments SET status = ?2, pending_outcome = NULL, completion_notes = NULL, completed_at = ?3, updated_at = ?3 WHERE task_id = ?1 AND status IN ('queued', 'active', 'awaiting_user_approval')",
        params![task_id, ASSIGNMENT_STATUS_CANCELED, now],
    )
    .map_err(|error| format!("Unable to clear task lane assignments for {task_id}: {error}"))?;

    tx.execute(
        "UPDATE tasks SET status = 'ready', updated_at = ?2 WHERE id = ?1 AND status IN ('in_progress', 'in_review', 'blocked')",
        params![task_id, now],
    )
    .map_err(|error| format!("Unable to reset task status for {task_id}: {error}"))?;

    tx.execute(
        "UPDATE agent_queue_entries SET status = 'completed', completed_at = ?2, updated_at = ?2 WHERE source_task_id = ?1 AND status IN ('queued', 'dispatched')",
        params![task_id, now],
    )
    .map_err(|error| format!("Unable to clear agent queue entries for {task_id}: {error}"))?;

    tx.execute(
        "UPDATE role_queue_entries SET status = 'canceled', completed_at = ?2, updated_at = ?2 WHERE source_task_id = ?1 AND status IN ('queued', 'assigned')",
        params![task_id, now],
    )
    .map_err(|error| format!("Unable to clear role queue entries for {task_id}: {error}"))?;

    if let Some(active_assignment) = assignment.as_ref() {
        if let Some(worker_id) = active_assignment.worker_id.as_deref() {
            if active_assignment.worker_type == "agent" {
                tx.execute(
                    "UPDATE agent_runtime_states SET status = 'idle', current_queue_entry_id = NULL, updated_at = ?3 WHERE project_id = ?1 AND agent_id = ?2",
                    params![task.project_id, worker_id, now],
                )
                .map_err(|error| format!("Unable to reset agent runtime state for task {task_id}: {error}"))?;
            }
        }

        if let Some(role_instance_id) = active_assignment.role_instance_id.as_deref() {
            tx.execute(
                "UPDATE role_instances SET status = 'idle', current_queue_entry_id = NULL, last_error = NULL, updated_at = ?2 WHERE id = ?1",
                params![role_instance_id, now],
            )
            .map_err(|error| format!("Unable to reset role instance for task {task_id}: {error}"))?;
        }
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit task reset transaction: {error}"))?;

    tasks::get_task_context(connection, task_id)
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
    if let Some(active) = get_active_lane_assignment(connection, task_id)? {
        return Ok(active);
    }

    let task = tasks::get_task_context(connection, task_id)?;
    let workflow = load_task_workflow(connection, &task)?;
    let lane = resolve_task_lane(&workflow, &task)?;
    let runtime_project_root = resolve_task_runtime_project_root(connection, project_root, &task)?;

    if task.archived {
        return Err(format!(
            "Task {task_id} is archived and cannot be dispatched"
        ));
    }

    if task.dependency_blocked {
        return Err(format!(
            "Task {task_id} is blocked by unresolved dependencies"
        ));
    }

    if lane.assigned_entity_type == "user" {
        return Err(format!(
            "Task {} is currently in user-owned lane {} and cannot be dispatched to runtime",
            task.id, lane.name
        ));
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
    if task.archived
        || task.dependency_blocked
        || !matches!(task.status.as_str(), "ready" | "in_progress")
    {
        return Ok(None);
    }

    let workflow = match load_task_workflow(connection, &task) {
        Ok(workflow) => workflow,
        Err(_) => return Ok(None),
    };
    let lane = resolve_task_lane(&workflow, &task)?;
    if lane.assigned_entity_type == "user" {
        return Ok(None);
    }

    dispatch_task_lane(connection, project_root, session_dir, task_id).map(Some)
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
                  AND ri.status = 'idle'
                  AND ri.current_queue_entry_id IS NULL
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
        return Ok(task_repositories::task_workspace_root(runtime_cwd, &task.id));
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
        return Ok(Some(task_repositories::task_workspace_root(runtime_cwd, task_id)));
    }

    let shared_workspace_root = pi_sessions::session_context_for_project_id(project_id)
        .map(|context| task_repositories::shared_task_workspaces_root(&context.project_root))
        .unwrap_or_else(|_| runtime_cwd.to_string());
    Ok(Some(task_repositories::task_workspace_root(
        &shared_workspace_root,
        task_id,
    )))
}

pub fn ensure_task_repository_workspaces(task: &TaskDetail, task_workspace_root: &str) -> Result<(), String> {
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
    let Some(session_id) = assignment.session_id.as_deref() else {
        return Ok(None);
    };
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(None);
    };

    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        session_dir,
        session_id,
    )?;

    Ok(Some((session_id.to_string(), runtime)))
}

fn start_assignment_prompt(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    prompt: &str,
) -> Result<(), String> {
    let Some((session_id, runtime)) = ensure_assignment_runtime(app, state, session_dir, assignment)? else {
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
    let Some((_session_id, runtime)) = ensure_assignment_runtime(app, state, session_dir, assignment)? else {
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
    complete_lane(
        connection,
        project_root,
        session_dir,
        task_id,
        "success",
        notes,
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
    complete_lane(
        connection,
        project_root,
        session_dir,
        task_id,
        "failure",
        notes,
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
    complete_lane(
        connection,
        project_root,
        session_dir,
        task_id,
        "needs_user",
        notes,
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
        worker_type_label: "role",
        worker_name: role.name.clone(),
        worker_slug: role.slug.clone(),
        system_prompt: normalize_optional(role.system_prompt.clone()),
        project_overlay_prompt: load_worker_overlay_prompt(connection, task, "role", &role.slug)?,
    };
    let queued_workspace_cwd = if lane_uses_separate_worktree(lane) {
        None
    } else {
        Some(resolve_lane_workspace_cwd(connection, project_root, task, lane, None)?)
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
    let agent = get_agent_by_slug(connection, agent_slug)?;
    let worker_prompt = WorkerPromptContext {
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
    let task_workspace_cwd = resolve_lane_workspace_cwd(connection, project_root, task, lane, Some(runtime_cwd.as_str()))?;
    ensure_task_repository_workspaces(task, &task_workspace_cwd)?;
    let session_id = if let Some(existing_session_id) = runtime_state.main_session_id.clone() {
        if pi_sessions::get_session(session_dir, &existing_session_id, false).is_ok() {
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
    let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
        connection,
        &task.project_id,
        &agent.id,
        Some(&session_id),
        Some(&runtime_cwd),
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
        &task.project_id,
        &agent.id,
        Some(&session_id),
        Some(&runtime_cwd),
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
        runtime_cwd: Some(runtime_cwd.clone()),
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
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskDetail, String> {
    let active_assignment = get_active_lane_assignment(connection, task_id)?;
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
    } else if !(task.assignee_type == "user" && task.status == "in_review") {
        return Err(format!("Task {task_id} has no active lane assignment"));
    }

    let now = now_iso();
    let normalized_notes = normalize_optional(notes);

    if let Some(assignment) = active_assignment.as_ref() {
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
            move_task_to_user_review(connection, &task.id, &lane.id, &now)?;
            return tasks::get_task_context(connection, task_id);
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
    Ok(updated)
}

pub fn approve_pending_lane_completion(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    task_id: &str,
) -> Result<TaskDetail, String> {
    let assignment = get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Task {task_id} has no lane assignment awaiting approval"))?;
    if assignment.status != ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL {
        return Err(format!("Task {task_id} is not awaiting user approval"));
    }

    let task = tasks::get_task_context(connection, task_id)?;
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
    tasks::get_task_context(connection, task_id)
}

pub fn send_lane_back_for_work(
    connection: &Connection,
    task_id: &str,
) -> Result<TaskLaneAssignment, String> {
    let assignment = get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Task {task_id} has no lane assignment awaiting approval"))?;
    if assignment.status != ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL {
        return Err(format!("Task {task_id} is not awaiting user approval"));
    }

    let now = now_iso();
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
            params![assignment.id, ASSIGNMENT_STATUS_ACTIVE, now],
        )
        .map_err(|error| format!("Unable to reactivate lane assignment {}: {error}", assignment.id))?;

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
        .map_err(|error| format!("Unable to send task {} back for work: {error}", task_id))?;

    get_current_lane_assignment(connection, task_id)?
        .ok_or_else(|| format!("Unable to reload reactivated lane assignment for task {task_id}"))
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
            params![assignment_id, ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL, notes, now],
        )
        .map_err(|error| {
            format!(
                "Unable to mark task lane assignment {} awaiting user approval: {error}",
                assignment_id
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
            if outcome == "failure" { notes.clone() } else { None },
        )?;
    }

    if assignment.worker_type == "agent" {
        if let Some(agent_id) = assignment.worker_id.as_deref() {
            if let Some(runtime_state) = agent_runtime::get_agent_runtime_state_for_project(connection, &task.project_id, agent_id)? {
                if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
                    if outcome == "failure" {
                        agent_runtime::mark_agent_queue_entry_failed(connection, queue_entry_id)?;
                    } else {
                        agent_runtime::mark_agent_queue_entry_completed(connection, queue_entry_id)?;
                    }
                }
                let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                    connection,
                    &task.project_id,
                    agent_id,
                    assignment.session_id.as_deref(),
                    assignment.runtime_cwd.as_deref(),
                    None,
                    if outcome == "failure" { "needs_attention" } else { "idle" },
                    if outcome == "failure" { notes.as_deref() } else { None },
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

fn get_agent_by_slug(connection: &Connection, agent_slug: &str) -> Result<AgentDefinition, String> {
    let agent_id = connection
        .query_row(
            "SELECT id FROM agents WHERE slug = ?1 LIMIT 1",
            [agent_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query agent slug {agent_slug}: {error}"))?
        .ok_or_else(|| format!("Agent {agent_slug} was not found"))?;
    agents::get_agent(connection, &agent_id)
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

fn apply_agent_session_defaults(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    agent: &AgentDefinition,
) -> Result<(), String> {
    if let (Some(provider), Some(model)) = (agent.provider.as_deref(), agent.model.as_deref()) {
        let _ =
            pi_sessions::set_session_model(project_root, session_dir, session_id, provider, model)?;
    }
    let _ = pi_sessions::set_session_thinking_level(
        project_root,
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
        "8. If the work needs to be split, create_subtask and describe the smaller unit clearly.",
        "9. If another task must finish first, add_task_dependency. If a dependency is no longer correct, remove_task_dependency.",
        "10. Attach important artifacts with add_task_attachment when they would help review, handoff, or future execution.",
        "11. If you create or materially change a large or central repository file that should stay visible on the task — such as a design doc, architecture note, ADR, diagram source, migration plan, runbook, or other non-source artifact — record it with add_task_file_reference.",
        "12. Do not add normal source code or test file edits as task file references unless the human explicitly asked for that file to be tracked on the task.",
        "13. Use list_task_comments when you need the full threaded discussion instead of only the recent comment summary in task context.",
        "14. Before you transition the task or request help, add a comment explaining exactly what happened, what changed, and why you are choosing that transition or asking for help.",
        "15. When the lane is finished, explicitly transition it with the correct completion tool.",
    ]
    .join("\n")
}

fn orchestra_tool_help_block() -> String {
    [
        "Available Orchestra task tools and exactly how to use them:",
        "- These names are real Orchestra tools/functions exposed in this session. You must invoke them as tool calls, not merely mention them in prose.",
        "- get_task_context(taskId): Call this tool when you need the freshest full task state. Use it before making decisions if comments, attachments, dependencies, subtasks, or assignment state may have changed.",
        "- list_task_comments(taskId): Call this tool when you need the full threaded task discussion, including replies and parent-child comment relationships.",
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

    for comment in comments.iter().filter(|comment| recent_ids.contains(comment.id.as_str())) {
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
        rendered.push(format!("- {}{}: {}", comment.author, anchor_label, comment.message));
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
            rendered.push(format!("  ↳ {}{}: {}", reply.author, reply_anchor_label, reply.message));
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
    let prompt_settings = project_settings::get_session_prompt_settings(&project_slug)
        .unwrap_or_else(|_| crate::models::ProjectSessionPromptSettings {
            project_slug: project_slug.clone(),
            template: project_settings::default_task_session_context_template(),
            default_template: project_settings::default_task_session_context_template(),
            available_tokens: project_settings::available_session_prompt_tokens(),
            updated_at: None,
        });

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
                let workspace_path = task_workspace_cwd
                    .map(|workspace_root| task_repositories::task_repository_worktree_path(workspace_root, &repository.repository_slug));
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

    let mut rendered = prompt_settings.template;
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
            build_worker_context_block(worker_prompt),
        ),
        ("{RUNTIME.CWD}", task_workspace_cwd.unwrap_or("").to_string()),
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

    if lane.require_user_approval_on_success && matches!(lane.assigned_entity_type.as_str(), "agent" | "role") {
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
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::{
        models::{
            AgentUpsertInput, RoleUpsertInput, TaskUpsertInput, WorkflowLaneInput,
            WorkflowUpsertInput,
        },
        services::{agents, database, roles, tasks, workflows},
    };

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
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
                thinking_level: Some("medium".into()),
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
                "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'repo-prompt', ?1, ?1)",
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
        assert!(prompt.contains("- comment_on_task(taskId, author, message, interruptAgent?, parentCommentId?): Call this tool to leave a durable note in Orchestra."));
        assert!(prompt.contains("call get_unread_task_comments using the canonical task ID"));
        assert!(prompt.contains("call mark_task_comments_read so Orchestra knows you saw them"));
        assert!(prompt.contains("call get_unread_mail using the canonical task ID"));
        assert!(prompt.contains("call mark_mail_read so Orchestra knows you handled it"));
        assert!(prompt.contains("Whenever you take or finish a large action, leave a durable comment with comment_on_task"));
        assert!(prompt.contains("If you create or materially change a large or central repository file that should stay visible on the task"));
        assert!(prompt.contains("Do not add normal source code or test file edits as task file references unless the human explicitly asked"));
        assert!(prompt.contains("Before you transition the task or request help, add a comment explaining exactly what happened"));
        assert!(prompt.contains(
            "- get_unread_task_comments(taskId): Call this tool whenever you resume work"
        ));
        assert!(prompt.contains("- mark_task_comments_read(taskId, commentIds?): After you read and incorporate unread task comments"));
        assert!(prompt.contains("- get_unread_mail(taskId?): Call this tool whenever you resume work"));
        assert!(prompt.contains("- mark_mail_read(taskId?, deliveryIds?): After you read and handle unread mail"));
        assert!(prompt.contains("- complete_lane_as_success(task_id, notes?): Call this tool"));
        assert!(prompt.contains("- complete_lane_as_failure(task_id, notes?): Call this tool"));
        assert!(prompt.contains("- request_user_intervention(task_id, notes?): Call this tool"));
        assert!(prompt
            .contains("You must end this lane by invoking exactly one Orchestra completion tool"));
        assert!(prompt
            .contains("Immediately before any completion tool, call get_unread_task_comments"));
        assert!(prompt
            .contains("Immediately before any completion tool, call get_unread_mail"));
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
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
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
                "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('project-1', 'prompt-project', 'Prompt Project', NULL, NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should insert");

        let previous_home = std::env::var_os("HOME");
        let temp_home = unique_temp_dir("session-prompt-template-home");
        std::fs::create_dir_all(&temp_home).expect("temp home should create");
        unsafe {
            std::env::set_var("HOME", &temp_home);
        }
        let orchestra_root = crate::services::orchestra_paths::default_orchestra_root()
            .expect("orchestra root should resolve");
        project_settings::update_session_prompt_settings_in(
            &orchestra_root,
            "prompt-project",
            Some("Task {TASK.ID} {TASK.SLUG} {TASK.NAME} {WORKFLOW.NAME} {LANE.NAME} {LANE.OWNER} {TASK.STATUS} {TASK.ASSIGNEE}\n{TASK.DESCRIPTION}\n{TASK.COMMENTS}".into()),
        ).expect("session prompt template should save");

        let task = TaskDetail {
            id: "task-123".into(),
            project_id: "project-1".into(),
            number: "ORC-123".into(),
            title: "Investigate runtime prompt".into(),
            description: Some("Describe the task.".into()),
            task_type: "task".into(),
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
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
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

        match previous_home {
            Some(value) => unsafe {
                std::env::set_var("HOME", value);
            },
            None => unsafe {
                std::env::remove_var("HOME");
            },
        }
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
                thinking_level: Some("medium".into()),
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
            .map(|cwd| {
                task_repositories::task_repository_worktree_path(cwd, "runtime-role")
            })
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
        let session_id = assignment.session_id.clone().expect("session id should exist");

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
        assert_eq!(awaiting_review.current_lane_id.as_deref(), Some("lane-implement"));
        assert_eq!(
            awaiting_review.active_lane_assignment.as_ref().map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL)
        );
        assert_eq!(
            awaiting_review.active_lane_assignment.as_ref().and_then(|entry| entry.session_id.as_deref()),
            Some(session_id.as_str())
        );
        assert_eq!(awaiting_review.lane_runs.len(), 1);
        assert!(awaiting_review.lane_runs[0].completed_at.is_none());

        let reactivated_assignment = send_lane_back_for_work(&connection, &task.id)
            .expect("lane should reactivate for rework");
        assert_eq!(reactivated_assignment.status, ASSIGNMENT_STATUS_ACTIVE);
        assert_eq!(reactivated_assignment.session_id.as_deref(), Some(session_id.as_str()));
        let reactivated_task = tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(reactivated_task.status, "in_progress");
        assert_eq!(reactivated_task.assignee_type, "role");

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
            awaiting_review_again.active_lane_assignment.as_ref().map(|entry| entry.status.as_str()),
            Some(ASSIGNMENT_STATUS_AWAITING_USER_APPROVAL)
        );

        let approved = approve_pending_lane_completion(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
        )
        .expect("approval should finish the lane");
        assert_eq!(approved.status, "completed");
        assert!(approved.active_lane_assignment.is_none());
        assert_eq!(approved.lane_runs.len(), 1);
        assert_eq!(approved.lane_runs[0].result, "success");
        assert!(approved.lane_runs[0].completed_at.is_some());
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
                thinking_level: Some("medium".into()),
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
                thinking_level: Some("medium".into()),
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
                thinking_level: Some("medium".into()),
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
                thinking_level: Some("medium".into()),
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
                thinking_level: Some("medium".into()),
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
        assert!(updated.active_lane_assignment.is_none());
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
                thinking_level: Some("low".into()),
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
        let agent_workspace_cwd = task_repositories::task_workspace_root(
            &task_repositories::shared_task_workspaces_root(&root),
            &task.id,
        );
        let agent_repo_workspace = task_repositories::task_repository_worktree_path(
            &agent_workspace_cwd,
            "runtime-agent",
        );
        assert!(Path::new(&agent_repo_workspace).exists());

        let updated =
            complete_lane_as_success(&mut connection, &root, &session_dir, &task.id, None, None)
                .expect("agent lane should complete");
        assert_eq!(updated.status, "completed");
        assert!(updated.active_lane_assignment.is_none());
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
                thinking_level: Some("low".into()),
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
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, NULL, ?1, ?1)",
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
        assert!(awaiting_review.active_lane_assignment.is_none());

        let updated = complete_lane_as_failure(
            &mut connection,
            &root,
            &session_dir,
            &task.id,
            Some("Needs more work".into()),
            None,
        )
        .expect("user review should be able to send the lane back as failure without an active assignment");
        assert_eq!(updated.status, "blocked");
        assert_eq!(updated.assignee_type, "user");
        assert!(updated.active_lane_assignment.is_none());
    }

    #[test]
    fn agent_lane_uses_project_scoped_runtime_state_instead_of_default_project_runtime() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Project Agent".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                thinking_level: Some("medium".into()),
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
        let project_root = init_test_repo("task-runtime-project-scoped-agent");
        let wrong_runtime = unique_temp_dir("wrong-agent-runtime");
        fs::create_dir_all(&wrong_runtime).expect("wrong runtime dir should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('project-client', 'client-project', 'Client Project', NULL, NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-client', 'project-client', 'client-repo', 'Client Repo', ?1, NULL, 'main', ?2, ?2)",
                params![project_root.display().to_string(), now.as_str()],
            )
            .expect("repository should insert");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'idle', 'session-old', ?2, NULL, NULL, NULL, ?3, ?3)",
                params![agent.id.as_str(), wrong_runtime.display().to_string(), now.as_str()],
            )
            .expect("default-project runtime state should insert");

        let task = tasks::create_task(
            &mut connection,
            Some("project-client"),
            TaskUpsertInput {
                title: "Project-scoped agent task".into(),
                description: Some("Ensure runtime cwd comes from the task project.".into()),
                task_type: "task".into(),
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
    fn preferred_lane_session_is_scoped_to_the_current_worker_owner() {
        let mut connection = in_memory_connection();
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Session reuse test".into(),
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
}

