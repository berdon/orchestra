use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
    time::Instant,
};

use rusqlite::OptionalExtension;
use serde_json::json;
use tauri::{async_runtime::spawn_blocking, AppHandle, State};

use crate::{
    models::{
        QueuedSessionMessage, SessionDebugInfo, SessionListVisibilityState, SessionMessageability,
        SessionModelState, SessionRecord, SessionRuntimeDetails, SessionStats,
    },
    services::{
        agent_dispatch, agent_runtime, agents, app_events, database, domain_events,
        live_sessions::{
            ensure_runtime, get_session_control_snapshot, is_unknown_command_error,
            maybe_auto_compact, maybe_runtime, perform_session_compaction, perform_session_reload,
        },
        model_limits,
        pi_sessions::{
            detect_session_context, find_session_context_for_session, get_session,
            get_session_header_cwd, get_session_stats as load_session_stats_from_file,
            session_context_for_project_id, set_session_model as apply_session_model,
        },
        pi_setup, role_dispatch, role_runtime, roles, session_list, session_records, task_runtime,
    },
    state::{generate_id, AppState},
};

fn record_session_domain_event(
    connection: &rusqlite::Connection,
    session_id: &str,
    topic: &str,
    project_id: Option<String>,
    payload: serde_json::Value,
) {
    let _ = domain_events::record_event(
        connection,
        domain_events::DomainEventInput {
            project_id,
            topic: topic.to_string(),
            entity_type: "session".to_string(),
            entity_id: Some(session_id.to_string()),
            payload,
        },
    );
}

fn update_agent_main_session_for_created_session(
    connection: &rusqlite::Connection,
    requested_project_id: Option<&str>,
    agent_id: &str,
    session_id: &str,
) -> Result<(), String> {
    let resolved_project_id = if let Some(project_id) = requested_project_id {
        project_id.to_string()
    } else {
        crate::services::projects::require_requested_or_default_project_id(
            connection,
            None,
            "Create a project first before managing agent sessions.",
        )?
    };

    agent_runtime::update_agent_runtime_dispatch_state_for_project(
        connection,
        &resolved_project_id,
        agent_id,
        Some(session_id),
        None,
        None,
        "",
        None,
    )?;

    Ok(())
}

fn resolve_session_create_title(
    explicit_title: Option<&str>,
    agent: Option<&crate::models::AgentDefinition>,
) -> Option<String> {
    explicit_title
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_string)
        .or_else(|| agent.map(|agent| format!("{} main session", agent.name)))
}

fn create_contextual_agent_main_successor(
    connection: &mut rusqlite::Connection,
    runtime_root: &Path,
    session_dir: &Path,
    old_session_id: &str,
    title: &str,
    project_id: &str,
    agent: &crate::models::AgentDefinition,
    runtime_state: &crate::models::AgentRuntimeState,
) -> Result<crate::services::pi_sessions::StoredSession, String> {
    let runtime_cwd = runtime_state
        .runtime_cwd
        .clone()
        .unwrap_or_else(|| runtime_root.display().to_string());
    let tx = connection.transaction().map_err(|error| {
        format!("Unable to start contextual agent main-session rotation transaction: {error}")
    })?;
    let created = session_records::rotate_session_record(
        &tx,
        runtime_root,
        session_dir,
        old_session_id,
        session_records::RotateSessionRecordInput {
            project_id: Some(project_id),
            title: Some(title),
            session_kind: session_records::SESSION_KIND_AGENT_MAIN,
            agent_id: Some(agent.id.as_str()),
            role_instance_id: None,
            task_id: None,
            workflow_id: None,
            lane_id: None,
            assignment: None,
            worker_type: None,
            worker_id: None,
            runtime_cwd: Some(runtime_cwd.as_str()),
            subscribed: false,
            agent_runtime: Some(session_records::AgentRuntimeBinding {
                project_id,
                agent_id: agent.id.as_str(),
                runtime_cwd: Some(runtime_cwd.as_str()),
                current_queue_entry_id: runtime_state.current_queue_entry_id.as_deref(),
                status: &runtime_state.status,
                last_error: runtime_state.last_error.as_deref(),
            }),
            update_role_instance_session: false,
        },
    )?;
    task_runtime::apply_agent_session_defaults(
        runtime_root,
        session_dir,
        &created.record.id,
        agent,
    )?;
    tx.commit().map_err(|error| {
        format!(
            "Unable to commit contextual agent main-session rotation for project {}: {error}",
            project_id
        )
    })?;

    Ok(created)
}

fn session_project_id(connection: &rusqlite::Connection, session_id: &str) -> Option<String> {
    let context = find_session_context_for_session(session_id).ok()?;
    connection
        .query_row(
            "SELECT id FROM projects WHERE slug = ?1 LIMIT 1",
            [context.project_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn project_id_for_slug(connection: &rusqlite::Connection, project_slug: &str) -> Option<String> {
    connection
        .query_row(
            "SELECT id FROM projects WHERE slug = ?1 LIMIT 1",
            [project_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .ok()
        .flatten()
}

fn bind_rotated_assignment_session_context(
    connection: &rusqlite::Connection,
    project_id: &str,
    session_kind: &str,
    assignment: &crate::models::TaskLaneAssignment,
) -> Result<(), String> {
    let session_id = assignment.session_id.as_deref().ok_or_else(|| {
        format!(
            "Replacement assignment {} is missing a bound session id",
            assignment.id
        )
    })?;
    let (agent_id, role_instance_id) = match assignment.worker_type.as_str() {
        "agent" => (assignment.worker_id.as_deref(), None),
        "role" => (None, assignment.role_instance_id.as_deref()),
        other => {
            return Err(format!(
                "Unsupported worker type {other} for rotated assignment {}",
                assignment.id
            ));
        }
    };

    session_records::bind_session_context(
        connection,
        session_id,
        session_records::SessionContextBinding {
            project_id: Some(project_id),
            session_kind: Some(session_kind),
            worker_type: Some(assignment.worker_type.as_str()),
            worker_id: assignment.worker_id.as_deref(),
            agent_id,
            role_instance_id,
            task_id: Some(assignment.task_id.as_str()),
            workflow_id: Some(assignment.workflow_id.as_str()),
            lane_id: Some(assignment.lane_id.as_str()),
            assignment_id: Some(assignment.id.as_str()),
            runtime_cwd: assignment.runtime_cwd.as_deref().map(Path::new),
        },
    )
}

struct ContextualSessionCreation {
    project_root: PathBuf,
    session_dir: PathBuf,
    new_session_id: String,
    rotated_from_session_id: Option<String>,
    affected_task_id: Option<String>,
    project_id: Option<String>,
    direct_agent_context_seed: Option<DirectAgentContextSeed>,
}

#[derive(Debug, Clone)]
struct DirectAgentContextSeed {
    agent_id: String,
    active_project_id: Option<String>,
}

fn ensure_session_runtime_root(path: &Path) -> Result<(), String> {
    fs::create_dir_all(path).map_err(|error| {
        format!(
            "Unable to create session runtime root {}: {error}",
            path.display()
        )
    })
}

fn load_session_debug_info(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionDebugInfo>, String> {
    let task_assignment = connection
        .query_row(
            r#"
            SELECT tla.id, tla.task_id, t.project_id, tla.runtime_cwd, r.local_path, p.slug
            FROM task_lane_assignments tla
            LEFT JOIN tasks t ON t.id = tla.task_id
            LEFT JOIN repositories r ON r.id = t.repository_id
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE tla.session_id = ?1
            ORDER BY tla.updated_at DESC, tla.id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .or_else(|error| {
            if error.to_string().contains("no such table") {
                Ok(None)
            } else {
                Err(error)
            }
        })
        .map_err(|error| format!("Unable to load task session debug info {session_id}: {error}"))?;

    if let Some((
        assignment_id,
        task_id,
        project_id,
        runtime_cwd,
        managed_repository_path,
        project_slug,
    )) = task_assignment
    {
        let project_root = project_slug.and_then(|slug| {
            crate::services::orchestra_paths::default_orchestra_root()
                .ok()
                .map(|root| {
                    crate::services::orchestra_paths::project_root(&root, &slug)
                        .display()
                        .to_string()
                })
        });
        let worktree_path =
            task_runtime::get_active_assignment_for_session(connection, session_id)?
                .filter(|assignment| assignment.id == assignment_id)
                .map(|assignment| {
                    task_runtime::resolve_assignment_workspace_cwd(
                        connection,
                        &assignment,
                        &task_id,
                        &project_id,
                    )
                })
                .transpose()?
                .flatten()
                .or(runtime_cwd.clone());
        let session_cwd = find_session_context_for_session(session_id)
            .ok()
            .and_then(|context| {
                get_session_header_cwd(&context.session_dir, session_id)
                    .ok()
                    .flatten()
            })
            .map(|path| path.display().to_string())
            .or(runtime_cwd.clone());
        return Ok(Some(SessionDebugInfo {
            project_root,
            managed_repository_path: managed_repository_path.clone(),
            worktree_path,
            session_cwd,
        }));
    }

    let agent_runtime = connection
        .query_row(
            r#"
            SELECT ars.runtime_cwd, p.slug
            FROM agent_runtime_states ars
            LEFT JOIN projects p ON p.id = ars.project_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to load agent session debug info {session_id}: {error}")
        })?;

    if let Some((runtime_cwd, project_slug)) = agent_runtime {
        let project_root = project_slug.and_then(|slug| {
            crate::services::orchestra_paths::default_orchestra_root()
                .ok()
                .map(|root| {
                    crate::services::orchestra_paths::project_root(&root, &slug)
                        .display()
                        .to_string()
                })
        });
        return Ok(Some(SessionDebugInfo {
            project_root,
            managed_repository_path: None,
            worktree_path: runtime_cwd.clone(),
            session_cwd: runtime_cwd,
        }));
    }

    let role_runtime = connection
        .query_row(
            r#"
            SELECT worktree_path
            FROM role_instances
            WHERE session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load role session debug info {session_id}: {error}"))?;

    Ok(role_runtime.flatten().map(|runtime_cwd| SessionDebugInfo {
        project_root: None,
        managed_repository_path: None,
        worktree_path: Some(runtime_cwd.clone()),
        session_cwd: Some(runtime_cwd),
    }))
}

fn load_session_list_metadata(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    String,
> {
    let assignment_metadata = connection
        .query_row(
            r#"
            SELECT
                t.id,
                t.project_id,
                t.number,
                t.title,
                tla.worker_type,
                CASE
                    WHEN tla.worker_type = 'agent' THEN a.name
                    WHEN tla.worker_type = 'role' THEN r.name
                    WHEN tla.worker_type = 'user' THEN 'User'
                    ELSE NULL
                END AS worker_name
            FROM task_lane_assignments tla
            JOIN tasks t ON t.id = tla.task_id
            LEFT JOIN agents a ON tla.worker_type = 'agent' AND a.id = tla.worker_id
            LEFT JOIN roles r ON tla.worker_type = 'role' AND r.id = tla.worker_id
            WHERE tla.session_id = ?1
            ORDER BY
                CASE tla.status
                    WHEN 'active' THEN 0
                    WHEN 'awaiting_user_approval' THEN 1
                    WHEN 'awaiting_user_intervention' THEN 2
                    WHEN 'queued' THEN 3
                    ELSE 4
                END,
                COALESCE(tla.completed_at, tla.updated_at, tla.created_at) DESC,
                tla.id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load session list metadata {session_id}: {error}"))?;

    let active_assignment_metadata =
        task_runtime::get_active_assignment_for_session(connection, session_id)?
            .map(|assignment| {
                connection
                    .query_row(
                        r#"
                    SELECT id, project_id, number, title
                    FROM tasks
                    WHERE id = ?1
                    LIMIT 1
                    "#,
                        [assignment.task_id.as_str()],
                        |row| {
                            Ok((
                                row.get::<_, Option<String>>(0)?,
                                row.get::<_, Option<String>>(1)?,
                                row.get::<_, Option<String>>(2)?,
                                row.get::<_, Option<String>>(3)?,
                            ))
                        },
                    )
                    .optional()
                    .map_err(|error| {
                        format!("Unable to load active session task metadata {session_id}: {error}")
                    })
            })
            .transpose()?
            .flatten()
            .unwrap_or((None, None, None, None));

    if let Some((task_id, task_project_id, task_number, task_title, worker_type, worker_name)) =
        assignment_metadata
    {
        return Ok((
            task_id,
            task_project_id,
            task_number,
            task_title,
            active_assignment_metadata.0,
            active_assignment_metadata.1,
            active_assignment_metadata.2,
            active_assignment_metadata.3,
            worker_type,
            worker_name,
        ));
    }

    let agent_metadata = connection
        .query_row(
            r#"
            SELECT a.name
            FROM agent_runtime_states ars
            JOIN agents a ON a.id = ars.agent_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load agent session metadata {session_id}: {error}"))?
        .flatten();

    if let Some(worker_name) = agent_metadata {
        return Ok((
            None,
            None,
            None,
            None,
            active_assignment_metadata.0,
            active_assignment_metadata.1,
            active_assignment_metadata.2,
            active_assignment_metadata.3,
            Some("agent".into()),
            Some(worker_name),
        ));
    }

    let role_metadata = connection
        .query_row(
            r#"
            SELECT r.name
            FROM role_instances ri
            JOIN roles r ON r.id = ri.role_id
            WHERE ri.session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load role session metadata {session_id}: {error}"))?
        .flatten();

    if let Some(worker_name) = role_metadata {
        return Ok((
            None,
            None,
            None,
            None,
            active_assignment_metadata.0,
            active_assignment_metadata.1,
            active_assignment_metadata.2,
            active_assignment_metadata.3,
            Some("role".into()),
            Some(worker_name),
        ));
    }

    Ok((
        None,
        None,
        None,
        None,
        active_assignment_metadata.0,
        active_assignment_metadata.1,
        active_assignment_metadata.2,
        active_assignment_metadata.3,
        None,
        None,
    ))
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum SessionDecorationSurface {
    List,
    Detail,
}

fn session_list_visibility_state(
    visibility: Option<&session_list::SessionListVisibility>,
) -> Option<SessionListVisibilityState> {
    match visibility {
        Some(session_list::SessionListVisibility::Active) => {
            Some(SessionListVisibilityState::Active)
        }
        Some(session_list::SessionListVisibility::Closed) => {
            Some(SessionListVisibilityState::Closed)
        }
        Some(session_list::SessionListVisibility::Hidden(_)) => {
            Some(SessionListVisibilityState::Hidden)
        }
        Some(session_list::SessionListVisibility::Unchanged) | None => None,
    }
}

fn session_messageability(
    visibility: Option<&session_list::SessionListVisibility>,
    persistent_agent_session: bool,
    current_status: &str,
) -> SessionMessageability {
    match visibility {
        Some(session_list::SessionListVisibility::Active) => SessionMessageability::Messageable,
        Some(session_list::SessionListVisibility::Hidden(_)) if persistent_agent_session => {
            SessionMessageability::Messageable
        }
        Some(session_list::SessionListVisibility::Closed)
        | Some(session_list::SessionListVisibility::Hidden(_)) => SessionMessageability::Closed,
        Some(session_list::SessionListVisibility::Unchanged) | None => {
            if current_status == "closed" {
                SessionMessageability::Closed
            } else {
                SessionMessageability::Messageable
            }
        }
    }
}

fn decorate_session_record_with_runtime_state(
    connection: &rusqlite::Connection,
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    active_runtime_session_ids: &std::collections::HashSet<String>,
    mut record: SessionRecord,
    include_debug_info: bool,
    surface: SessionDecorationSurface,
) -> Result<SessionRecord, String> {
    if include_debug_info {
        record.debug_info = load_session_debug_info(connection, &record.id)?;
    }
    record.terminal_attached = terminal_attached_session_ids.contains(record.id.as_str());

    let decoration = session_list::load_session_list_decoration(connection, &record.id)?;
    let persistent_agent_session = decoration.persistent_agent_session;
    let mut visibility = decoration.visibility.clone();
    if active_runtime_session_ids.contains(record.id.as_str())
        && decoration.task_id.is_some()
        && matches!(
            visibility,
            Some(session_list::SessionListVisibility::Closed)
        )
    {
        visibility = Some(session_list::SessionListVisibility::Active);
    }
    record.task_id = decoration.task_id;
    record.task_project_id = decoration.task_project_id;
    record.task_number = decoration.task_number;
    record.task_title = decoration.task_title;
    record.active_task_id = decoration.active_task_id;
    record.active_task_project_id = decoration.active_task_project_id;
    record.active_task_number = decoration.active_task_number;
    record.active_task_title = decoration.active_task_title;
    record.worker_type = decoration.worker_type;
    record.worker_name = decoration.worker_name;
    record.list_visibility = session_list_visibility_state(visibility.as_ref());
    record.messageability = Some(session_messageability(
        visibility.as_ref(),
        persistent_agent_session,
        &record.status,
    ));

    match (surface, visibility.as_ref()) {
        (SessionDecorationSurface::List, Some(session_list::SessionListVisibility::Active)) => {
            record.status = "active".into();
        }
        (_, Some(session_list::SessionListVisibility::Closed)) => record.status = "closed".into(),
        (SessionDecorationSurface::List, Some(session_list::SessionListVisibility::Hidden(_))) => {
            record.status = "closed".into();
        }
        (
            SessionDecorationSurface::Detail,
            Some(session_list::SessionListVisibility::Hidden(_)),
        ) => {
            if !persistent_agent_session {
                record.status = "closed".into();
            }
        }
        (_, Some(session_list::SessionListVisibility::Active))
        | (_, Some(session_list::SessionListVisibility::Unchanged))
        | (_, None) => {}
    }

    Ok(record)
}

pub(crate) fn decorate_session_record_with_connection(
    connection: &rusqlite::Connection,
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    record: SessionRecord,
    include_debug_info: bool,
    surface: SessionDecorationSurface,
) -> Result<SessionRecord, String> {
    let active_runtime_session_ids = std::collections::HashSet::new();
    decorate_session_record_with_runtime_state(
        connection,
        terminal_attached_session_ids,
        &active_runtime_session_ids,
        record,
        include_debug_info,
        surface,
    )
}

fn decorate_session_record(
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    record: SessionRecord,
    include_debug_info: bool,
    surface: SessionDecorationSurface,
) -> Result<SessionRecord, String> {
    let connection = database::open_connection()?;
    decorate_session_record_with_connection(
        &connection,
        terminal_attached_session_ids,
        record,
        include_debug_info,
        surface,
    )
}

fn load_decorated_session_record_with_runtime_state(
    session_dir: &std::path::Path,
    session_id: &str,
    subscribed: bool,
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    active_runtime_session_ids: &std::collections::HashSet<String>,
    surface: SessionDecorationSurface,
) -> Result<SessionRecord, String> {
    let connection = database::open_connection()?;
    let mut record = session_records::load_session_row(&connection, session_id)?
        .map(|row| row.to_record(subscribed))
        .ok_or_else(|| format!("Session {session_id} was not found"))?;

    let detail_record = get_session(session_dir, session_id, subscribed)?;
    record.events = detail_record.events;
    record.status = detail_record.status;

    decorate_session_record_with_runtime_state(
        &connection,
        terminal_attached_session_ids,
        active_runtime_session_ids,
        record,
        true,
        surface,
    )
}

fn load_decorated_session_record(
    session_dir: &std::path::Path,
    session_id: &str,
    subscribed: bool,
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    surface: SessionDecorationSurface,
) -> Result<SessionRecord, String> {
    let active_runtime_session_ids = std::collections::HashSet::new();
    load_decorated_session_record_with_runtime_state(
        session_dir,
        session_id,
        subscribed,
        terminal_attached_session_ids,
        &active_runtime_session_ids,
        surface,
    )
}

fn attach_session_control_metadata(
    state: &AppState,
    mut record: SessionRecord,
) -> Result<SessionRecord, String> {
    let (control_capabilities, control_operation) =
        get_session_control_snapshot(state, &record.id, record.terminal_attached)?;
    record.control_capabilities = Some(control_capabilities);
    record.control_operation = control_operation;
    Ok(record)
}

pub(crate) fn load_detail_session_record_for_state(
    state: &AppState,
    session_dir: &std::path::Path,
    session_id: &str,
    subscribed: bool,
) -> Result<SessionRecord, String> {
    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let active_runtime_session_ids = state.active_runtime_session_ids()?;
    let record = load_decorated_session_record_with_runtime_state(
        session_dir,
        session_id,
        subscribed,
        &terminal_attached_session_ids,
        &active_runtime_session_ids,
        SessionDecorationSurface::Detail,
    )?;
    attach_session_control_metadata(state, record)
}

fn resolve_session_runtime_root(
    connection: &rusqlite::Connection,
    session_id: &str,
    storage_project_root: &std::path::Path,
    session_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    if let Some(debug_info) = load_session_debug_info(connection, session_id)? {
        if let Some(session_cwd) = debug_info
            .session_cwd
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
        {
            return Ok(session_cwd);
        }
        if let Some(project_root) = debug_info
            .project_root
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
        {
            return Ok(project_root);
        }
    }

    if let Some(header_cwd) =
        get_session_header_cwd(session_dir, session_id)?.filter(|path| path.is_dir())
    {
        return Ok(header_cwd);
    }

    Ok(storage_project_root.to_path_buf())
}

fn resolve_session_paths(session_id: &str) -> Result<(PathBuf, PathBuf), String> {
    let storage_context = find_session_context_for_session(session_id)?;
    let connection = database::open_connection()?;
    let runtime_root = resolve_session_runtime_root(
        &connection,
        session_id,
        &storage_context.project_root,
        &storage_context.session_dir,
    )?;
    Ok((runtime_root, storage_context.session_dir))
}

fn log_session_command_failure(
    state: &AppState,
    target: &str,
    session_id: &str,
    action: &str,
    error: &str,
) {
    state.log(
        "error",
        target,
        &format!("Session {session_id} failed to {action}: {error}"),
    );
}

fn dismiss_session_entry(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    session_list::dismiss_session(connection, session_id)
}

fn restore_session_entry(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    session_list::restore_user_dismissed_session(connection, session_id)
}

fn collect_listed_session_records_from_rows_with_runtime_state(
    connection: &rusqlite::Connection,
    rows: Vec<session_records::CanonicalSessionRow>,
    subscribed: &HashSet<String>,
    terminal_attached_session_ids: &HashSet<String>,
    active_runtime_session_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    let mut seen_session_ids = HashSet::new();
    let mut sessions = Vec::new();

    for row in rows {
        if !seen_session_ids.insert(row.id.clone()) {
            continue;
        }
        let base_record = row.to_record(subscribed.contains(&row.id));
        let decorated = decorate_session_record_with_runtime_state(
            connection,
            terminal_attached_session_ids,
            active_runtime_session_ids,
            base_record,
            false,
            SessionDecorationSurface::List,
        )?;
        if matches!(
            decorated.list_visibility,
            Some(SessionListVisibilityState::Hidden)
        ) && session_list::hide_session_from_normal_list(
            row.hidden_reason.as_deref(),
            row.dismissed_at.as_deref(),
        ) {
            continue;
        }
        sessions.push(decorated);
    }

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

pub(crate) fn list_command_sessions_with_connection(
    connection: &rusqlite::Connection,
    contexts: &[crate::services::pi_sessions::SessionContext],
    subscribed: &HashSet<String>,
    terminal_attached_session_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    let active_runtime_session_ids = HashSet::new();
    list_command_sessions_with_runtime_state(
        connection,
        contexts,
        subscribed,
        terminal_attached_session_ids,
        &active_runtime_session_ids,
    )
}

fn list_command_sessions_with_runtime_state(
    connection: &rusqlite::Connection,
    contexts: &[crate::services::pi_sessions::SessionContext],
    subscribed: &HashSet<String>,
    terminal_attached_session_ids: &HashSet<String>,
    active_runtime_session_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    let mut all_rows = Vec::new();
    for context in contexts {
        let project_id = project_id_for_slug(connection, &context.project_slug);
        all_rows.extend(session_records::list_session_rows(
            connection,
            project_id.as_deref(),
            Some(&context.session_dir),
        )?);
    }
    collect_listed_session_records_from_rows_with_runtime_state(
        connection,
        all_rows,
        subscribed,
        terminal_attached_session_ids,
        active_runtime_session_ids,
    )
}

fn list_all_command_sessions_with_connection(
    connection: &rusqlite::Connection,
    subscribed: &HashSet<String>,
    terminal_attached_session_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    let active_runtime_session_ids = HashSet::new();
    list_all_command_sessions_with_runtime_state(
        connection,
        subscribed,
        terminal_attached_session_ids,
        &active_runtime_session_ids,
    )
}

fn list_all_command_sessions_with_runtime_state(
    connection: &rusqlite::Connection,
    subscribed: &HashSet<String>,
    terminal_attached_session_ids: &HashSet<String>,
    active_runtime_session_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    collect_listed_session_records_from_rows_with_runtime_state(
        connection,
        session_records::list_session_rows(connection, None, None)?,
        subscribed,
        terminal_attached_session_ids,
        active_runtime_session_ids,
    )
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<SessionRecord>, String> {
    let started_at = Instant::now();
    let subscribed = state.subscribed_session_ids()?;
    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let active_runtime_session_ids = state.active_runtime_session_ids()?;
    let project_id_for_log = project_id.clone();
    let sessions = spawn_blocking(move || {
        let connection = database::open_connection()?;
        match project_id.as_deref() {
            Some(project_id) => {
                let contexts = vec![session_context_for_project_id(project_id)?];
                list_command_sessions_with_runtime_state(
                    &connection,
                    &contexts,
                    &subscribed,
                    &terminal_attached_session_ids,
                    &active_runtime_session_ids,
                )
            }
            None => list_all_command_sessions_with_runtime_state(
                &connection,
                &subscribed,
                &terminal_attached_session_ids,
                &active_runtime_session_ids,
            ),
        }
    })
    .await
    .map_err(|error| format!("Unable to join list_sessions task: {error}"))??;
    state.log(
        "info",
        "startup.timing.rpc",
        &format!(
            "command=list_sessions duration_ms={:.1} project_id={} session_count={}",
            started_at.elapsed().as_secs_f64() * 1000.0,
            project_id_for_log.as_deref().unwrap_or("<all>"),
            sessions.len(),
        ),
    );

    sessions
        .into_iter()
        .map(|record| attach_session_control_metadata(state.inner(), record))
        .collect()
}

#[tauri::command]
pub async fn get_session_record(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let subscribed = state.subscribed_session_ids()?.contains(&session_id);
    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let active_runtime_session_ids = state.active_runtime_session_ids()?;
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        let context = find_session_context_for_session(&session_id_for_task)?;
        load_decorated_session_record_with_runtime_state(
            &context.session_dir,
            &session_id_for_task,
            subscribed,
            &terminal_attached_session_ids,
            &active_runtime_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join get_session_record task: {error}"))??;
    attach_session_control_metadata(state.inner(), record)
}

#[tauri::command]
pub fn get_session_runtime_details(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRuntimeDetails, String> {
    crate::services::live_sessions::get_session_runtime_details(&app, state.inner(), &session_id)
}

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
    project_slug: Option<String>,
    agent_id: Option<String>,
) -> Result<SessionRecord, String> {
    state
        .sync_pi_runtime_health()
        .map_err(|error| format!("Unable to create session because PI is unavailable: {error}"))?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to create session because Pi setup is incomplete: {error}")
    })?;
    state.log(
        "info",
        "sessions.create.request",
        &format!(
            "Create session request title={} project_slug={} agent_id={}",
            title.as_deref().unwrap_or("<none>"),
            project_slug.as_deref().unwrap_or("<default>"),
            agent_id.as_deref().unwrap_or("<none>"),
        ),
    );
    let title_for_task = title.clone();
    let project_slug_for_task = project_slug.clone();
    let agent_id_for_task = agent_id.clone();
    let agent_id_for_create = agent_id_for_task.clone();
    let (project_root, session_dir, created) = spawn_blocking(move || {
        let context = detect_session_context(project_slug_for_task.as_deref())?;
        let connection = database::open_connection()?;
        let project_id = connection
            .query_row(
                "SELECT id FROM projects WHERE slug = ?1 LIMIT 1",
                [context.project_slug.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve project id for session create in {}: {error}",
                    context.project_slug
                )
            })?;
        let runtime_cwd = context.project_root.display().to_string();
        let agent = agent_id_for_create
            .as_deref()
            .map(|agent_id| agents::get_agent(&connection, agent_id))
            .transpose()?;
        let resolved_title =
            resolve_session_create_title(title_for_task.as_deref(), agent.as_ref());
        let created = session_records::create_session_record(
            &connection,
            &context.project_root,
            &context.session_dir,
            session_records::CreateSessionRecordInput {
                project_id: project_id.as_deref(),
                title: resolved_title.as_deref(),
                session_kind: if agent_id_for_create.is_some() {
                    session_records::SESSION_KIND_AGENT_MAIN
                } else {
                    session_records::SESSION_KIND_STANDALONE
                },
                agent_id: agent_id_for_create.as_deref(),
                role_instance_id: None,
                task_id: None,
                workflow_id: None,
                lane_id: None,
                assignment: None,
                worker_type: None,
                worker_id: None,
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: true,
                agent_runtime: agent_id_for_create.as_deref().map(|agent_id| {
                    session_records::AgentRuntimeBinding {
                        project_id: project_id.as_deref().unwrap_or("orchestra"),
                        agent_id,
                        runtime_cwd: Some(runtime_cwd.as_str()),
                        current_queue_entry_id: None,
                        status: "",
                        last_error: None,
                    }
                }),
                update_role_instance_session: false,
            },
        )?;
        if let Some(agent) = agent.as_ref() {
            agent_dispatch::seed_direct_agent_session_context(
                &connection,
                &context.session_dir,
                &created.record.id,
                agent,
                project_id.as_deref(),
            )?;
        }
        Ok::<_, String>((context.project_root, context.session_dir, created))
    })
    .await
    .map_err(|error| format!("Unable to join create_session task: {error}"))??;

    state.set_session_subscription(&created.record.id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        project_root,
        session_dir.clone(),
        &created.record.id,
    )?;
    runtime.set_subscribed(true);
    state.log(
        "info",
        "sessions.create",
        &format!(
            "Created real pi session {} at {}",
            created.record.id,
            created.path.display()
        ),
    );
    if let Some(agent_id) = agent_id.as_deref() {
        state.log(
            "info",
            "agent.session.create",
            &format!(
                "Created agent session {} for agent {} in project slug {}",
                created.record.id,
                agent_id,
                project_slug.as_deref().unwrap_or("<default>"),
            ),
        );
    }
    if let Ok(connection) = database::open_connection() {
        let project_id = project_slug.as_deref().and_then(|slug| {
            connection
                .query_row(
                    "SELECT id FROM projects WHERE slug = ?1 LIMIT 1",
                    [slug],
                    |row| row.get::<_, String>(0),
                )
                .optional()
                .ok()
                .flatten()
        });
        record_session_domain_event(
            &connection,
            &created.record.id,
            "session.created",
            project_id.clone(),
            json!({
                "sessionId": created.record.id.clone(),
                "title": created.record.title.clone(),
            }),
        );
        if let Some(ref agent_id_str) = agent_id_for_task {
            update_agent_main_session_for_created_session(
                &connection,
                project_id.as_deref(),
                agent_id_str,
                &created.record.id,
            )?;
        }
    }
    let _ = app_events::emit_session_change(&app, "sessions.create", [created.record.id.clone()]);

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let decorated_record = spawn_blocking(move || {
        load_decorated_session_record(
            &session_dir,
            &created.record.id,
            true,
            &terminal_attached_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join create_session record task: {error}"))??;

    if let Some(agent_id) = agent_id.as_deref() {
        state.log(
            "info",
            "agent.session.create",
            &format!(
                "Returning created agent session {} (title={}) for agent {}",
                decorated_record.id, decorated_record.title, agent_id,
            ),
        );
    }

    attach_session_control_metadata(state.inner(), decorated_record)
}

#[tauri::command]
pub async fn create_contextual_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_slug: Option<String>,
    agent_id: Option<String>,
) -> Result<SessionRecord, String> {
    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to create a new session because PI is unavailable: {error}")
    })?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to create a new session because Pi setup is incomplete: {error}")
    })?;

    if state.get_terminal_window_label(&session_id)?.is_some() {
        return Err(
            "Close the embedded terminal window before creating a new worker session here.".into(),
        );
    }

    state.log(
        "info",
        "sessions.create_contextual.request",
        &format!(
            "Create contextual session request source={} project_slug={} agent_id={}",
            session_id,
            project_slug.as_deref().unwrap_or("<default>"),
            agent_id.as_deref().unwrap_or("<none>"),
        ),
    );
    let session_id_for_task = session_id.clone();
    let project_slug_for_task = project_slug.clone();
    let agent_id_for_task = agent_id.clone();
    let agent_id_for_post_commit = agent_id.clone();
    let agent_id_for_create = agent_id_for_task.clone();
    let prepared = spawn_blocking(move || {
        let mut connection = database::open_connection()?;
        let old_context = find_session_context_for_session(&session_id_for_task)?;
        let old_record = get_session(&old_context.session_dir, &session_id_for_task, false)?;
        let old_row = session_records::load_session_row(&connection, &session_id_for_task)?;
        let now = crate::state::now_iso();

        if let Some(assignment) =
            task_runtime::get_active_assignment_for_session(&connection, &session_id_for_task)?
        {
            let runtime_root = assignment
                .runtime_cwd
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| old_context.project_root.clone());
            ensure_session_runtime_root(&runtime_root)?;

            let assignment_result = match assignment.worker_type.as_str() {
                "agent" => {
                    let agent_id = assignment.worker_id.as_deref().ok_or_else(|| {
                        format!("Assignment {} is missing an agent id", assignment.id)
                    })?;
                    let task = crate::services::tasks::get_task_context(
                        &connection,
                        &assignment.task_id,
                    )?;
                    let agent = agents::get_agent(&connection, agent_id)?;
                    let tx = connection.transaction().map_err(|error| {
                        format!(
                            "Unable to start contextual agent session rotation transaction: {error}"
                        )
                    })?;
                    let runtime_state = agent_runtime::get_agent_runtime_state_for_project(
                        &tx,
                        &task.project_id,
                        agent_id,
                    )?
                    .ok_or_else(|| {
                        format!(
                            "Agent runtime state for {} in project {} was not found",
                            agent_id, task.project_id
                        )
                    })?;
                    let runtime_cwd = runtime_state
                        .runtime_cwd
                        .clone()
                        .unwrap_or_else(|| runtime_root.display().to_string());
                    let replacement_assignment_id = generate_id("assignment");
                    let created = session_records::rotate_session_record(
                        &tx,
                        &runtime_root,
                        &old_context.session_dir,
                        &session_id_for_task,
                        session_records::RotateSessionRecordInput {
                            project_id: Some(task.project_id.as_str()),
                            title: Some(old_record.title.as_str()),
                            session_kind: session_records::SESSION_KIND_AGENT_MAIN,
                            agent_id: Some(agent_id),
                            role_instance_id: None,
                            task_id: Some(task.id.as_str()),
                            workflow_id: task.workflow_id.as_deref(),
                            lane_id: Some(assignment.lane_id.as_str()),
                            assignment: Some(session_records::AssignmentBinding {
                                assignment_id: replacement_assignment_id.as_str(),
                                runtime_cwd: Some(runtime_cwd.as_str()),
                            }),
                            worker_type: Some("agent"),
                            worker_id: Some(agent_id),
                            runtime_cwd: Some(runtime_cwd.as_str()),
                            subscribed: false,
                            agent_runtime: Some(session_records::AgentRuntimeBinding {
                                project_id: task.project_id.as_str(),
                                agent_id,
                                runtime_cwd: Some(runtime_cwd.as_str()),
                                current_queue_entry_id: runtime_state.current_queue_entry_id.as_deref(),
                                status: &runtime_state.status,
                                last_error: runtime_state.last_error.as_deref(),
                            }),
                            update_role_instance_session: false,
                        },
                    )?;
                    task_runtime::apply_agent_session_defaults(
                        &runtime_root,
                        &old_context.session_dir,
                        &created.record.id,
                        &agent,
                    )?;
                    let replacement = task_runtime::rotate_open_assignment_session(
                        &tx,
                        &assignment,
                        &created.record.id,
                        Some(replacement_assignment_id.as_str()),
                        &now,
                    )?;
                    bind_rotated_assignment_session_context(
                        &tx,
                        task.project_id.as_str(),
                        session_records::SESSION_KIND_AGENT_MAIN,
                        &replacement,
                    )?;
                    tx.commit().map_err(|error| {
                        format!(
                            "Unable to commit contextual agent session rotation for task {}: {error}",
                            assignment.task_id
                        )
                    })?;
                    Ok::<_, String>((task.project_id, created.record.id))
                }
                "role" => {
                    let role_instance_id = assignment.role_instance_id.as_deref().ok_or_else(|| {
                        format!(
                            "Assignment {} is missing a role instance id",
                            assignment.id
                        )
                    })?;
                    let role_instance =
                        role_runtime::get_role_instance(&connection, role_instance_id)?;
                    let role = roles::get_role(&connection, &role_instance.role_id)?;
                    let task = crate::services::tasks::get_task_context(
                        &connection,
                        &assignment.task_id,
                    )?;
                    let tx = connection.transaction().map_err(|error| {
                        format!(
                            "Unable to start contextual role session rotation transaction: {error}"
                        )
                    })?;
                    let runtime_cwd = assignment
                        .runtime_cwd
                        .clone()
                        .unwrap_or_else(|| runtime_root.display().to_string());
                    let replacement_assignment_id = generate_id("assignment");
                    let created = session_records::rotate_session_record(
                        &tx,
                        &runtime_root,
                        &old_context.session_dir,
                        &session_id_for_task,
                        session_records::RotateSessionRecordInput {
                            project_id: Some(task.project_id.as_str()),
                            title: Some(old_record.title.as_str()),
                            session_kind: session_records::SESSION_KIND_ROLE_INSTANCE,
                            agent_id: None,
                            role_instance_id: Some(role_instance.id.as_str()),
                            task_id: Some(task.id.as_str()),
                            workflow_id: task.workflow_id.as_deref(),
                            lane_id: Some(assignment.lane_id.as_str()),
                            assignment: Some(session_records::AssignmentBinding {
                                assignment_id: replacement_assignment_id.as_str(),
                                runtime_cwd: Some(runtime_cwd.as_str()),
                            }),
                            worker_type: Some("role"),
                            worker_id: assignment.worker_id.as_deref(),
                            runtime_cwd: Some(runtime_cwd.as_str()),
                            subscribed: false,
                            agent_runtime: None,
                            update_role_instance_session: true,
                        },
                    )?;
                    role_dispatch::apply_role_session_defaults(
                        &runtime_root,
                        &old_context.session_dir,
                        &created.record.id,
                        &role,
                    )?;
                    let replacement = task_runtime::rotate_open_assignment_session(
                        &tx,
                        &assignment,
                        &created.record.id,
                        Some(replacement_assignment_id.as_str()),
                        &now,
                    )?;
                    bind_rotated_assignment_session_context(
                        &tx,
                        task.project_id.as_str(),
                        session_records::SESSION_KIND_ROLE_INSTANCE,
                        &replacement,
                    )?;
                    tx.commit().map_err(|error| {
                        format!(
                            "Unable to commit contextual role session rotation for task {}: {error}",
                            assignment.task_id
                        )
                    })?;
                    Ok::<_, String>((task.project_id, created.record.id))
                }
                other => Err(format!(
                    "Unsupported assignment worker type {other} for session rotation"
                )),
            }?;

            return Ok::<_, String>(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: assignment_result.1,
                rotated_from_session_id: Some(session_id_for_task),
                affected_task_id: Some(assignment.task_id),
                project_id: Some(assignment_result.0),
                direct_agent_context_seed: None,
            });
        }

        if let Some(canonical_agent_main) = old_row.as_ref().filter(|row| {
            row.session_kind == session_records::SESSION_KIND_AGENT_MAIN
                && row.agent_id.as_deref().is_some()
        }) {
            let source_agent_id = agent_id_for_task
                .as_deref()
                .unwrap_or_else(|| {
                    canonical_agent_main
                        .agent_id
                        .as_deref()
                        .expect("filtered canonical agent main rows always have an agent id")
                });
            if canonical_agent_main.agent_id.as_deref() == Some(source_agent_id) {
                let chat_context_project_id = project_slug_for_task
                    .as_deref()
                    .and_then(|slug| project_id_for_slug(&connection, slug))
                    .or_else(|| project_id_for_slug(&connection, &old_context.project_slug));
                if let Some(project_id) = chat_context_project_id
                    .clone()
                    .or_else(|| canonical_agent_main.project_id.clone())
                {
                    let runtime_state = agent_runtime::get_agent_runtime_state_for_project(
                        &connection,
                        &project_id,
                        source_agent_id,
                    )?
                    .unwrap_or_else(|| crate::models::AgentRuntimeState {
                        project_id: project_id.clone(),
                        agent_id: source_agent_id.to_string(),
                        status: canonical_agent_main.session_status.clone(),
                        main_session_id: Some(session_id_for_task.clone()),
                        runtime_cwd: canonical_agent_main
                            .runtime_cwd
                            .clone()
                            .or_else(|| Some(old_context.project_root.display().to_string())),
                        current_queue_entry_id: None,
                        last_dispatch_at: None,
                        last_error: None,
                        terminal_attached: false,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    });
                    let agent = agents::get_agent(&connection, source_agent_id)?;
                    let runtime_root = runtime_state
                        .runtime_cwd
                        .clone()
                        .map(PathBuf::from)
                        .unwrap_or_else(|| old_context.project_root.clone());
                    ensure_session_runtime_root(&runtime_root)?;
                    let created = create_contextual_agent_main_successor(
                        &mut connection,
                        &runtime_root,
                        &old_context.session_dir,
                        &session_id_for_task,
                        old_record.title.as_str(),
                        project_id.as_str(),
                        &agent,
                        &runtime_state,
                    )?;
                    return Ok(ContextualSessionCreation {
                        project_root: runtime_root,
                        session_dir: old_context.session_dir,
                        new_session_id: created.record.id,
                        rotated_from_session_id: Some(session_id_for_task),
                        affected_task_id: None,
                        project_id: Some(project_id),
                        direct_agent_context_seed: Some(DirectAgentContextSeed {
                            agent_id: source_agent_id.to_string(),
                            active_project_id: chat_context_project_id,
                        }),
                    });
                }
            }
        }

        let chat_context_project_id = project_slug_for_task
            .as_deref()
            .and_then(|slug| project_id_for_slug(&connection, slug))
            .or_else(|| project_id_for_slug(&connection, &old_context.project_slug));

        if let Some(source_canonical_agent_main) = old_row.as_ref().filter(|row| {
            row.session_kind == session_records::SESSION_KIND_AGENT_MAIN
                && row.agent_id.as_deref().is_some()
                && agent_id_for_task
                    .as_deref()
                    .map(|requested_agent_id| row.agent_id.as_deref() == Some(requested_agent_id))
                    .unwrap_or(true)
        }) {
            let source_agent_id = source_canonical_agent_main
                .agent_id
                .as_deref()
                .expect("filtered canonical agent main rows always have an agent id");
            let project_id = chat_context_project_id
                .clone()
                .or_else(|| source_canonical_agent_main.project_id.clone())
                .ok_or_else(|| {
                    format!(
                        "Unable to resolve project for contextual agent main-session rotation from {}",
                        session_id_for_task
                    )
                })?;
            let runtime_state = agent_runtime::get_agent_runtime_state_for_project(
                &connection,
                &project_id,
                source_agent_id,
            )?
            .unwrap_or(crate::models::AgentRuntimeState {
                project_id: project_id.clone(),
                agent_id: source_agent_id.to_string(),
                status: "idle".into(),
                main_session_id: Some(session_id_for_task.clone()),
                runtime_cwd: source_canonical_agent_main
                    .runtime_cwd
                    .clone()
                    .or_else(|| Some(old_context.project_root.display().to_string())),
                current_queue_entry_id: None,
                last_dispatch_at: None,
                last_error: None,
                terminal_attached: false,
                created_at: now.clone(),
                updated_at: now.clone(),
            });
            let agent = agents::get_agent(&connection, source_agent_id)?;
            let runtime_root = runtime_state
                .runtime_cwd
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| old_context.project_root.clone());
            ensure_session_runtime_root(&runtime_root)?;
            let created = create_contextual_agent_main_successor(
                &mut connection,
                &runtime_root,
                &old_context.session_dir,
                &session_id_for_task,
                old_record.title.as_str(),
                project_id.as_str(),
                &agent,
                &runtime_state,
            )?;
            update_agent_main_session_for_created_session(
                &connection,
                Some(project_id.as_str()),
                source_agent_id,
                &created.record.id,
            )?;
            return Ok(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: created.record.id,
                rotated_from_session_id: Some(session_id_for_task),
                affected_task_id: None,
                project_id: Some(project_id.clone()),
                direct_agent_context_seed: Some(DirectAgentContextSeed {
                    agent_id: source_agent_id.to_string(),
                    active_project_id: chat_context_project_id.or_else(|| Some(project_id)),
                }),
            });
        }

        if let Some(requested_agent_id) = agent_id_for_task.as_deref() {
            let canonical_agent_main = old_row.as_ref().filter(|row| {
                row.session_kind == session_records::SESSION_KIND_AGENT_MAIN
                    && row.agent_id.as_deref() == Some(requested_agent_id)
            });
            if let Some(project_id) = chat_context_project_id.clone()
                .or_else(|| canonical_agent_main.and_then(|row| row.project_id.clone()))
            {
                if let Some(runtime_state) = agent_runtime::get_agent_runtime_state_for_project(
                    &connection,
                    &project_id,
                    requested_agent_id,
                )?
                .or_else(|| {
                    canonical_agent_main.map(|row| crate::models::AgentRuntimeState {
                        project_id: project_id.clone(),
                        agent_id: requested_agent_id.to_string(),
                        status: "idle".into(),
                        main_session_id: Some(session_id_for_task.clone()),
                        runtime_cwd: row
                            .runtime_cwd
                            .clone()
                            .or_else(|| Some(old_context.project_root.display().to_string())),
                        current_queue_entry_id: None,
                        last_dispatch_at: None,
                        last_error: None,
                        terminal_attached: false,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    })
                }) {
                    let agent = agents::get_agent(&connection, requested_agent_id)?;
                    let runtime_root = runtime_state
                        .runtime_cwd
                        .clone()
                        .map(PathBuf::from)
                        .unwrap_or_else(|| old_context.project_root.clone());
                    ensure_session_runtime_root(&runtime_root)?;
                    let created = create_contextual_agent_main_successor(
                        &mut connection,
                        &runtime_root,
                        &old_context.session_dir,
                        &session_id_for_task,
                        old_record.title.as_str(),
                        project_id.as_str(),
                        &agent,
                        &runtime_state,
                    )?;
                    update_agent_main_session_for_created_session(
                        &connection,
                        Some(project_id.as_str()),
                        requested_agent_id,
                        &created.record.id,
                    )?;
                    return Ok(ContextualSessionCreation {
                        project_root: runtime_root,
                        session_dir: old_context.session_dir,
                        new_session_id: created.record.id,
                        rotated_from_session_id: Some(session_id_for_task),
                        affected_task_id: None,
                        project_id: Some(project_id),
                        direct_agent_context_seed: Some(DirectAgentContextSeed {
                            agent_id: requested_agent_id.to_string(),
                            active_project_id: chat_context_project_id,
                        }),
                    });
                }
            }
        }

        let agent_runtime_row = connection
            .query_row(
                r#"
                SELECT project_id, agent_id
                FROM agent_runtime_states
                WHERE main_session_id = ?1
                LIMIT 1
                "#,
                [session_id_for_task.as_str()],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve agent runtime for session {}: {error}",
                    session_id_for_task
                )
            })?;

        if let Some(canonical_agent_main) = old_row.as_ref().filter(|row| {
            row.session_kind == session_records::SESSION_KIND_AGENT_MAIN
                && row.agent_id.as_deref().is_some()
        }) {
            let source_agent_id = canonical_agent_main
                .agent_id
                .as_deref()
                .expect("filtered canonical agent main rows always have an agent id");
            let chat_context_project_id = project_slug_for_task
                .as_deref()
                .and_then(|slug| project_id_for_slug(&connection, slug))
                .or_else(|| project_id_for_slug(&connection, &old_context.project_slug));
            if let Some(project_id) = chat_context_project_id
                .clone()
                .or_else(|| canonical_agent_main.project_id.clone())
            {
                if let Some(runtime_state) = agent_runtime::get_agent_runtime_state_for_project(
                    &connection,
                    &project_id,
                    source_agent_id,
                )?
                .or_else(|| {
                    Some(crate::models::AgentRuntimeState {
                        project_id: project_id.clone(),
                        agent_id: source_agent_id.to_string(),
                        status: "idle".into(),
                        main_session_id: Some(session_id_for_task.clone()),
                        runtime_cwd: canonical_agent_main
                            .runtime_cwd
                            .clone()
                            .or_else(|| Some(old_context.project_root.display().to_string())),
                        current_queue_entry_id: None,
                        last_dispatch_at: None,
                        last_error: None,
                        terminal_attached: false,
                        created_at: now.clone(),
                        updated_at: now.clone(),
                    })
                }) {
                    let agent = agents::get_agent(&connection, source_agent_id)?;
                    let runtime_root = runtime_state
                        .runtime_cwd
                        .clone()
                        .map(PathBuf::from)
                        .unwrap_or_else(|| old_context.project_root.clone());
                    ensure_session_runtime_root(&runtime_root)?;
                    let created = create_contextual_agent_main_successor(
                        &mut connection,
                        &runtime_root,
                        &old_context.session_dir,
                        &session_id_for_task,
                        old_record.title.as_str(),
                        project_id.as_str(),
                        &agent,
                        &runtime_state,
                    )?;

                    return Ok(ContextualSessionCreation {
                        project_root: runtime_root,
                        session_dir: old_context.session_dir,
                        new_session_id: created.record.id,
                        rotated_from_session_id: Some(session_id_for_task),
                        affected_task_id: None,
                        project_id: Some(project_id),
                        direct_agent_context_seed: Some(DirectAgentContextSeed {
                            agent_id: source_agent_id.to_string(),
                            active_project_id: chat_context_project_id,
                        }),
                    });
                }
            }
        }

        if let Some((project_id, agent_id)) = agent_runtime_row {
            let chat_context_project_id = project_slug_for_task
                .as_deref()
                .and_then(|slug| project_id_for_slug(&connection, slug))
                .or_else(|| project_id_for_slug(&connection, &old_context.project_slug));
            let runtime_state = agent_runtime::get_agent_runtime_state_for_project(
                &connection,
                &project_id,
                &agent_id,
            )?
            .ok_or_else(|| {
                format!(
                    "Agent runtime state for {} in project {} was not found",
                    agent_id, project_id
                )
            })?;
            let agent = agents::get_agent(&connection, &agent_id)?;
            let runtime_root = runtime_state
                .runtime_cwd
                .clone()
                .map(PathBuf::from)
                .unwrap_or_else(|| old_context.project_root.clone());
            ensure_session_runtime_root(&runtime_root)?;
            let created = create_contextual_agent_main_successor(
                &mut connection,
                &runtime_root,
                &old_context.session_dir,
                &session_id_for_task,
                old_record.title.as_str(),
                project_id.as_str(),
                &agent,
                &runtime_state,
            )?;

            return Ok(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: created.record.id,
                rotated_from_session_id: Some(session_id_for_task),
                affected_task_id: None,
                project_id: Some(project_id),
                direct_agent_context_seed: Some(DirectAgentContextSeed {
                    agent_id,
                    active_project_id: chat_context_project_id,
                }),
            });
        }

        if let Some(requested_agent_id) = agent_id_for_task.as_deref() {
            let chat_context_project_id = project_slug_for_task
                .as_deref()
                .and_then(|slug| project_id_for_slug(&connection, slug))
                .or_else(|| project_id_for_slug(&connection, &old_context.project_slug));
            if let Some(project_id) = chat_context_project_id.clone() {
                if let Some(runtime_state) = agent_runtime::get_agent_runtime_state_for_project(
                    &connection,
                    &project_id,
                    requested_agent_id,
                )? {
                    if let Some(current_main_session_id) = runtime_state
                        .main_session_id
                        .as_deref()
                        .filter(|current| *current != session_id_for_task)
                    {
                        let agent = agents::get_agent(&connection, requested_agent_id)?;
                        let current_context = find_session_context_for_session(current_main_session_id)?;
                        let current_record =
                            get_session(&current_context.session_dir, current_main_session_id, false)?;
                        let runtime_root = runtime_state
                            .runtime_cwd
                            .clone()
                            .map(PathBuf::from)
                            .unwrap_or_else(|| current_context.project_root.clone());
                        ensure_session_runtime_root(&runtime_root)?;
                        let created = create_contextual_agent_main_successor(
                            &mut connection,
                            &runtime_root,
                            &current_context.session_dir,
                            current_main_session_id,
                            current_record.title.as_str(),
                            project_id.as_str(),
                            &agent,
                            &runtime_state,
                        )?;

                        return Ok(ContextualSessionCreation {
                            project_root: runtime_root,
                            session_dir: current_context.session_dir,
                            new_session_id: created.record.id,
                            rotated_from_session_id: Some(current_main_session_id.to_string()),
                            affected_task_id: None,
                            project_id: Some(project_id),
                            direct_agent_context_seed: Some(DirectAgentContextSeed {
                                agent_id: requested_agent_id.to_string(),
                                active_project_id: chat_context_project_id,
                            }),
                        });
                    }
                }
            }
        }

        let role_instance_row = connection
            .query_row(
                r#"
                SELECT id, role_id, worktree_path
                FROM role_instances
                WHERE session_id = ?1 AND status IN ('running', 'waiting', 'idle')
                LIMIT 1
                "#,
                [session_id_for_task.as_str()],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, Option<String>>(2)?,
                    ))
                },
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve role instance for session {}: {error}",
                    session_id_for_task
                )
            })?;

        if let Some((role_instance_id, role_id, worktree_path)) = role_instance_row {
            let role = roles::get_role(&connection, &role_id)?;
            let runtime_root = worktree_path
                .map(PathBuf::from)
                .unwrap_or_else(|| old_context.project_root.clone());
            ensure_session_runtime_root(&runtime_root)?;
            let role_project_id = session_project_id(&connection, &session_id_for_task);
            let runtime_cwd = runtime_root.display().to_string();
            let tx = connection.transaction().map_err(|error| {
                format!(
                    "Unable to start contextual role-session rotation transaction: {error}"
                )
            })?;
            let created = session_records::rotate_session_record(
                &tx,
                &runtime_root,
                &old_context.session_dir,
                &session_id_for_task,
                session_records::RotateSessionRecordInput {
                    project_id: role_project_id.as_deref(),
                    title: Some(old_record.title.as_str()),
                    session_kind: session_records::SESSION_KIND_ROLE_INSTANCE,
                    agent_id: None,
                    role_instance_id: Some(role_instance_id.as_str()),
                    task_id: None,
                    workflow_id: None,
                    lane_id: None,
                    assignment: None,
                    worker_type: None,
                    worker_id: None,
                    runtime_cwd: Some(runtime_cwd.as_str()),
                    subscribed: false,
                    agent_runtime: None,
                    update_role_instance_session: true,
                },
            )?;
            role_dispatch::apply_role_session_defaults(
                &runtime_root,
                &old_context.session_dir,
                &created.record.id,
                &role,
            )?;
            tx.commit().map_err(|error| {
                format!(
                    "Unable to commit contextual role-session rotation for instance {}: {error}",
                    role_instance_id
                )
            })?;

            let prior_session_id = session_id_for_task.clone();
            return Ok(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: created.record.id,
                rotated_from_session_id: Some(prior_session_id),
                affected_task_id: None,
                project_id: role_project_id,
                direct_agent_context_seed: None,
            });
        }

        if let Some(requested_agent_id) = agent_id_for_task.as_deref() {
            if let Some(existing_row) = old_row.as_ref().filter(|row| {
                row.session_kind == session_records::SESSION_KIND_AGENT_MAIN
                    && row.agent_id.as_deref() == Some(requested_agent_id)
            }) {
                let project_id = existing_row
                    .project_id
                    .clone()
                    .or_else(|| project_id_for_slug(&connection, &old_context.project_slug))
                    .ok_or_else(|| {
                        format!(
                            "Unable to resolve project for fallback agent main-session rotation from {}",
                            session_id_for_task
                        )
                    })?;
                let runtime_state = agent_runtime::get_agent_runtime_state_for_project(
                    &connection,
                    &project_id,
                    requested_agent_id,
                )?
                .unwrap_or(crate::models::AgentRuntimeState {
                    project_id: project_id.clone(),
                    agent_id: requested_agent_id.to_string(),
                    status: "idle".into(),
                    main_session_id: Some(session_id_for_task.clone()),
                    runtime_cwd: existing_row
                        .runtime_cwd
                        .clone()
                        .or_else(|| Some(old_context.project_root.display().to_string())),
                    current_queue_entry_id: None,
                    last_dispatch_at: None,
                    last_error: None,
                    terminal_attached: false,
                    created_at: now.clone(),
                    updated_at: now.clone(),
                });
                let agent = agents::get_agent(&connection, requested_agent_id)?;
                let runtime_root = runtime_state
                    .runtime_cwd
                    .clone()
                    .map(PathBuf::from)
                    .unwrap_or_else(|| old_context.project_root.clone());
                ensure_session_runtime_root(&runtime_root)?;
                let created = create_contextual_agent_main_successor(
                    &mut connection,
                    &runtime_root,
                    &old_context.session_dir,
                    &session_id_for_task,
                    old_record.title.as_str(),
                    project_id.as_str(),
                    &agent,
                    &runtime_state,
                )?;
                return Ok(ContextualSessionCreation {
                    project_root: runtime_root,
                    session_dir: old_context.session_dir,
                    new_session_id: created.record.id,
                    rotated_from_session_id: Some(session_id_for_task),
                    affected_task_id: None,
                    project_id: Some(project_id.clone()),
                    direct_agent_context_seed: Some(DirectAgentContextSeed {
                        agent_id: requested_agent_id.to_string(),
                        active_project_id: Some(project_id),
                    }),
                });
            }
        }
        let context = if let Some(project_slug) = project_slug_for_task.as_deref() {
            detect_session_context(Some(project_slug))?
        } else {
            old_context
        };
        let project_id = project_id_for_slug(&connection, &context.project_slug);
        let runtime_cwd = context.project_root.display().to_string();
        let created = session_records::create_session_record(
            &connection,
            &context.project_root,
            &context.session_dir,
            session_records::CreateSessionRecordInput {
                project_id: project_id.as_deref(),
                title: agent_id_for_create
                    .as_deref()
                    .map(|_| old_record.title.as_str()),
                session_kind: if agent_id_for_create.is_some() {
                    session_records::SESSION_KIND_AGENT_MAIN
                } else {
                    session_records::SESSION_KIND_STANDALONE
                },
                agent_id: agent_id_for_create.as_deref(),
                role_instance_id: None,
                task_id: None,
                workflow_id: None,
                lane_id: None,
                assignment: None,
                worker_type: None,
                worker_id: None,
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: agent_id_for_create.as_deref().map(|agent_id| {
                    session_records::AgentRuntimeBinding {
                        project_id: project_id.as_deref().unwrap_or("orchestra"),
                        agent_id,
                        runtime_cwd: Some(runtime_cwd.as_str()),
                        current_queue_entry_id: None,
                        status: "",
                        last_error: None,
                    }
                }),
                update_role_instance_session: false,
            },
        )?;
        Ok(ContextualSessionCreation {
            project_root: context.project_root,
            session_dir: context.session_dir,
            new_session_id: created.record.id,
            rotated_from_session_id: None,
            affected_task_id: None,
            project_id,
            direct_agent_context_seed: None,
        })
    })
    .await
    .map_err(|error| format!("Unable to join create_contextual_session task: {error}"))??;

    if let Some(previous_session_id) = prepared.rotated_from_session_id.as_deref() {
        if let Some(runtime) = state.remove_session_runtime(previous_session_id)? {
            runtime.shutdown();
        }
        state.clear_active_session_run(previous_session_id)?;
        state.set_session_subscription(previous_session_id, false)?;
    }

    let actual_new_session_dir = find_session_context_for_session(&prepared.new_session_id)
        .map(|context| context.session_dir)
        .unwrap_or_else(|_| prepared.session_dir.clone());

    state.set_session_subscription(&prepared.new_session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        prepared.project_root,
        actual_new_session_dir.clone(),
        &prepared.new_session_id,
    )?;
    runtime.set_subscribed(true);

    let project_id = prepared.project_id.clone();
    let rotated_from_session_id = prepared.rotated_from_session_id.clone();
    let affected_task_id = prepared.affected_task_id.clone();
    let direct_agent_context_seed = prepared.direct_agent_context_seed.clone();
    let fallback_session_dir = actual_new_session_dir;
    if let Some(seed) = direct_agent_context_seed.as_ref() {
        let connection = database::open_connection()?;
        let agent = agents::get_agent(&connection, &seed.agent_id)?;
        agent_dispatch::seed_direct_agent_session_context(
            &connection,
            &fallback_session_dir,
            &prepared.new_session_id,
            &agent,
            seed.active_project_id.as_deref(),
        )?;
    }
    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let new_session_id_for_task = prepared.new_session_id.clone();
    let decorated_record = spawn_blocking(move || {
        let session_dir = find_session_context_for_session(&new_session_id_for_task)
            .map(|context| context.session_dir)
            .unwrap_or(fallback_session_dir);
        load_decorated_session_record(
            &session_dir,
            &new_session_id_for_task,
            true,
            &terminal_attached_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join create_contextual_session record task: {error}"))??;

    state.log(
        "info",
        "sessions.create_contextual",
        &format!(
            "Created contextual successor session {} from {}",
            decorated_record.id, session_id
        ),
    );
    if let Some(agent_id) = agent_id.as_deref() {
        state.log(
            "info",
            "agent.session.create",
            &format!(
                "Created contextual agent session {} from {} for agent {} in project slug {}",
                decorated_record.id,
                session_id,
                agent_id,
                project_slug.as_deref().unwrap_or("<default>"),
            ),
        );
    }
    if let Ok(connection) = database::open_connection() {
        record_session_domain_event(
            &connection,
            &decorated_record.id,
            "session.created",
            project_id.clone(),
            json!({
                "sessionId": decorated_record.id.clone(),
                "title": decorated_record.title.clone(),
                "replacedSessionId": rotated_from_session_id.clone(),
            }),
        );
        if let Some(ref agent_id_str) = agent_id_for_post_commit {
            update_agent_main_session_for_created_session(
                &connection,
                project_id.as_deref(),
                agent_id_str,
                &decorated_record.id,
            )?;
        }
    }

    let changed_session_ids = rotated_from_session_id
        .into_iter()
        .chain(std::iter::once(decorated_record.id.clone()))
        .collect::<Vec<_>>();
    let _ =
        app_events::emit_session_change(&app, "sessions.create_contextual", changed_session_ids);
    if let Some(task_id) = affected_task_id {
        let _ = app_events::emit_task_change(&app, "task.assignment.session_rotated", [task_id]);
    }

    if let Some(agent_id) = agent_id.as_deref() {
        state.log(
            "info",
            "agent.session.create",
            &format!(
                "Returning contextual agent session {} (title={}) for agent {}",
                decorated_record.id, decorated_record.title, agent_id,
            ),
        );
    }

    attach_session_control_metadata(state.inner(), decorated_record)
}

#[tauri::command]
pub async fn delete_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(runtime) = state.remove_session_runtime(&session_id)? {
        runtime.shutdown();
    }
    state.clear_session_tracking(&session_id)?;
    let session_id_for_task = session_id.clone();
    spawn_blocking(move || {
        let connection = database::open_connection()?;
        dismiss_session_entry(&connection, &session_id_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join dismiss_session task: {error}"))??;
    state.log(
        "info",
        "sessions.dismiss",
        &format!("Dismissed pi session {} from the session list", session_id),
    );
    if let Ok(connection) = database::open_connection() {
        let project_id = session_project_id(&connection, &session_id);
        record_session_domain_event(
            &connection,
            &session_id,
            "session.dismissed",
            project_id,
            json!({ "sessionId": session_id.clone() }),
        );
    }
    let _ = app_events::emit_session_change(&app, "sessions.dismiss", [session_id]);
    Ok(())
}

#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    state
        .sync_pi_runtime_health()
        .map_err(|error| format!("Unable to resume session because PI is unavailable: {error}"))?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to resume session because Pi setup is incomplete: {error}")
    })?;
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = spawn_blocking(move || {
        let connection = database::open_connection()?;
        restore_session_entry(&connection, &session_id_for_task)?;
        resolve_session_paths(&session_id_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join resume_session context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir.clone(),
        &session_id,
    )?;

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let active_runtime_session_ids = state.active_runtime_session_ids()?;
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        load_decorated_session_record_with_runtime_state(
            &session_dir,
            &session_id_for_task,
            true,
            &terminal_attached_session_ids,
            &active_runtime_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join resume_session record task: {error}"))??;
    state.log(
        "info",
        "sessions.resume",
        &format!("Resumed pi session {}", record.id),
    );
    if let Ok(connection) = database::open_connection() {
        let project_id = session_project_id(&connection, &record.id);
        record_session_domain_event(
            &connection,
            &record.id,
            "session.resumed",
            project_id,
            json!({ "sessionId": record.id.clone() }),
        );
    }
    attach_session_control_metadata(state.inner(), record)
}

#[tauri::command]
pub async fn subscribe_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to subscribe to session because PI is unavailable: {error}")
    })?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to subscribe to session because Pi setup is incomplete: {error}")
    })?;
    let result: Result<SessionRecord, String> = async {
        let session_id_for_task = session_id.clone();
        let (project_root, session_dir) =
            spawn_blocking(move || resolve_session_paths(&session_id_for_task))
                .await
                .map_err(|error| {
                    format!("Unable to join subscribe_session context task: {error}")
                })??;

        state.set_session_subscription(&session_id, true)?;
        let runtime = ensure_runtime(
            &state.session_runtimes,
            app,
            project_root,
            session_dir.clone(),
            &session_id,
        )?;
        runtime.set_subscribed(true);

        let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
        let active_runtime_session_ids = state.active_runtime_session_ids()?;
        let session_id_for_task = session_id.clone();
        let record = spawn_blocking(move || {
            load_decorated_session_record_with_runtime_state(
                &session_dir,
                &session_id_for_task,
                true,
                &terminal_attached_session_ids,
                &active_runtime_session_ids,
                SessionDecorationSurface::Detail,
            )
        })
        .await
        .map_err(|error| format!("Unable to join subscribe_session record task: {error}"))??;
        state.log(
            "info",
            "sessions.subscribe",
            &format!("Subscribed to pi session {}", record.id),
        );
        Ok(record)
    }
    .await;

    if let Err(error) = &result {
        log_session_command_failure(
            &state,
            "sessions.subscribe.failed",
            &session_id,
            "subscribe",
            error,
        );
    }

    result.and_then(|record| attach_session_control_metadata(state.inner(), record))
}

#[tauri::command]
pub async fn unsubscribe_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    state.set_session_subscription(&session_id, false)?;

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        let (_, session_dir) = resolve_session_paths(&session_id_for_task)?;
        load_decorated_session_record(
            &session_dir,
            &session_id_for_task,
            false,
            &terminal_attached_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join unsubscribe_session task: {error}"))??;
    state.log(
        "info",
        "sessions.unsubscribe",
        &format!("Unsubscribed from pi session {}", record.id),
    );
    attach_session_control_metadata(state.inner(), record)
}

#[tauri::command]
pub async fn get_session_model_state(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionModelState, String> {
    let result: Result<SessionModelState, String> = async {
        let session_id_for_task = session_id.clone();
        let (project_root, session_dir) =
            spawn_blocking(move || resolve_session_paths(&session_id_for_task))
                .await
                .map_err(|error| {
                    format!("Unable to join get_session_model_state context task: {error}")
                })??;

        let runtime = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
            runtime
        } else {
            ensure_runtime(
                &state.session_runtimes,
                app,
                project_root,
                session_dir,
                &session_id,
            )?
        };

        spawn_blocking(move || runtime.get_model_state())
            .await
            .map_err(|error| {
                format!("Unable to join get_session_model_state runtime task: {error}")
            })?
    }
    .await;

    if let Err(error) = &result {
        log_session_command_failure(
            &state,
            "sessions.model_state.failed",
            &session_id,
            "load model state",
            error,
        );
    }

    result
}

#[tauri::command]
pub async fn get_session_stats(
    _app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionStats, String> {
    let result: Result<SessionStats, String> = async {
        let session_id_for_task = session_id.clone();
        let (project_root, session_dir) =
            spawn_blocking(move || resolve_session_paths(&session_id_for_task))
                .await
                .map_err(|error| {
                    format!("Unable to join get_session_stats context task: {error}")
                })??;

        if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
            spawn_blocking(move || runtime.get_stats())
                .await
                .map_err(|error| {
                    format!("Unable to join get_session_stats runtime task: {error}")
                })?
        } else {
            let project_root_for_task = project_root.clone();
            let session_dir_for_task = session_dir.clone();
            let session_id_for_task = session_id.clone();
            spawn_blocking(move || {
                load_session_stats_from_file(
                    &project_root_for_task,
                    &session_dir_for_task,
                    &session_id_for_task,
                )
            })
            .await
            .map_err(|error| format!("Unable to join get_session_stats file task: {error}"))?
        }
    }
    .await;

    if let Err(error) = &result {
        log_session_command_failure(
            &state,
            "sessions.stats.failed",
            &session_id,
            "load session stats",
            error,
        );
    }

    result
}

#[tauri::command]
pub async fn set_session_model(
    _app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<SessionModelState, String> {
    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to change session models because PI is unavailable: {error}")
    })?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to change session models because Pi setup is incomplete: {error}")
    })?;
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) =
        spawn_blocking(move || resolve_session_paths(&session_id_for_task))
            .await
            .map_err(|error| format!("Unable to join set_session_model context task: {error}"))??;

    let result = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        let provider_for_task = provider.clone();
        let model_id_for_task = model_id.clone();
        spawn_blocking(move || runtime.set_model(&provider_for_task, &model_id_for_task))
            .await
            .map_err(|error| format!("Unable to join set_session_model runtime task: {error}"))??
    } else {
        let project_root_for_task = project_root.clone();
        let session_dir_for_task = session_dir.clone();
        let session_id_for_task = session_id.clone();
        let provider_for_task = provider.clone();
        let model_id_for_task = model_id.clone();
        spawn_blocking(move || {
            apply_session_model(
                &project_root_for_task,
                &session_dir_for_task,
                &session_id_for_task,
                &provider_for_task,
                &model_id_for_task,
            )
        })
        .await
        .map_err(|error| format!("Unable to join set_session_model file task: {error}"))??
    };

    state.log(
        "info",
        "sessions.model",
        &format!(
            "Changed session {} to {}/{} (resolved state: provider={} model={} name={})",
            session_id,
            provider,
            model_id,
            result
                .current_model
                .as_ref()
                .map(|model| model.provider.as_str())
                .unwrap_or("<none>"),
            result
                .current_model
                .as_ref()
                .map(|model| model.id.as_str())
                .unwrap_or("<none>"),
            result
                .current_model
                .as_ref()
                .map(|model| model.name.as_str())
                .unwrap_or("<none>"),
        ),
    );
    state.log_authorized_action(
        "auth.audit",
        "set_session_model",
        None,
        None,
        &session_id,
        "success",
    );

    Ok(result)
}

#[tauri::command]
pub async fn compact_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    custom_instructions: Option<String>,
) -> Result<SessionRecord, String> {
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) =
        spawn_blocking(move || resolve_session_paths(&session_id_for_task))
            .await
            .map_err(|error| format!("Unable to join compact_session context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let runtime = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime
    } else {
        ensure_runtime(
            &state.session_runtimes,
            app.clone(),
            project_root,
            session_dir.clone(),
            &session_id,
        )?
    };
    runtime.set_subscribed(true);

    let custom_instructions_for_task = custom_instructions.clone();
    let compact_result = spawn_blocking(move || {
        perform_session_compaction(runtime, "manual", custom_instructions_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join compact_session runtime task: {error}"))?;

    if let Err(error) = &compact_result {
        log_session_command_failure(
            &state,
            "sessions.compact.failed",
            &session_id,
            "compact the session",
            error,
        );
        return Err(error.clone());
    }

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        load_decorated_session_record(
            &session_dir,
            &session_id_for_task,
            true,
            &terminal_attached_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join compact_session record task: {error}"))??;

    state.log(
        "info",
        "sessions.compact",
        &format!("Compacted session {}", session_id),
    );
    let _ = app_events::emit_session_change(&app, "sessions.compact", [session_id.clone()]);
    attach_session_control_metadata(state.inner(), record)
}

#[tauri::command]
pub async fn reload_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) =
        spawn_blocking(move || resolve_session_paths(&session_id_for_task))
            .await
            .map_err(|error| format!("Unable to join reload_session context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let runtime = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime
    } else {
        ensure_runtime(
            &state.session_runtimes,
            app.clone(),
            project_root.clone(),
            session_dir.clone(),
            &session_id,
        )?
    };
    runtime.set_subscribed(true);

    let reload_result = spawn_blocking(move || perform_session_reload(runtime, "manual"))
        .await
        .map_err(|error| format!("Unable to join reload_session runtime task: {error}"))?;

    if let Err(error) = &reload_result {
        if is_unknown_command_error(error) {
            if let Some(runtime) = state.remove_session_runtime(&session_id)? {
                runtime.shutdown();
            }
            state.clear_active_session_run(&session_id)?;
            let replacement = ensure_runtime(
                &state.session_runtimes,
                app.clone(),
                project_root,
                session_dir.clone(),
                &session_id,
            )?;
            replacement.set_subscribed(true);
            replacement.mark_control_operation_success("reload", "manual", "Session reloaded.");
            state.log(
                "info",
                "sessions.reload.fallback",
                &format!(
                    "Reload command unsupported for session {}; restarted the runtime locally instead",
                    session_id
                ),
            );
        } else {
            log_session_command_failure(
                &state,
                "sessions.reload.failed",
                &session_id,
                "reload the session",
                error,
            );
            return Err(error.clone());
        }
    }

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        load_decorated_session_record(
            &session_dir,
            &session_id_for_task,
            true,
            &terminal_attached_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join reload_session record task: {error}"))??;

    state.log(
        "info",
        "sessions.reload",
        &format!("Reloaded session {}", session_id),
    );
    let _ = app_events::emit_session_change(&app, "sessions.reload", [session_id.clone()]);
    attach_session_control_metadata(state.inner(), record)
}

#[tauri::command]
pub async fn stop_session_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    notes: Option<String>,
) -> Result<SessionRecord, String> {
    let removed_runtime = state.remove_session_runtime(&session_id)?;
    let had_runtime = removed_runtime.is_some();
    let interrupted_prompt_message = removed_runtime
        .as_ref()
        .and_then(|runtime| runtime.current_prompt_message());
    let interrupted_active_run = had_runtime;
    if let Some(runtime) = removed_runtime {
        if interrupted_active_run {
            runtime.abort_active_run();
        } else {
            runtime.shutdown();
        }
    }
    state.clear_active_session_run(&session_id)?;

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let session_id_for_task = session_id.clone();
    let stop_message = notes
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|value| format!("Session run stopped by operator. {value}"))
        .unwrap_or_else(|| "Session run stopped by operator.".to_string());
    let stop_message_for_task = stop_message.clone();
    let interrupted_prompt_message_for_task = interrupted_prompt_message.clone();
    let mut record = spawn_blocking(move || {
        let (_, session_dir) = resolve_session_paths(&session_id_for_task)?;
        if interrupted_active_run {
            let existing_record = crate::services::pi_sessions::get_session(
                &session_dir,
                &session_id_for_task,
                true,
            )?;
            if let Some(prompt_message) = interrupted_prompt_message_for_task.as_deref() {
                let prompt_already_persisted = existing_record.events.iter().any(|event| {
                    event.kind == "user" && event.message.trim() == prompt_message.trim()
                });
                if !prompt_already_persisted {
                    crate::services::pi_sessions::append_session_user_message(
                        &session_dir,
                        &session_id_for_task,
                        prompt_message,
                    )?;
                }
            }
            crate::services::pi_sessions::append_session_system_message(
                &session_dir,
                &session_id_for_task,
                &stop_message_for_task,
            )?;
        }
        load_decorated_session_record(
            &session_dir,
            &session_id_for_task,
            true,
            &terminal_attached_session_ids,
            SessionDecorationSurface::Detail,
        )
    })
    .await
    .map_err(|error| format!("Unable to join stop_session_runtime task: {error}"))??;

    if interrupted_active_run {
        record.status = "paused".into();
    }

    state.log(
        "info",
        "sessions.stop",
        &format!(
            "Stopped session runtime {} (runtime_present={} interrupted_active_run={})",
            session_id, had_runtime, interrupted_active_run
        ),
    );
    if let Ok(connection) = database::open_connection() {
        let project_id = session_project_id(&connection, &session_id);
        record_session_domain_event(
            &connection,
            &session_id,
            "session.stopped_by_user",
            project_id,
            json!({
                "sessionId": session_id.clone(),
                "status": record.status.clone(),
                "notes": notes,
                "onBehalfOfUser": true,
                "action": "stop_session_runtime",
            }),
        );
    }
    let _ = app_events::emit_session_change(&app, "sessions.stop", [session_id.clone()]);
    attach_session_control_metadata(state.inner(), record)
}

pub(crate) fn validate_session_message_request(
    state: &AppState,
    session_id: &str,
    message: String,
) -> Result<String, String> {
    let trimmed_message = message.trim().to_string();
    if trimmed_message.is_empty() {
        return Err("Message cannot be empty".into());
    }

    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to send a session message because PI is unavailable: {error}")
    })?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to send a session message because Pi setup is incomplete: {error}")
    })?;
    model_limits::ensure_session_message_allowed(state, session_id)?;

    Ok(trimmed_message)
}

pub async fn send_session_message_with_optional_run_id(
    app: AppHandle,
    state: &AppState,
    session_id: String,
    message: String,
    requested_run_id: Option<String>,
) -> Result<QueuedSessionMessage, String> {
    let trimmed_message = validate_session_message_request(state, &session_id, message)?;

    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) =
        spawn_blocking(move || resolve_session_paths(&session_id_for_task))
            .await
            .map_err(|error| {
                format!("Unable to join send_session_message context task: {error}")
            })??;

    let run_id = requested_run_id
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .unwrap_or_else(|| crate::state::generate_id("remote-run"));

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir,
        &session_id,
    )?;
    runtime.set_subscribed(true);

    if let Err(error) = spawn_blocking({
        let runtime = runtime.clone();
        move || maybe_auto_compact(runtime)
    })
    .await
    .map_err(|error| format!("Unable to join send_session_message auto-compact task: {error}"))?
    {
        state.log(
            "warn",
            "sessions.auto_compact.failed",
            &format!(
                "Session {} auto-compaction check failed: {}",
                session_id, error
            ),
        );
    }

    let mut delivery_mode = "prompt";
    let mut owns_prompt_run = false;

    match state.begin_session_run(&session_id, &run_id) {
        Ok(()) => {
            if runtime.has_active_prompt() {
                let _ = state.end_session_run(&session_id, &run_id);
                delivery_mode = "follow_up";
            } else {
                owns_prompt_run = true;
            }
        }
        Err(error) if error == "This session is already processing a message" => {
            if runtime.has_active_prompt() {
                delivery_mode = "follow_up";
            } else {
                state.clear_active_session_run(&session_id)?;
                state.begin_session_run(&session_id, &run_id)?;
                owns_prompt_run = true;
            }
        }
        Err(error) => return Err(error),
    }

    let queued = QueuedSessionMessage {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        message: trimmed_message.clone(),
        timestamp: crate::state::now_iso(),
    };

    let run_id_for_task = run_id.clone();
    let message_for_task = trimmed_message.clone();
    let delivery_mode_for_task = delivery_mode.to_string();
    match spawn_blocking(move || {
        runtime.start_delivery(&run_id_for_task, &delivery_mode_for_task, &message_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join send_session_message runtime task: {error}"))?
    {
        Ok(()) => {
            let log_target = if delivery_mode == "prompt" {
                "sessions.message.start"
            } else {
                "sessions.message.follow_up"
            };
            let log_message = if delivery_mode == "prompt" {
                format!("Sent prompt to live pi RPC session {}", session_id)
            } else {
                format!(
                    "Queued follow-up message for live pi RPC session {}",
                    session_id
                )
            };
            state.log("info", log_target, &log_message);
            state.log_authorized_action(
                "auth.audit",
                "send_session_message",
                None,
                None,
                &session_id,
                "success",
            );
            Ok(queued)
        }
        Err(error) => {
            if owns_prompt_run {
                let _ = state.end_session_run(&session_id, &run_id);
            }
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn send_session_message(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    message: String,
    run_id: String,
) -> Result<QueuedSessionMessage, String> {
    send_session_message_with_optional_run_id(app, state.inner(), session_id, message, Some(run_id))
        .await
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::SessionEvent,
        services::{database, pi_sessions::SessionContext, session_list},
    };
    use std::{
        env, fs,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn make_session_record(session_id: &str) -> SessionRecord {
        SessionRecord {
            id: session_id.to_string(),
            title: "Test session".into(),
            status: "active".into(),
            created_at: "2026-03-21T00:00:00Z".into(),
            updated_at: "2026-03-21T00:00:00Z".into(),
            subscribed: false,
            events: vec![SessionEvent {
                id: "event-1".into(),
                kind: "system".into(),
                message: "hello".into(),
                timestamp: "2026-03-21T00:00:00Z".into(),
                thinking_text: None,
            }],
            terminal_attached: false,
            debug_info: None,
            task_id: None,
            task_project_id: None,
            task_number: None,
            task_title: None,
            active_task_id: None,
            active_task_project_id: None,
            active_task_number: None,
            active_task_title: None,
            worker_type: None,
            worker_name: None,
            list_visibility: None,
            messageability: None,
            control_capabilities: None,
            control_operation: None,
        }
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        let dir = env::temp_dir().join(suffix);
        fs::create_dir_all(&dir).expect("temp dir should be creatable");
        dir
    }

    fn make_agent_definition(name: &str) -> crate::models::AgentDefinition {
        crate::models::AgentDefinition {
            id: "agent-1".into(),
            slug: "agent-1".into(),
            name: name.into(),
            description: None,
            system_prompt: None,
            provider: None,
            model: None,
            role_id: None,
            scope: "project".into(),
            project_id: Some("project-1".into()),
            thinking_level: "medium".into(),
            compaction_window: None,
            policy_ids: Vec::new(),
            direct_permissions: Vec::new(),
            system: false,
            immutable: false,
            archived: false,
            created_at: "2026-03-21T00:00:00Z".into(),
            updated_at: "2026-03-21T00:00:00Z".into(),
        }
    }

    fn make_list_test_context(label: &str, project_slug: &str) -> SessionContext {
        let root = unique_temp_dir(label);
        let orchestra_root = root.join("orchestra-root");
        let project_root = root.join("project-root");
        let session_dir = orchestra_root
            .join("projects")
            .join(project_slug)
            .join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");
        SessionContext {
            project_root,
            project_slug: project_slug.to_string(),
            orchestra_root,
            session_dir,
        }
    }

    fn write_list_test_session(
        context: &SessionContext,
        file_name: &str,
        session_id: &str,
        title: &str,
        timestamp: &str,
    ) -> PathBuf {
        let session_path = context.session_dir.join(file_name);
        let content = format!(
            "{}\n{}\n{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": timestamp,
                "cwd": context.project_root.display().to_string(),
            }),
            serde_json::json!({
                "type": "session_info",
                "id": format!("info-{session_id}"),
                "parentId": serde_json::Value::Null,
                "timestamp": timestamp,
                "name": title,
            }),
            serde_json::json!({
                "type": "message",
                "id": format!("msg-{session_id}"),
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("hello from {session_id}") }],
                    "timestamp": 1773835261000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");
        session_path
    }

    #[test]
    fn rotated_assignment_successor_rebinds_canonical_context() {
        let root = unique_temp_dir("rotated-assignment-successor-rebinds-context");
        let project_root = root.join("project-root");
        let session_dir = root
            .join("orchestra-root")
            .join("project-1")
            .join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'ORC', NULL, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("project insert should succeed");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', 'off', '[]', 0, 0, 0, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("agent insert should succeed");
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES ('workflow-1', 'workflow-1', 'Workflow 1', NULL, 0, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("workflow insert should succeed");
        connection
            .execute(
                r#"
                INSERT INTO workflow_lanes (
                    id, workflow_id, lane_key, name, description, lane_order, assigned_entity_type,
                    assigned_entity_id, entry_prompt_template, use_separate_worktree,
                    require_user_approval_on_success, success_transition_type,
                    success_target_lane_id, failure_transition_type, failure_target_lane_id,
                    user_intervention_target_lane_id, created_at, updated_at
                )
                VALUES (
                    'lane-1', 'workflow-1', 'lane-1', 'Lane 1', NULL, 0, 'agent', 'agent-1', NULL,
                    0, 0, 'end', NULL, 'end', NULL, NULL,
                    '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z'
                )
                "#,
                [],
            )
            .expect("workflow lane insert should succeed");
        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (
                    'task-1', 'project-1', 1, 'ORC-1', 'Rotating task', NULL, 'task', 'in_progress',
                    'P1', 'workflow-1', 'lane-1', 'unassigned', NULL, NULL, NULL, 0,
                    '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z'
                )
                "#,
                [],
            )
            .expect("task insert should succeed");

        let runtime_cwd = project_root.to_string_lossy().into_owned();
        let original = session_records::create_session_record(
            &connection,
            &project_root,
            &session_dir,
            session_records::CreateSessionRecordInput {
                project_id: Some("project-1"),
                title: Some("Original"),
                session_kind: session_records::SESSION_KIND_AGENT_MAIN,
                agent_id: Some("agent-1"),
                role_instance_id: None,
                task_id: Some("task-1"),
                workflow_id: Some("workflow-1"),
                lane_id: Some("lane-1"),
                assignment: None,
                worker_type: Some("agent"),
                worker_id: Some("agent-1"),
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: None,
                update_role_instance_session: false,
            },
        )
        .expect("original session should be created");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id,
                    runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome,
                    completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at,
                    updated_at
                )
                VALUES (
                    'assignment-1', 'task-1', 'workflow-1', 'lane-1', 'agent', 'agent-1', 'active', ?1,
                    ?2, NULL, NULL, 'Prompt', NULL, NULL, 0, NULL, '2026-03-21T00:00:00Z', NULL,
                    '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z'
                )
                "#,
                rusqlite::params![original.record.id.as_str(), runtime_cwd.as_str()],
            )
            .expect("assignment insert should succeed");
        session_records::bind_session_context(
            &connection,
            &original.record.id,
            session_records::SessionContextBinding {
                project_id: Some("project-1"),
                session_kind: Some(session_records::SESSION_KIND_AGENT_MAIN),
                worker_type: Some("agent"),
                worker_id: Some("agent-1"),
                agent_id: Some("agent-1"),
                role_instance_id: None,
                task_id: Some("task-1"),
                workflow_id: Some("workflow-1"),
                lane_id: Some("lane-1"),
                assignment_id: Some("assignment-1"),
                runtime_cwd: Some(project_root.as_path()),
            },
        )
        .expect("original session should be bound");

        let open_assignment =
            task_runtime::get_active_assignment_for_session(&connection, &original.record.id)
                .expect("assignment lookup should succeed")
                .expect("active assignment should exist");
        let replacement_assignment_id = "assignment-2";
        let rotated = session_records::rotate_session_record(
            &connection,
            &project_root,
            &session_dir,
            &original.record.id,
            session_records::RotateSessionRecordInput {
                project_id: Some("project-1"),
                title: Some("Original"),
                session_kind: session_records::SESSION_KIND_AGENT_MAIN,
                agent_id: Some("agent-1"),
                role_instance_id: None,
                task_id: Some("task-1"),
                workflow_id: Some("workflow-1"),
                lane_id: Some("lane-1"),
                assignment: Some(session_records::AssignmentBinding {
                    assignment_id: replacement_assignment_id,
                    runtime_cwd: Some(runtime_cwd.as_str()),
                }),
                worker_type: Some("agent"),
                worker_id: Some("agent-1"),
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: None,
                update_role_instance_session: false,
            },
        )
        .expect("rotation should create successor session");

        let prebind_assignment_id: Option<String> = connection
            .query_row(
                "SELECT assignment_id FROM sessions WHERE id = ?1",
                [rotated.record.id.as_str()],
                |row| row.get(0),
            )
            .expect("rotated session row should exist");
        assert!(prebind_assignment_id.is_none());

        let replacement = task_runtime::rotate_open_assignment_session(
            &connection,
            &open_assignment,
            &rotated.record.id,
            Some(replacement_assignment_id),
            "2026-03-21T00:01:00Z",
        )
        .expect("assignment rotation should succeed");
        bind_rotated_assignment_session_context(
            &connection,
            "project-1",
            session_records::SESSION_KIND_AGENT_MAIN,
            &replacement,
        )
        .expect("replacement session should be rebound");

        let rebound: (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection
            .query_row(
                "SELECT task_id, workflow_id, lane_id, assignment_id, worker_type, agent_id FROM sessions WHERE id = ?1",
                [rotated.record.id.as_str()],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
            )
            .expect("rebound session row should exist");
        assert_eq!(rebound.0.as_deref(), Some("task-1"));
        assert_eq!(rebound.1.as_deref(), Some("workflow-1"));
        assert_eq!(rebound.2.as_deref(), Some("lane-1"));
        assert_eq!(rebound.3.as_deref(), Some(replacement_assignment_id));
        assert_eq!(rebound.4.as_deref(), Some("agent"));
        assert_eq!(rebound.5.as_deref(), Some("agent-1"));
    }

    fn insert_completed_task_session_fixture(connection: &rusqlite::Connection, session_id: &str) {
        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, NULL, ?9, NULL, NULL, NULL, 0, ?10, ?11)
                "#,
                rusqlite::params![
                    "task-1",
                    "project-1",
                    1,
                    "ORC-1",
                    "Closable task",
                    "task",
                    "completed",
                    "P1",
                    "role",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("task insert should succeed");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_runs (id, task_id, lane_id, session_id, result, notes, started_at, completed_at)
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7)
                "#,
                rusqlite::params![
                    "lane-run-1",
                    "task-1",
                    "lane-1",
                    session_id,
                    "success",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:01:00Z",
                ],
            )
            .expect("lane run insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'Completed task session', 'task_assignment', 'closed', 'closed', ?3, ?3, 0, 'closed', ?3, ?3)",
                rusqlite::params![session_id, format!("/tmp/{session_id}.jsonl"), "2026-03-21T00:00:00Z"],
            )
            .expect("canonical session row should insert");
    }

    #[test]
    fn decorates_completed_task_sessions_as_closed() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        insert_completed_task_session_fixture(&connection, "session-1");

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
            SessionDecorationSurface::Detail,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "closed");
    }

    #[test]
    fn reactivated_completed_task_sessions_become_messageable_when_runtime_is_active() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        insert_completed_task_session_fixture(&connection, "session-reopened");

        let mut active_runtime_session_ids = std::collections::HashSet::new();
        active_runtime_session_ids.insert("session-reopened".to_string());
        let decorated = decorate_session_record_with_runtime_state(
            &connection,
            &std::collections::HashSet::new(),
            &active_runtime_session_ids,
            make_session_record("session-reopened"),
            false,
            SessionDecorationSurface::Detail,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "active");
        assert_eq!(
            decorated.list_visibility,
            Some(SessionListVisibilityState::Active)
        );
        assert_eq!(
            decorated.messageability,
            Some(SessionMessageability::Messageable)
        );
    }

    #[test]
    fn dismiss_and_restore_session_entries_round_trip() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'Session 1', 'standalone', 'idle', 'active', ?3, ?3, 0, 'active', ?3, ?3)",
                rusqlite::params!["session-1", "/tmp/session-1.jsonl", "2026-03-21T00:00:00Z"],
            )
            .expect("canonical session row should insert");

        dismiss_session_entry(&connection, "session-1").expect("dismiss should succeed");
        let dismissed =
            session_list::load_hidden_session_ids(&connection).expect("dismissed ids should load");
        assert!(dismissed.contains("session-1"));

        restore_session_entry(&connection, "session-1").expect("restore should succeed");
        let dismissed_after = session_list::load_hidden_session_ids(&connection)
            .expect("dismissed ids should reload");
        assert!(!dismissed_after.contains("session-1"));
    }

    #[test]
    fn cleanup_stale_dismissed_sessions_removes_old_entries() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, hidden_reason, dismissed_at, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'Stale Session', 'standalone', 'closed', 'hidden', ?3, ?4, ?5, ?5, 0, 'closed', ?5, ?5)",
                rusqlite::params![
                    "stale-session",
                    "/tmp/stale-session.jsonl",
                    session_list::SESSION_HIDDEN_REASON_USER_DISMISSED,
                    "2000-01-01T00:00:00Z",
                    "2026-03-21T00:00:00Z"
                ],
            )
            .expect("stale canonical session row should insert");

        let cleaned = session_list::cleanup_user_dismissed_sessions(&connection)
            .expect("cleanup should succeed");
        assert_eq!(cleaned, vec!["stale-session".to_string()]);
        let dismissed_after = session_list::load_hidden_session_ids(&connection)
            .expect("dismissed ids should reload");
        assert!(dismissed_after.is_empty());
    }

    #[test]
    fn list_sessions_reads_canonical_rows_without_legacy_tables() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        connection
            .execute_batch("DROP TABLE session_catalog; DROP TABLE session_list_entries;")
            .expect("legacy tables should drop");

        let context = make_list_test_context(
            "orchestra-command-session-list-no-legacy-tables",
            "command-session-list-no-legacy-tables-test",
        );
        let session_path = write_list_test_session(
            &context,
            "2026-03-21T00-01-00Z_session-1.jsonl",
            "session-1",
            "Canonical session",
            "2026-03-21T00:01:00Z",
        );
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-1",
            None,
            None,
            &session_path,
        )
        .expect("canonical session row should repair");

        let listed = list_command_sessions_with_connection(
            &connection,
            std::slice::from_ref(&context),
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("session list should succeed without legacy tables");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-1");
    }

    #[test]
    fn global_session_list_keeps_detached_persistent_agent_sessions_visible() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'ORC', NULL, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("project insert should succeed");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', 'off', '[]', 0, 0, 0, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("agent insert should succeed");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'ORC-1', 'Completed task', NULL, 'task', 'completed', 'P1', NULL, NULL, 'agent', 'agent-1', NULL, NULL, 0, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("task insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, task_id, primary_task_id, worker_type, worker_id, owner_worker_type, owner_worker_id, agent_id, transcript_exists, lifecycle_state, created_at, updated_at) VALUES ('session-1', 'project-1', '/tmp/session-1.jsonl', '/tmp/session-1.jsonl', 'Agent 1 main session', 'agent_main', 'active', 'active', NULL, 'task-1', 'agent', 'agent-1', 'agent', 'agent-1', 'agent-1', 0, 'active', '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("session insert should succeed");

        let listed = list_all_command_sessions_with_connection(
            &connection,
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("global session list should succeed");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-1");
        assert_eq!(listed[0].title, "Agent 1 main session");
    }

    #[test]
    fn closes_role_assignment_sessions_after_lane_handoff_even_if_task_continues() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?10, ?11, NULL, NULL, 0, ?12, ?13)
                "#,
                rusqlite::params![
                    "task-1",
                    "project-1",
                    1,
                    "ORC-1",
                    "Handed off task",
                    "task",
                    "ready",
                    "P1",
                    "lane-review",
                    "agent",
                    "agent-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("task insert should succeed");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id,
                    runtime_cwd, role_queue_entry_id, role_instance_id, prompt, started_at,
                    completed_at, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, NULL, ?10, ?11, ?12, ?13)
                "#,
                rusqlite::params![
                    "assignment-1",
                    "task-1",
                    "workflow-1",
                    "lane-implement",
                    "role",
                    "role-1",
                    "completed",
                    "session-1",
                    "instance-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:01:00Z",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:01:00Z",
                ],
            )
            .expect("assignment insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'Handed off session', 'task_assignment', 'closed', 'closed', ?3, ?3, 0, 'closed', ?3, ?3)",
                rusqlite::params!["session-1", "/tmp/session-1.jsonl", "2026-03-21T00:00:00Z"],
            )
            .expect("canonical session row should insert");

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
            SessionDecorationSurface::Detail,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "closed");
    }

    #[test]
    fn keeps_sessions_waiting_on_user_approval_open() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?10, NULL, NULL, NULL, 0, ?11, ?12)
                "#,
                rusqlite::params![
                    "task-1",
                    "project-1",
                    1,
                    "ORC-1",
                    "Awaiting approval task",
                    "task",
                    "in_review",
                    "P1",
                    "lane-implement",
                    "user",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("task insert should succeed");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id,
                    runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome,
                    completion_notes, started_at, completed_at, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, NULL, 'success', 'Ready', ?10, NULL, ?11, ?12)
                "#,
                rusqlite::params![
                    "assignment-1",
                    "task-1",
                    "workflow-1",
                    "lane-implement",
                    "role",
                    "role-1",
                    "awaiting_user_approval",
                    "session-1",
                    "instance-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:01:00Z",
                ],
            )
            .expect("awaiting approval assignment insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'Awaiting approval session', 'task_assignment', 'active', 'active', ?3, ?3, 0, 'active', ?3, ?3)",
                rusqlite::params!["session-1", "/tmp/session-1.jsonl", "2026-03-21T00:00:00Z"],
            )
            .expect("canonical session row should insert");

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
            SessionDecorationSurface::Detail,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "active");
    }

    #[test]
    fn list_sessions_path_filters_dismissed_entries_and_preserves_awaiting_approval_sessions() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        let context = make_list_test_context(
            "orchestra-command-session-list",
            "command-session-list-test",
        );
        let session_path = write_list_test_session(
            &context,
            "2026-03-21T00-01-00Z_session-1.jsonl",
            "session-1",
            "Awaiting approval session",
            "2026-03-21T00:01:00Z",
        );
        let dismissed_path = write_list_test_session(
            &context,
            "2026-03-21T00-00-00Z_session-dismissed.jsonl",
            "session-dismissed",
            "Dismissed session",
            "2026-03-21T00:00:00Z",
        );
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-dismissed",
            None,
            None,
            &dismissed_path,
        )
        .expect("dismissed canonical session row should repair");
        dismiss_session_entry(&connection, "session-dismissed")
            .expect("dismissed entry should insert");

        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?10, NULL, NULL, NULL, 0, ?11, ?12)
                "#,
                rusqlite::params![
                    "task-1",
                    "project-1",
                    1,
                    "ORC-1",
                    "Awaiting approval task",
                    "task",
                    "in_review",
                    "P1",
                    "lane-implement",
                    "user",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("task insert should succeed");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id,
                    runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome,
                    completion_notes, started_at, completed_at, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, ?9, NULL, 'success', 'Ready', ?10, NULL, ?11, ?12)
                "#,
                rusqlite::params![
                    "assignment-1",
                    "task-1",
                    "workflow-1",
                    "lane-implement",
                    "role",
                    "role-1",
                    "awaiting_user_approval",
                    "session-1",
                    "instance-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:01:00Z",
                ],
            )
            .expect("awaiting approval assignment insert should succeed");
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-1",
            None,
            None,
            &session_path,
        )
        .expect("primary canonical session row should repair");
        let listed = list_command_sessions_with_connection(
            &connection,
            std::slice::from_ref(&context),
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("session list should succeed");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-1");
        assert_ne!(listed[0].status, "closed");
        assert_eq!(listed[0].task_id.as_deref(), Some("task-1"));
        assert_eq!(listed[0].task_number.as_deref(), Some("ORC-1"));
    }

    #[test]
    fn detail_surface_preserves_transcript_status_for_active_assignment_sessions() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?10, ?11, NULL, NULL, 0, ?12, ?13)
                "#,
                rusqlite::params![
                    "task-1",
                    "project-1",
                    1,
                    "ORC-1",
                    "In-flight task",
                    "task",
                    "in_progress",
                    "P1",
                    "lane-1",
                    "role",
                    "role-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("task insert should succeed");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id,
                    runtime_cwd, role_queue_entry_id, role_instance_id, prompt, started_at,
                    completed_at, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, ?9, NULL, ?10, ?11)
                "#,
                rusqlite::params![
                    "assignment-1",
                    "task-1",
                    "workflow-1",
                    "lane-1",
                    "role",
                    "role-1",
                    "active",
                    "session-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("assignment insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'In-flight session', 'task_assignment', 'active', 'active', ?3, ?3, 0, 'active', ?3, ?3)",
                rusqlite::params!["session-1", "/tmp/session-1.jsonl", "2026-03-21T00:00:00Z"],
            )
            .expect("canonical session row should insert");

        let mut record = make_session_record("session-1");
        record.status = "idle".into();
        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            record,
            false,
            SessionDecorationSurface::Detail,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "idle");
    }

    #[test]
    fn list_surface_marks_active_assignment_sessions_active() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?7, ?8, NULL, ?9, ?10, ?11, NULL, NULL, 0, ?12, ?13)
                "#,
                rusqlite::params![
                    "task-1",
                    "project-1",
                    1,
                    "ORC-1",
                    "In-flight task",
                    "task",
                    "in_progress",
                    "P1",
                    "lane-1",
                    "role",
                    "role-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("task insert should succeed");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id,
                    runtime_cwd, role_queue_entry_id, role_instance_id, prompt, started_at,
                    completed_at, created_at, updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, NULL, NULL, NULL, NULL, ?9, NULL, ?10, ?11)
                "#,
                rusqlite::params![
                    "assignment-1",
                    "task-1",
                    "workflow-1",
                    "lane-1",
                    "role",
                    "role-1",
                    "active",
                    "session-1",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:00:00Z",
                ],
            )
            .expect("assignment insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'In-flight session', 'task_assignment', 'idle', 'active', ?3, ?3, 0, 'active', ?3, ?3)",
                rusqlite::params!["session-1", "/tmp/session-1.jsonl", "2026-03-21T00:00:00Z"],
            )
            .expect("canonical session row should insert");

        let mut record = make_session_record("session-1");
        record.status = "idle".into();
        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            record,
            false,
            SessionDecorationSurface::List,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "active");
    }

    #[test]
    fn hidden_persistent_agent_sessions_remain_messageable_in_detail() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', 'off', '[]', 0, 0, 0, ?1, ?1)",
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("agent insert should succeed");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-1', 'agent-1', 'idle', 'session-agent-hidden', '/tmp/runtime', NULL, NULL, NULL, ?1, ?1)",
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("agent runtime insert should succeed");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, agent_id, worker_type, worker_id, owner_worker_type, owner_worker_id, first_seen_at, last_seen_at, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, NULL, ?2, ?2, 'Hidden agent session', 'agent_main', 'idle', 'active', 'agent-1', 'agent', 'agent-1', 'agent', 'agent-1', ?3, ?3, 0, 'active', ?3, ?3)",
                rusqlite::params!["session-agent-hidden", "/tmp/session-agent-hidden.jsonl", "2026-03-21T00:00:00Z"],
            )
            .expect("canonical agent session row should insert");
        dismiss_session_entry(&connection, "session-agent-hidden")
            .expect("hidden entry should insert");

        let mut record = make_session_record("session-agent-hidden");
        record.status = "idle".into();
        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            record,
            false,
            SessionDecorationSurface::Detail,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "idle");
        assert_eq!(
            decorated.list_visibility,
            Some(SessionListVisibilityState::Hidden)
        );
        assert_eq!(
            decorated.messageability,
            Some(SessionMessageability::Messageable)
        );
    }

    #[test]
    fn list_sessions_auto_hides_stale_role_sessions_without_task_history() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO roles (id, slug, name, archived, created_at, updated_at) VALUES ('role-1', 'reviewer', 'Reviewer', 0, ?1, ?1)",
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("role insert should succeed");
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-1', 'role-1', 'Reviewer 1', 'completed', NULL, 'session-stale-role', '/tmp/reviewer', NULL, NULL, ?1, ?1)",
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("role instance insert should succeed");

        let context = make_list_test_context(
            "orchestra-command-stale-role-session-list",
            "command-stale-role-session-list-test",
        );
        let session_path = write_list_test_session(
            &context,
            "2026-03-21T00-00-00Z_session-stale-role.jsonl",
            "session-stale-role",
            "Stale role session",
            "2026-03-21T00:00:00Z",
        );
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-stale-role",
            None,
            None,
            &session_path,
        )
        .expect("stale role canonical session row should repair");

        let listed = list_command_sessions_with_connection(
            &connection,
            std::slice::from_ref(&context),
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("session list should succeed");

        assert!(listed.is_empty());
        assert_eq!(
            session_list::load_hidden_session_reason(&connection, "session-stale-role")
                .expect("hidden reason should load")
                .as_deref(),
            Some(session_list::SESSION_HIDDEN_REASON_STALE_ROLE_SESSION)
        );
    }

    #[test]
    fn list_sessions_keeps_completed_task_sessions_visible_as_closed() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES ('task-1', 'project-1', 1, 'ORC-1', 'Completed task', NULL, 'task', 'completed', 'P1', NULL, NULL, 'unassigned', NULL, NULL, NULL, 0, ?1, ?1)
                "#,
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("task insert should succeed");
        connection
            .execute(
                "INSERT INTO task_lane_runs (id, task_id, lane_id, session_id, result, notes, started_at, completed_at) VALUES ('lane-run-1', 'task-1', 'lane-1', 'session-completed', 'success', NULL, ?1, ?2)",
                rusqlite::params!["2026-03-21T00:00:00Z", "2026-03-21T00:01:00Z"],
            )
            .expect("lane run insert should succeed");

        let context = make_list_test_context(
            "orchestra-command-completed-session-list",
            "command-completed-session-list-test",
        );
        let session_path = write_list_test_session(
            &context,
            "2026-03-21T00-00-00Z_session-completed.jsonl",
            "session-completed",
            "Completed task session",
            "2026-03-21T00:00:00Z",
        );
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-completed",
            None,
            None,
            &session_path,
        )
        .expect("completed canonical session row should repair");

        let listed = list_command_sessions_with_connection(
            &connection,
            std::slice::from_ref(&context),
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("session list should succeed");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-completed");
        assert_eq!(listed[0].status, "closed");
        assert_eq!(
            session_list::load_hidden_session_reason(&connection, "session-completed")
                .expect("hidden reason should load"),
            None
        );
    }

    #[test]
    fn resolve_session_create_title_prefers_explicit_title_and_defaults_agent_main_name() {
        let agent = make_agent_definition("Supervisor");

        assert_eq!(
            resolve_session_create_title(Some("Custom title"), Some(&agent)),
            Some("Custom title".to_string())
        );
        assert_eq!(
            resolve_session_create_title(Some("   "), Some(&agent)),
            Some("Supervisor main session".to_string())
        );
        assert_eq!(
            resolve_session_create_title(None, Some(&agent)),
            Some("Supervisor main session".to_string())
        );
        assert_eq!(resolve_session_create_title(None, None), None);
    }

    #[test]
    fn list_sessions_keeps_persistent_agent_main_sessions_visible_after_task_completion() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', 'off', '[]', 0, 0, 0, ?1, ?1)",
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("agent insert should succeed");
        connection
            .execute(
                r#"
                INSERT INTO tasks (
                    id, project_id, sequence_number, number, title, description, task_type, status,
                    priority, workflow_id, current_lane_id, assignee_type, assignee_id,
                    repository_id, parent_task_id, archived, created_at, updated_at
                )
                VALUES ('task-1', 'project-1', 1, 'ORC-1', 'Completed task', NULL, 'task', 'completed', 'P1', NULL, NULL, 'unassigned', NULL, NULL, NULL, 0, ?1, ?1)
                "#,
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("task insert should succeed");
        connection
            .execute(
                "INSERT INTO task_lane_runs (id, task_id, lane_id, session_id, result, notes, started_at, completed_at) VALUES ('lane-run-1', 'task-1', 'lane-1', 'session-agent-completed', 'success', NULL, ?1, ?2)",
                rusqlite::params!["2026-03-21T00:00:00Z", "2026-03-21T00:01:00Z"],
            )
            .expect("lane run insert should succeed");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-1', 'agent-1', 'idle', 'session-agent-completed', '/tmp/runtime', NULL, NULL, NULL, ?1, ?1)",
                rusqlite::params!["2026-03-21T00:00:00Z"],
            )
            .expect("agent runtime insert should succeed");

        let context = make_list_test_context(
            "orchestra-command-completed-agent-main-session-list",
            "command-completed-agent-main-session-list-test",
        );
        let session_path = write_list_test_session(
            &context,
            "2026-03-21T00-00-00Z_session-agent-completed.jsonl",
            "session-agent-completed",
            "Agent 1 main session",
            "2026-03-21T00:00:00Z",
        );
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-agent-completed",
            None,
            None,
            &session_path,
        )
        .expect("completed agent canonical session row should repair");
        connection
            .execute(
                "UPDATE sessions SET session_kind = 'agent_main', agent_id = 'agent-1', worker_type = 'agent', worker_id = 'agent-1', owner_worker_type = 'agent', owner_worker_id = 'agent-1' WHERE id = 'session-agent-completed'",
                [],
            )
            .expect("canonical session row should be marked as an agent main session");

        let listed = list_command_sessions_with_connection(
            &connection,
            std::slice::from_ref(&context),
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("session list should succeed");

        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, "session-agent-completed");
        assert_eq!(
            session_list::load_hidden_session_reason(&connection, "session-agent-completed")
                .expect("hidden reason should load"),
            None
        );
    }

    #[test]
    fn contextual_agent_main_successor_auto_archives_prior_main_session_from_lists() {
        let mut connection =
            rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'ORC', NULL, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("project insert should succeed");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'supervisor', 'Supervisor', 'off', '[]', 0, 0, 0, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("agent insert should succeed");

        let context = make_list_test_context(
            "orchestra-command-contextual-agent-main-successor",
            "project-1",
        );
        let runtime_cwd = context.project_root.display().to_string();
        let original = session_records::create_session_record(
            &connection,
            &context.project_root,
            &context.session_dir,
            session_records::CreateSessionRecordInput {
                project_id: Some("project-1"),
                title: Some("Supervisor main session"),
                session_kind: session_records::SESSION_KIND_AGENT_MAIN,
                agent_id: Some("agent-1"),
                role_instance_id: None,
                task_id: None,
                workflow_id: None,
                lane_id: None,
                assignment: None,
                worker_type: None,
                worker_id: None,
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: Some(session_records::AgentRuntimeBinding {
                    project_id: "project-1",
                    agent_id: "agent-1",
                    runtime_cwd: Some(runtime_cwd.as_str()),
                    current_queue_entry_id: None,
                    status: "idle",
                    last_error: None,
                }),
                update_role_instance_session: false,
            },
        )
        .expect("original agent main session should be created");

        connection
            .execute(
                "INSERT OR REPLACE INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES (?1, ?2, 'idle', ?3, ?4, NULL, NULL, NULL, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                rusqlite::params!["project-1", "agent-1", original.record.id.as_str(), runtime_cwd.as_str()],
            )
            .expect("agent runtime row should insert");
        let runtime_state = crate::models::AgentRuntimeState {
            project_id: "project-1".to_string(),
            agent_id: "agent-1".to_string(),
            status: "idle".to_string(),
            main_session_id: Some(original.record.id.clone()),
            runtime_cwd: Some(runtime_cwd.clone()),
            current_queue_entry_id: None,
            last_dispatch_at: None,
            last_error: None,
            terminal_attached: false,
            created_at: "2026-03-21T00:00:00Z".to_string(),
            updated_at: "2026-03-21T00:00:00Z".to_string(),
        };
        let agent = agents::get_agent(&connection, "agent-1").expect("agent lookup should succeed");
        let successor = create_contextual_agent_main_successor(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &original.record.id,
            "Supervisor main session",
            "project-1",
            &agent,
            &runtime_state,
        )
        .expect("contextual agent main successor should be created");
        update_agent_main_session_for_created_session(
            &connection,
            Some("project-1"),
            "agent-1",
            &successor.record.id,
        )
        .expect("agent runtime state should point at the successor main session");

        let listed = list_command_sessions_with_connection(
            &connection,
            std::slice::from_ref(&context),
            &HashSet::new(),
            &HashSet::new(),
        )
        .expect("session list should succeed");
        let supervisor_sessions = listed
            .iter()
            .filter(|session| session.title == "Supervisor main session")
            .collect::<Vec<_>>();

        assert_eq!(supervisor_sessions.len(), 1);
        assert!(!listed
            .iter()
            .any(|session| session.id == original.record.id));
        assert!(listed
            .iter()
            .any(|session| session.id == successor.record.id));
        let original_row = session_records::load_session_row(&connection, &original.record.id)
            .expect("original row lookup should succeed")
            .expect("original row should exist");
        assert_eq!(
            original_row.lifecycle_state,
            session_records::LIFECYCLE_SUPERSEDED
        );
        let archived_at = connection
            .query_row(
                "SELECT archived_at FROM sessions WHERE id = ?1",
                [&original.record.id],
                |row| row.get::<_, Option<String>>(0),
            )
            .expect("archived_at should query");
        assert!(archived_at.is_some());
        assert_eq!(
            session_list::load_hidden_session_reason(&connection, &original.record.id)
                .expect("hidden reason should load"),
            Some(session_list::SESSION_HIDDEN_REASON_SUPERSEDED.to_string())
        );
    }

    #[test]
    fn get_session_detail_prefers_transcript_title_and_status_over_stale_canonical_row_fields() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        let context = make_list_test_context(
            "orchestra-command-session-detail-hydration",
            "command-session-detail-hydration-test",
        );
        let session_path = context
            .session_dir
            .join("2026-03-21T00-00-00Z_session-detail.jsonl");
        let content = format!(
            "{}\n{}\n{}\n",
            serde_json::json!({
                "type": "session",
                "version": 3,
                "id": "session-detail",
                "timestamp": "2026-03-21T00:00:00Z",
                "cwd": context.project_root.display().to_string(),
            }),
            serde_json::json!({
                "type": "message",
                "id": "msg-user",
                "timestamp": "2026-03-21T00:00:01Z",
                "message": {
                    "role": "user",
                    "content": [{ "type": "text", "text": "Name this session from the first user message" }],
                    "timestamp": 1773835261000i64,
                }
            }),
            serde_json::json!({
                "type": "message",
                "id": "msg-assistant",
                "timestamp": "2026-03-21T00:00:02Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Done" }],
                    "timestamp": 1773835262000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");
        session_records::repair_session_row_from_transcript_path(
            &connection,
            "session-detail",
            None,
            None,
            &session_path,
        )
        .expect("canonical session row should repair");
        connection
            .execute(
                "UPDATE sessions SET title = '', session_status = 'closed', updated_at = '2026-03-21T00:00:00Z' WHERE id = 'session-detail'",
                [],
            )
            .expect("canonical session row should be made stale for detail hydration");

        let record = crate::services::pi_sessions::get_session(
            &context.session_dir,
            "session-detail",
            false,
        )
        .expect("session detail should load");

        assert_eq!(
            record.title,
            "Name this session from the first user message"
        );
        assert_eq!(record.status, "idle");
        assert_eq!(record.updated_at, "2026-03-21T00:00:02+00:00");
    }
}
