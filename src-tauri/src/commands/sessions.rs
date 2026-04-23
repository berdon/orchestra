use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::{Duration, Utc};
use rusqlite::{params, OptionalExtension};
use serde_json::json;
use tauri::{async_runtime::spawn_blocking, AppHandle, State};

use crate::{
    models::{
        QueuedSessionMessage, SessionDebugInfo, SessionModelState, SessionRecord,
        SessionRuntimeDetails, SessionStats,
    },
    services::{
        agent_runtime, agents, app_events, database, domain_events,
        live_sessions::{
            ensure_runtime, get_session_control_snapshot, is_unknown_command_error,
            maybe_auto_compact, maybe_runtime, perform_session_compaction, perform_session_reload,
        },
        pi_sessions::{
            all_session_contexts, create_session_file, delete_session_file, detect_session_context,
            find_session_context_for_session, get_session, get_session_header_cwd,
            get_session_stats as load_session_stats_from_file, list_sessions as list_real_sessions,
            session_context_for_project_id, set_session_model as apply_session_model,
        },
        pi_setup, role_dispatch, role_runtime, roles, task_runtime,
    },
    state::AppState,
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

struct ContextualSessionCreation {
    project_root: PathBuf,
    session_dir: PathBuf,
    new_session_id: String,
    rotated_from_session_id: Option<String>,
    affected_task_id: Option<String>,
    project_id: Option<String>,
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

fn decorate_session_record_with_connection(
    connection: &rusqlite::Connection,
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    mut record: SessionRecord,
    include_debug_info: bool,
) -> Result<SessionRecord, String> {
    if include_debug_info {
        record.debug_info = load_session_debug_info(connection, &record.id)?;
    }
    record.terminal_attached = terminal_attached_session_ids.contains(record.id.as_str());
    let (
        task_id,
        task_project_id,
        task_number,
        task_title,
        active_task_id,
        active_task_project_id,
        active_task_number,
        active_task_title,
        worker_type,
        worker_name,
    ) = load_session_list_metadata(connection, &record.id)?;
    record.task_id = task_id;
    record.task_project_id = task_project_id;
    record.task_number = task_number;
    record.task_title = task_title;
    record.active_task_id = active_task_id;
    record.active_task_project_id = active_task_project_id;
    record.active_task_number = active_task_number;
    record.active_task_title = active_task_title;
    record.worker_type = worker_type;
    record.worker_name = worker_name;

    let is_persistent_agent_session = connection
        .query_row(
            "SELECT 1 FROM agent_runtime_states WHERE main_session_id = ?1 LIMIT 1",
            [record.id.as_str()],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to query agent runtime session {}: {error}",
                record.id
            )
        })?
        .is_some();

    if !is_persistent_agent_session
        && task_runtime::get_active_assignment_for_session(connection, &record.id)?.is_none()
    {
        let latest_assignment_status = connection
            .query_row(
                r#"
                SELECT status
                FROM task_lane_assignments
                WHERE session_id = ?1
                ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
                LIMIT 1
                "#,
                [record.id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to query latest session assignment status {}: {error}",
                    record.id
                )
            })?;

        let task_status = connection
            .query_row(
                r#"
                SELECT t.status
                FROM task_lane_runs lr
                JOIN tasks t ON t.id = lr.task_id
                WHERE lr.session_id = ?1
                ORDER BY COALESCE(lr.completed_at, lr.started_at) DESC, lr.id DESC
                LIMIT 1
                "#,
                [record.id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!("Unable to query session task status {}: {error}", record.id)
            })?;

        if matches!(
            latest_assignment_status.as_deref(),
            Some("completed") | Some("failed") | Some("canceled")
        ) || matches!(task_status.as_deref(), Some("completed") | Some("canceled"))
        {
            record.status = "closed".into();
        }
    }

    Ok(record)
}

fn decorate_session_record(
    terminal_attached_session_ids: &std::collections::HashSet<String>,
    record: SessionRecord,
    include_debug_info: bool,
) -> Result<SessionRecord, String> {
    let connection = database::open_connection()?;
    decorate_session_record_with_connection(
        &connection,
        terminal_attached_session_ids,
        record,
        include_debug_info,
    )
}

fn load_decorated_session_record(
    session_dir: &std::path::Path,
    session_id: &str,
    subscribed: bool,
    terminal_attached_session_ids: &std::collections::HashSet<String>,
) -> Result<SessionRecord, String> {
    let record = get_session(session_dir, session_id, subscribed)?;
    decorate_session_record(terminal_attached_session_ids, record, true)
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

const DISMISSED_SESSION_RETENTION_DAYS: i64 = 7;

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

fn load_dismissed_session_ids(
    connection: &rusqlite::Connection,
) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare("SELECT session_id FROM session_list_entries WHERE dismissed_at IS NOT NULL")
        .map_err(|error| format!("Unable to prepare dismissed session query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query dismissed sessions: {error}"))?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to read dismissed sessions: {error}"))
}

fn dismiss_session_entry(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    let now = crate::state::now_iso();
    connection
        .execute(
            r#"
            INSERT INTO session_list_entries (session_id, dismissed_at, created_at, updated_at)
            VALUES (?1, ?2, ?2, ?2)
            ON CONFLICT(session_id) DO UPDATE SET dismissed_at = excluded.dismissed_at, updated_at = excluded.updated_at
            "#,
            params![session_id, now],
        )
        .map_err(|error| format!("Unable to dismiss session {session_id}: {error}"))?;
    Ok(())
}

fn restore_session_entry(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM session_list_entries WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| format!("Unable to restore dismissed session {session_id}: {error}"))?;
    Ok(())
}

fn cleanup_dismissed_sessions(connection: &rusqlite::Connection) -> Result<Vec<String>, String> {
    let cutoff = (Utc::now() - Duration::days(DISMISSED_SESSION_RETENTION_DAYS)).to_rfc3339();
    let mut statement = connection
        .prepare("SELECT session_id FROM session_list_entries WHERE dismissed_at IS NOT NULL AND dismissed_at <= ?1")
        .map_err(|error| format!("Unable to prepare dismissed session cleanup query: {error}"))?;
    let rows = statement
        .query_map([cutoff], |row| row.get::<_, String>(0))
        .map_err(|error| {
            format!("Unable to query dismissed session cleanup candidates: {error}")
        })?;
    let session_ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read dismissed session cleanup candidates: {error}"))?;

    for session_id in &session_ids {
        if let Ok(context) = find_session_context_for_session(session_id) {
            let _ = delete_session_file(&context.session_dir, session_id);
        }
        let _ = restore_session_entry(connection, session_id);
    }

    Ok(session_ids)
}

#[tauri::command]
pub async fn list_sessions(
    state: State<'_, AppState>,
    project_id: Option<String>,
) -> Result<Vec<SessionRecord>, String> {
    let subscribed = state.subscribed_session_ids()?;
    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let sessions = spawn_blocking(move || {
        let connection = database::open_connection()?;
        cleanup_dismissed_sessions(&connection)?;
        let dismissed_ids = load_dismissed_session_ids(&connection)?;
        let session_dirs = match project_id.as_deref() {
            Some(project_id) => vec![session_context_for_project_id(project_id)?.session_dir],
            None => all_session_contexts()?
                .into_iter()
                .map(|context| context.session_dir)
                .collect(),
        };
        drop(connection);

        let mut sessions = session_dirs
            .into_iter()
            .map(|session_dir| list_real_sessions(&session_dir, &subscribed))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .filter(|record| !dismissed_ids.contains(&record.id))
            .map(|record| decorate_session_record(&terminal_attached_session_ids, record, false))
            .collect::<Result<Vec<_>, _>>()?;
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok::<_, String>(sessions)
    })
    .await
    .map_err(|error| format!("Unable to join list_sessions task: {error}"))??;

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
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        let context = find_session_context_for_session(&session_id_for_task)?;
        load_decorated_session_record(
            &context.session_dir,
            &session_id_for_task,
            subscribed,
            &terminal_attached_session_ids,
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
) -> Result<SessionRecord, String> {
    state
        .sync_pi_runtime_health()
        .map_err(|error| format!("Unable to create session because PI is unavailable: {error}"))?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to create session because Pi setup is incomplete: {error}")
    })?;
    let title_for_task = title.clone();
    let project_slug_for_task = project_slug.clone();
    let (project_root, session_dir, created) = spawn_blocking(move || {
        let context = detect_session_context(project_slug_for_task.as_deref())?;
        let created = create_session_file(
            &context.project_root,
            &context.session_dir,
            title_for_task.as_deref(),
            true,
        )?;
        Ok::<_, String>((context.project_root, context.session_dir, created))
    })
    .await
    .map_err(|error| format!("Unable to join create_session task: {error}"))??;

    state.set_session_subscription(&created.record.id, true)?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        project_root,
        session_dir.clone(),
        &created.record.id,
    )?;
    state.log(
        "info",
        "sessions.create",
        &format!(
            "Created real pi session {} at {}",
            created.record.id,
            created.path.display()
        ),
    );
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
            project_id,
            json!({
                "sessionId": created.record.id.clone(),
                "title": created.record.title.clone(),
            }),
        );
    }
    let _ = app_events::emit_session_change(&app, "sessions.create", [created.record.id.clone()]);

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let decorated_record = spawn_blocking(move || {
        load_decorated_session_record(
            &session_dir,
            &created.record.id,
            true,
            &terminal_attached_session_ids,
        )
    })
    .await
    .map_err(|error| format!("Unable to join create_session record task: {error}"))??;

    attach_session_control_metadata(state.inner(), decorated_record)
}

#[tauri::command]
pub async fn create_contextual_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    project_slug: Option<String>,
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

    let session_id_for_task = session_id.clone();
    let project_slug_for_task = project_slug.clone();
    let prepared = spawn_blocking(move || {
        let mut connection = database::open_connection()?;
        let old_context = find_session_context_for_session(&session_id_for_task)?;
        let old_record = get_session(&old_context.session_dir, &session_id_for_task, false)?;
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
            let created = create_session_file(
                &runtime_root,
                &old_context.session_dir,
                Some(old_record.title.as_str()),
                false,
            )?;

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
                    task_runtime::apply_agent_session_defaults(
                        &runtime_root,
                        &old_context.session_dir,
                        &created.record.id,
                        &agent,
                    )?;

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
                    let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                        &tx,
                        &task.project_id,
                        agent_id,
                        Some(&created.record.id),
                        Some(runtime_cwd.as_str()),
                        runtime_state.current_queue_entry_id.as_deref(),
                        &runtime_state.status,
                        runtime_state.last_error.as_deref(),
                    )?;
                    task_runtime::rotate_open_assignment_session(
                        &tx,
                        &assignment,
                        &created.record.id,
                        &now,
                    )?;
                    tx.commit().map_err(|error| {
                        format!(
                            "Unable to commit contextual agent session rotation for task {}: {error}",
                            assignment.task_id
                        )
                    })?;
                    Ok::<_, String>(task.project_id)
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
                    role_dispatch::apply_role_session_defaults(
                        &runtime_root,
                        &old_context.session_dir,
                        &created.record.id,
                        &role,
                    )?;

                    let task = crate::services::tasks::get_task_context(
                        &connection,
                        &assignment.task_id,
                    )?;
                    let tx = connection.transaction().map_err(|error| {
                        format!(
                            "Unable to start contextual role session rotation transaction: {error}"
                        )
                    })?;
                    tx.execute(
                        "UPDATE role_instances SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
                        params![role_instance.id, created.record.id, now],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to rotate role instance session {}: {error}",
                            role_instance.id
                        )
                    })?;
                    task_runtime::rotate_open_assignment_session(
                        &tx,
                        &assignment,
                        &created.record.id,
                        &now,
                    )?;
                    tx.commit().map_err(|error| {
                        format!(
                            "Unable to commit contextual role session rotation for task {}: {error}",
                            assignment.task_id
                        )
                    })?;
                    Ok::<_, String>(task.project_id)
                }
                other => Err(format!(
                    "Unsupported assignment worker type {other} for session rotation"
                )),
            };

            let project_id = match assignment_result {
                Ok(project_id) => project_id,
                Err(error) => {
                    let _ = delete_session_file(&old_context.session_dir, &created.record.id);
                    return Err(error);
                }
            };

            return Ok::<_, String>(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: created.record.id,
                rotated_from_session_id: Some(session_id_for_task),
                affected_task_id: Some(assignment.task_id),
                project_id: Some(project_id),
            });
        }

        let scoped_project_id = project_slug_for_task
            .as_deref()
            .and_then(|slug| project_id_for_slug(&connection, slug))
            .or_else(|| project_id_for_slug(&connection, &old_context.project_slug));
        let agent_runtime_row = if let Some(project_id) = scoped_project_id.as_deref() {
            connection
                .query_row(
                    r#"
                    SELECT project_id, agent_id
                    FROM agent_runtime_states
                    WHERE main_session_id = ?1 AND project_id = ?2
                    LIMIT 1
                    "#,
                    params![session_id_for_task.as_str(), project_id],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to resolve scoped agent runtime for session {}: {error}",
                        session_id_for_task
                    )
                })?
        } else {
            connection
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
                })?
        };

        if let Some((project_id, agent_id)) = agent_runtime_row {
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
            let created = create_session_file(
                &runtime_root,
                &old_context.session_dir,
                Some(old_record.title.as_str()),
                false,
            )?;
            let runtime_cwd = runtime_state
                .runtime_cwd
                .clone()
                .unwrap_or_else(|| runtime_root.display().to_string());
            let update_result = (|| {
                task_runtime::apply_agent_session_defaults(
                    &runtime_root,
                    &old_context.session_dir,
                    &created.record.id,
                    &agent,
                )?;
                let tx = connection.transaction().map_err(|error| {
                    format!(
                        "Unable to start contextual agent main-session rotation transaction: {error}"
                    )
                })?;
                let _ = agent_runtime::update_agent_runtime_dispatch_state_for_project(
                    &tx,
                    &project_id,
                    &agent_id,
                    Some(&created.record.id),
                    Some(runtime_cwd.as_str()),
                    runtime_state.current_queue_entry_id.as_deref(),
                    &runtime_state.status,
                    runtime_state.last_error.as_deref(),
                )?;
                tx.commit().map_err(|error| {
                    format!(
                        "Unable to commit contextual agent main-session rotation for project {}: {error}",
                        project_id
                    )
                })?;
                Ok::<_, String>(())
            })();
            if let Err(error) = update_result {
                let _ = delete_session_file(&old_context.session_dir, &created.record.id);
                return Err(error);
            }

            return Ok(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: created.record.id,
                rotated_from_session_id: Some(session_id_for_task),
                affected_task_id: None,
                project_id: Some(project_id),
            });
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
            let created = create_session_file(
                &runtime_root,
                &old_context.session_dir,
                Some(old_record.title.as_str()),
                false,
            )?;
            let role_project_id = session_project_id(&connection, &session_id_for_task);
            let update_result = (|| {
                role_dispatch::apply_role_session_defaults(
                    &runtime_root,
                    &old_context.session_dir,
                    &created.record.id,
                    &role,
                )?;
                let tx = connection.transaction().map_err(|error| {
                    format!(
                        "Unable to start contextual role-session rotation transaction: {error}"
                    )
                })?;
                tx.execute(
                    "UPDATE role_instances SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![role_instance_id, created.record.id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to update role instance {} to the rotated session: {error}",
                        role_instance_id
                    )
                })?;
                tx.commit().map_err(|error| {
                    format!(
                        "Unable to commit contextual role-session rotation for instance {}: {error}",
                        role_instance_id
                    )
                })?;
                Ok::<_, String>(())
            })();
            if let Err(error) = update_result {
                let _ = delete_session_file(&old_context.session_dir, &created.record.id);
                return Err(error);
            }

            let prior_session_id = session_id_for_task.clone();
            return Ok(ContextualSessionCreation {
                project_root: runtime_root,
                session_dir: old_context.session_dir,
                new_session_id: created.record.id,
                rotated_from_session_id: Some(prior_session_id),
                affected_task_id: None,
                project_id: role_project_id,
            });
        }

        let context = if let Some(project_slug) = project_slug_for_task.as_deref() {
            detect_session_context(Some(project_slug))?
        } else {
            old_context
        };
        let created = create_session_file(
            &context.project_root,
            &context.session_dir,
            None,
            false,
        )?;

        Ok(ContextualSessionCreation {
            project_root: context.project_root,
            session_dir: context.session_dir,
            new_session_id: created.record.id,
            rotated_from_session_id: None,
            affected_task_id: None,
            project_id: project_id_for_slug(&connection, &context.project_slug),
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

    state.set_session_subscription(&prepared.new_session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        prepared.project_root,
        prepared.session_dir.clone(),
        &prepared.new_session_id,
    )?;
    runtime.set_subscribed(true);

    let project_id = prepared.project_id.clone();
    let rotated_from_session_id = prepared.rotated_from_session_id.clone();
    let affected_task_id = prepared.affected_task_id.clone();
    let session_dir = prepared.session_dir.clone();
    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let new_session_id_for_task = prepared.new_session_id.clone();
    let decorated_record = spawn_blocking(move || {
        load_decorated_session_record(
            &session_dir,
            &new_session_id_for_task,
            true,
            &terminal_attached_session_ids,
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
    if let Ok(connection) = database::open_connection() {
        record_session_domain_event(
            &connection,
            &decorated_record.id,
            "session.created",
            project_id,
            json!({
                "sessionId": decorated_record.id.clone(),
                "title": decorated_record.title.clone(),
                "replacedSessionId": rotated_from_session_id.clone(),
            }),
        );
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
    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        load_decorated_session_record(
            &session_dir,
            &session_id_for_task,
            true,
            &terminal_attached_session_ids,
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
        let session_id_for_task = session_id.clone();
        let record = spawn_blocking(move || {
            load_decorated_session_record(
                &session_dir,
                &session_id_for_task,
                true,
                &terminal_attached_session_ids,
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
            "Changed session {} to {}/{}",
            session_id, provider, model_id
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
    let had_runtime = if let Some(runtime) = state.remove_session_runtime(&session_id)? {
        runtime.abort_active_run();
        true
    } else {
        false
    };
    state.clear_active_session_run(&session_id)?;

    let terminal_attached_session_ids = state.terminal_attached_session_ids()?;
    let session_id_for_task = session_id.clone();
    let mut record = spawn_blocking(move || {
        let (_, session_dir) = resolve_session_paths(&session_id_for_task)?;
        load_decorated_session_record(
            &session_dir,
            &session_id_for_task,
            true,
            &terminal_attached_session_ids,
        )
    })
    .await
    .map_err(|error| format!("Unable to join stop_session_runtime task: {error}"))??;

    if had_runtime {
        record.status = "paused".into();
    }

    state.log(
        "info",
        "sessions.stop",
        &format!("Stopped session runtime {}", session_id),
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

#[tauri::command]
pub async fn send_session_message(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    message: String,
    run_id: String,
) -> Result<QueuedSessionMessage, String> {
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

    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) =
        spawn_blocking(move || resolve_session_paths(&session_id_for_task))
            .await
            .map_err(|error| {
                format!("Unable to join send_session_message context task: {error}")
            })??;

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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::SessionEvent, services::database};

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
            control_capabilities: None,
            control_operation: None,
        }
    }

    #[test]
    fn decorates_completed_task_sessions_as_closed() {
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
                    "session-1",
                    "success",
                    "2026-03-21T00:00:00Z",
                    "2026-03-21T00:01:00Z",
                ],
            )
            .expect("lane run insert should succeed");

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "closed");
    }

    #[test]
    fn dismiss_and_restore_session_entries_round_trip() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        dismiss_session_entry(&connection, "session-1").expect("dismiss should succeed");
        let dismissed = load_dismissed_session_ids(&connection).expect("dismissed ids should load");
        assert!(dismissed.contains("session-1"));

        restore_session_entry(&connection, "session-1").expect("restore should succeed");
        let dismissed_after =
            load_dismissed_session_ids(&connection).expect("dismissed ids should reload");
        assert!(!dismissed_after.contains("session-1"));
    }

    #[test]
    fn cleanup_stale_dismissed_sessions_removes_old_entries() {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection.execute(
            "INSERT INTO session_list_entries (session_id, dismissed_at, created_at, updated_at) VALUES (?1, ?2, ?2, ?2)",
            rusqlite::params!["stale-session", "2000-01-01T00:00:00Z"],
        ).expect("stale dismiss entry should insert");

        let cleaned = cleanup_dismissed_sessions(&connection).expect("cleanup should succeed");
        assert_eq!(cleaned, vec!["stale-session".to_string()]);
        let dismissed_after =
            load_dismissed_session_ids(&connection).expect("dismissed ids should reload");
        assert!(dismissed_after.is_empty());
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

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
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

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "active");
    }

    #[test]
    fn keeps_active_assignment_sessions_open() {
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

        let decorated = decorate_session_record_with_connection(
            &connection,
            &std::collections::HashSet::new(),
            make_session_record("session-1"),
            false,
        )
        .expect("session decoration should succeed");

        assert_eq!(decorated.status, "active");
    }
}
