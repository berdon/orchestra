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
        agent_runtime, agents, live_sessions, pi_sessions, project_settings, projects,
        role_dispatch, role_runtime, task_repositories, tasks, workflows,
    },
    state::{generate_id, now_iso, AppState},
};

const ASSIGNMENT_STATUS_QUEUED: &str = "queued";
const ASSIGNMENT_STATUS_ACTIVE: &str = "active";
const ASSIGNMENT_STATUS_COMPLETED: &str = "completed";
const ASSIGNMENT_STATUS_FAILED: &str = "failed";
const ASSIGNMENT_STATUS_CANCELED: &str = "canceled";

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
                row.get::<_, String>(17)?,
                row.get::<_, String>(18)?,
                row.get::<_, String>(16)?,
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

fn load_worker_overlay_prompt(
    connection: &Connection,
    task: &TaskDetail,
    worker_type: &str,
    worker_slug: &str,
) -> Result<Option<String>, String> {
    let project = projects::get_project(connection, &task.project_id)?;
    Ok(project_settings::get_worker_overlay(&project.slug, worker_type, worker_slug)?.prompt)
}

fn ensure_task_repository_workspaces(task: &TaskDetail, base_cwd: &str) -> Result<(), String> {
    if task.task_repositories.is_empty() {
        return Ok(());
    }

    std::fs::create_dir_all(task_repositories::task_repositories_root(
        base_cwd, &task.id,
    ))
    .map_err(|error| {
        format!(
            "Unable to create task repository workspace root for task {}: {error}",
            task.id
        )
    })?;

    for repository in &task.task_repositories {
        ensure_task_repository_worktree(task, base_cwd, repository)?;
    }

    Ok(())
}

fn ensure_task_repository_worktree(
    task: &TaskDetail,
    base_cwd: &str,
    repository: &TaskRepository,
) -> Result<(), String> {
    let Some(managed_repository_path) = repository.managed_repository_path.as_deref() else {
        return Ok(());
    };

    let destination = task_repositories::task_repository_worktree_path(
        base_cwd,
        &task.id,
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

    let Some(session_id) = assignment.session_id.as_deref() else {
        return Ok(());
    };
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(());
    };
    let Some(prompt) = assignment.prompt.as_deref() else {
        return Ok(());
    };

    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        session_dir,
        session_id,
    )?;
    runtime.set_subscribed(true);

    let run_id = generate_id("task-run");
    state.begin_session_run(session_id, &run_id)?;
    match runtime.start_run(&run_id, prompt) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.end_session_run(session_id, &run_id);
            Err(error)
        }
    }
}

pub fn queue_comment_delivery(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    comment: &TaskComment,
) -> Result<(), String> {
    let message = format!(
        "Task comment from {}:\n\n{}",
        comment.author, comment.message
    );

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
                .map_err(|error| format!("Unable to resolve task project {}: {error}", assignment.task_id))?
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

pub fn maybe_interrupt_with_comment(
    app: AppHandle,
    state: &AppState,
    session_dir: PathBuf,
    assignment: &TaskLaneAssignment,
    comment: &TaskComment,
) -> Result<(), String> {
    if assignment.worker_type == "agent" {
        return Ok(());
    }
    if !comment.interrupt_agent || assignment.status != ASSIGNMENT_STATUS_ACTIVE {
        return Ok(());
    }

    let Some(session_id) = assignment.session_id.as_deref() else {
        return Ok(());
    };
    let Some(runtime_cwd) = assignment.runtime_cwd.as_deref() else {
        return Ok(());
    };

    let prompt = format!(
        "New task comment from {}. Interrupt current work and incorporate this guidance immediately.\n\n{}",
        comment.author, comment.message
    );

    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(runtime_cwd),
        session_dir,
        session_id,
    )?;
    runtime.set_subscribed(true);

    let run_id = generate_id("task-comment");
    state.begin_session_run(session_id, &run_id)?;
    match runtime.start_run(&run_id, &prompt) {
        Ok(()) => Ok(()),
        Err(error) => {
            let _ = state.end_session_run(session_id, &run_id);
            Err(error)
        }
    }
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
    let prompt = build_lane_prompt(
        task,
        workflow,
        lane,
        Some(project_root.display().to_string().as_str()),
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

    let runtime_state = agent_runtime::ensure_agent_runtime_state_for_project(connection, &task.project_id, &agent.id)?;
    let runtime_cwd = runtime_state
        .runtime_cwd
        .clone()
        .unwrap_or_else(|| project_root.display().to_string());
    ensure_task_repository_workspaces(task, &runtime_cwd)?;
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
        task,
        workflow,
        lane,
        Some(&runtime_cwd),
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
    ensure_lane_run(connection, task.id.as_str(), lane.id.as_str(), &session_id, now)?;
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
    .ok_or_else(|| format!("Unable to mark agent queue entry {} dispatched", queue_entry.id))?;
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
    } else if lane.assigned_entity_type != "user" {
        return Err(format!("Task {task_id} has no active lane assignment"));
    }

    let now = now_iso();
    let normalized_notes = normalize_optional(notes);

    if let Some(assignment) = active_assignment.as_ref() {
        update_open_lane_run(
            connection,
            task_id,
            &assignment.lane_id,
            assignment.session_id.as_deref(),
            outcome,
            normalized_notes.clone(),
            &now,
        )?;

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
                    normalized_notes.clone()
                } else {
                    None
                },
            )?;
        }

        if assignment.worker_type == "agent" {
            if let Some(agent_id) = assignment.worker_id.as_deref() {
                if let Some(runtime_state) = agent_runtime::get_agent_runtime_state_for_project(connection, &task.project_id, agent_id)? {
                    if let Some(queue_entry_id) = runtime_state.current_queue_entry_id.as_deref() {
                        if outcome == "failure" {
                            agent_runtime::mark_agent_queue_entry_failed(
                                connection,
                                queue_entry_id,
                            )?;
                        } else {
                            agent_runtime::mark_agent_queue_entry_completed(
                                connection,
                                queue_entry_id,
                            )?;
                        }
                    }
                    let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                        connection,
                        &task.project_id,
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
                            normalized_notes.as_deref()
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
        complete_assignment(connection, &assignment.id, assignment_status, &now)?;
    }

    transition_task_after_completion(connection, &task, &lane, outcome, &now)?;
    let updated = tasks::get_task_context(connection, task_id)?;
    Ok(updated)
}

fn transition_task_after_completion(
    connection: &Connection,
    task: &TaskDetail,
    lane: &WorkflowLane,
    outcome: &str,
    now: &str,
) -> Result<(), String> {
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

fn validate_assignment_authorization(
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
                started_at,
                completed_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16)
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
            "UPDATE task_lane_assignments SET status = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?1",
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

fn build_lane_prompt(
    task: &TaskDetail,
    workflow: &WorkflowDefinition,
    lane: &WorkflowLane,
    runtime_cwd: Option<&str>,
    worker_prompt: Option<&WorkerPromptContext>,
) -> String {
    let mut sections = vec![
        format!("You are an agent working inside Orchestra on task {} — {}.", task.number, task.title),
        format!("Canonical task ID: {}", task.id),
        "Orchestra is the project orchestration system. It tracks tasks, workflows, worker ownership, runtime sessions, comments, attachments, and transitions between steps of work. You are operating as a worker inside that system, so your job is not just to do good work — it is to keep Orchestra's state accurate as you work.".into(),
        [
            "Orchestra concepts you need to understand:",
            "- Task: the tracked unit of work you are responsible for right now. Tasks can have descriptions, comments, attachments, subtasks, dependencies, and workflow history.",
            "- Workflow: the overall process definition attached to a task. A workflow contains ordered lanes and transition rules.",
            "- Lane: the current step of the workflow. Each lane has an owner type (user, role, or agent) and defines what should happen on success or failure.",
            "- Session: the running conversation/runtime for a worker. This session is the place where you reason, inspect task context, and decide how to move the task forward.",
            "- Transition: the explicit tool call that moves the task out of the current lane. You must always end your work by choosing the correct transition tool.",
        ]
        .join("\n"),
        format!("Workflow: {}", workflow.name),
        format!("Current lane: {}", lane.name),
        format!("Lane owner type: {}", lane.assigned_entity_type),
        format!("Task status: {}", task.status),
    ];

    if let Some(worker_prompt) = worker_prompt {
        sections.push(format!(
            "Assigned worker: {} {} ({})",
            worker_prompt.worker_type_label, worker_prompt.worker_name, worker_prompt.worker_slug,
        ));

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
    }

    if let Some(description) = task
        .description
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!("Task description:\n{}", description.trim()));
    }

    if !task.blocked_by.is_empty() {
        let blocked_lines = task
            .blocked_by
            .iter()
            .map(|dependency| {
                format!(
                    "- {} — {}",
                    dependency.blocker.number, dependency.blocker.title
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Blocking tasks:\n{}", blocked_lines));
    }

    if !task.task_repositories.is_empty() {
        let repository_lines = task
            .task_repositories
            .iter()
            .map(|repository| {
                let workspace_path = runtime_cwd.map(|cwd| {
                    task_repositories::task_repository_worktree_path(
                        cwd,
                        &task.id,
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
            .join("\n");
        sections.push(format!(
            "Task repositories associated to this task:\n{}",
            repository_lines
        ));
    }

    if !task.file_references.is_empty() {
        let reference_lines = task
            .file_references
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
            .join("\n");
        sections.push(format!(
            "Referenced project files (live repository files, not imported snapshots):\n{}",
            reference_lines
        ));
    }

    if !task.attachments.is_empty() {
        let attachment_lines = task
            .attachments
            .iter()
            .map(|attachment| {
                format!(
                    "- {} ({}) at {}",
                    attachment.file_name, attachment.media_type, attachment.stored_path
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Task attachments:\n{}", attachment_lines));
    }

    if !task.comments.is_empty() {
        let comment_lines = task
            .comments
            .iter()
            .rev()
            .take(5)
            .rev()
            .map(|comment| format!("- {}: {}", comment.author, comment.message))
            .collect::<Vec<_>>()
            .join("\n");
        sections.push(format!("Recent task comments:\n{}", comment_lines));
    }

    if let Some(entry_prompt) = lane
        .entry_prompt_template
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        sections.push(format!(
            "Lane-specific instruction:\n{}",
            entry_prompt.trim()
        ));
    }

    sections.push(
        [
            "How to work effectively in this session:",
            "1. Start by understanding the task in Orchestra terms, not just the latest message.",
            "2. Immediately call get_task_context using the canonical task ID shown above so you are working from fresh live state before making decisions.",
            "3. If anything is still unclear or may have changed again, call get_task_context again to refresh the live task state.",
            "4. Do the reasoning/work needed for the lane.",
            "5. Whenever you take or finish a large action, leave a durable comment with comment_on_task describing what you did and why. Large actions include meaningful implementation work, file creation or edits, running important commands/tests, creating dependencies/subtasks, attaching artifacts, or any action another worker or human would need to understand later.",
            "6. If the work needs to be split, create_subtask and describe the smaller unit clearly.",
            "7. If another task must finish first, add_task_dependency. If a dependency is no longer correct, remove_task_dependency.",
            "8. Attach important artifacts with add_task_attachment when they would help review, handoff, or future execution.",
            "9. If you create or materially change a large or central repository file that should stay visible on the task — such as a design doc, architecture note, ADR, diagram source, migration plan, runbook, or other non-source artifact — record it with add_task_file_reference.",
            "10. Do not add normal source code or test file edits as task file references unless the human explicitly asked for that file to be tracked on the task.",
            "11. Before you transition the task or request help, add a comment explaining exactly what happened, what changed, and why you are choosing that transition or asking for help.",
            "12. When the lane is finished, explicitly transition it with the correct completion tool.",
        ]
        .join("\n"),
    );

    sections.push(
        [
            "Available Orchestra task tools and exactly how to use them:",
            "- These names are real Orchestra tools/functions exposed in this session. You must invoke them as tool calls, not merely mention them in prose.",
            "- get_task_context(task_id): Call this tool when you need the freshest full task state. Use it before making decisions if comments, attachments, dependencies, subtasks, or assignment state may have changed.",
            "- get_task_repositories(task_id): Call this tool to list the task-associated repositories and their current workspace paths before you read or modify repository files.",
            "- list_task_file_references(task_id): Call this tool to inspect which repository files are already tracked on the task before adding more.",
            "- add_task_file_reference(task_id, input): Call this tool when you create or materially change a large or central repository file that should stay visible on the task. Use input shaped like {repositoryId, relativePath}. Good candidates are design docs, diagrams, plans, ADRs, runbooks, and similar non-source artifacts. Do not use this for ordinary source code changes unless explicitly asked.",
            "- remove_task_file_reference(referenceId): Call this tool if a tracked repository file reference is no longer relevant or was added by mistake.",
            "- comment_on_task(task_id, input): Call this tool to leave a durable note in Orchestra. Use input shaped like {author, message, interruptAgent}. Write comments for findings, progress updates, large actions taken, reviewer notes, handoff details, blockers, transition decisions, or decisions another worker must see later.",
            "- create_subtask(parent_task_id, input): Call this tool when the current task should be broken into a separately tracked child task. Make the title/action clear and specific so the new task can stand on its own.",
            "- add_task_dependency(blocker_task_id, blocked_task_id): Call this tool when another task must be completed before the current one can proceed safely.",
            "- remove_task_dependency(dependency_id): Call this tool only when an existing blocking relationship is no longer true.",
            "- add_task_attachment(task_id, input): Call this tool for artifacts that matter to execution or review, such as notes, logs, screenshots, examples, or generated outputs.",
            "- remove_task_attachment(attachment_id): Call this tool only to clean up an attachment that is incorrect, outdated, or should not remain attached.",
            "- complete_lane_as_success(task_id, notes?): Call this tool when you finished the lane's goal and the task should follow the workflow's success transition.",
            "- complete_lane_as_failure(task_id, notes?): Call this tool when you attempted the lane but the correct workflow outcome is failure, so Orchestra should follow the failure transition.",
            "- request_user_intervention(task_id, notes?): Call this tool when you are blocked, missing information or permissions, hit a failing transition/completion step, or need a human decision before proceeding.",
        ]
        .join("\n"),
    );

    sections.push(
        [
            "Critical completion rules:",
            "- You must end this lane by invoking exactly one Orchestra completion tool: complete_lane_as_success, complete_lane_as_failure, or request_user_intervention.",
            "- You are not done and cannot stop until you have actually called one of those tools.",
            "- If any completion or transition step fails, add a task comment describing the failure and then call request_user_intervention instead of silently stopping.",
            "- If you are unsure whether the lane is complete, refresh with get_task_context, leave a comment explaining the uncertainty, and then choose the correct transition deliberately.",
            "- Do not just summarize what you would do. Actually call the Orchestra tools to update the task state and leave comments that explain what happened and why.",
        ]
        .join("\n"),
    );

    sections.join("\n\n")
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
        started_at: row.get(12)?,
        completed_at: row.get(13)?,
        created_at: row.get(14)?,
        updated_at: row.get(15)?,
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
        assert!(prompt.contains("- get_task_context(task_id): Call this tool"));
        assert!(prompt.contains("- get_task_repositories(task_id): Call this tool"));
        assert!(prompt.contains("- list_task_file_references(task_id): Call this tool to inspect which repository files are already tracked on the task before adding more."));
        assert!(prompt.contains("- add_task_file_reference(task_id, input): Call this tool when you create or materially change a large or central repository file that should stay visible on the task."));
        assert!(prompt.contains("- remove_task_file_reference(referenceId): Call this tool if a tracked repository file reference is no longer relevant or was added by mistake."));
        assert!(prompt.contains("- comment_on_task(task_id, input): Call this tool to leave a durable note in Orchestra. Use input shaped like {author, message, interruptAgent}."));
        assert!(prompt.contains("Whenever you take or finish a large action, leave a durable comment with comment_on_task"));
        assert!(prompt.contains("If you create or materially change a large or central repository file that should stay visible on the task"));
        assert!(prompt.contains("Do not add normal source code or test file edits as task file references unless the human explicitly asked"));
        assert!(prompt.contains("Before you transition the task or request help, add a comment explaining exactly what happened"));
        assert!(prompt.contains("- complete_lane_as_success(task_id, notes?): Call this tool"));
        assert!(prompt.contains("- complete_lane_as_failure(task_id, notes?): Call this tool"));
        assert!(prompt.contains("- request_user_intervention(task_id, notes?): Call this tool"));
        assert!(prompt
            .contains("You must end this lane by invoking exactly one Orchestra completion tool"));
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

        let prompt = build_lane_prompt(
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
                task_repositories::task_repository_worktree_path(cwd, &task.id, "runtime-role")
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
            started_at: now_iso(),
            completed_at: None,
            created_at: now_iso(),
            updated_at: now_iso(),
        };
        let comment = crate::models::TaskComment {
            id: "comment-1".into(),
            task_id: "task-1".into(),
            author: "User".into(),
            message: "Please follow up later.".into(),
            interrupt_agent: false,
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
        let agent_repo_workspace = assignment
            .runtime_cwd
            .as_deref()
            .map(|cwd| {
                task_repositories::task_repository_worktree_path(cwd, &task.id, "runtime-agent")
            })
            .expect("agent runtime cwd should exist");
        assert!(Path::new(&agent_repo_workspace).exists());

        let updated =
            complete_lane_as_success(&mut connection, &root, &session_dir, &task.id, None, None)
                .expect("agent lane should complete");
        assert_eq!(updated.status, "completed");
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
                archived: None,
            },
        )
        .expect("task should create");
        let session_dir = project_root.parent().expect("repo should have parent").join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let assignment = dispatch_task_lane(&mut connection, &project_root, &session_dir, &task.id)
            .expect("agent lane should dispatch with project-scoped runtime");
        assert_eq!(assignment.runtime_cwd.as_deref(), Some(project_root.to_string_lossy().as_ref()));
        assert_ne!(assignment.runtime_cwd.as_deref(), Some(wrong_runtime.to_string_lossy().as_ref()));
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
