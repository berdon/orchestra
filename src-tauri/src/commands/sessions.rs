use std::path::PathBuf;

use rusqlite::OptionalExtension;
use tauri::{async_runtime::spawn_blocking, AppHandle, State};

use crate::{
    models::{QueuedSessionMessage, SessionDebugInfo, SessionModelState, SessionRecord},
    services::{
        app_events, database,
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions::{
            all_session_contexts, create_session_file, delete_session_file, detect_session_context,
            find_session_context_for_session, get_session, get_session_header_cwd,
            list_sessions as list_real_sessions, set_session_model as apply_session_model,
        },
        task_runtime,
    },
    state::AppState,
};

fn load_session_debug_info(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionDebugInfo>, String> {
    let task_assignment = connection
        .query_row(
            r#"
            SELECT tla.runtime_cwd, r.local_path, p.slug
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
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
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

    if let Some((runtime_cwd, managed_repository_path, project_slug)) = task_assignment {
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
            managed_repository_path: managed_repository_path.clone(),
            worktree_path: runtime_cwd.clone(),
            session_cwd: runtime_cwd,
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
            |row| Ok((row.get::<_, Option<String>>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to load agent session debug info {session_id}: {error}"))?;

    if let Some((runtime_cwd, project_slug)) = agent_runtime {
        let project_root = project_slug.and_then(|slug| {
            crate::services::orchestra_paths::default_orchestra_root()
                .ok()
                .map(|root| crate::services::orchestra_paths::project_root(&root, &slug).display().to_string())
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

fn decorate_session_record_with_connection(
    connection: &rusqlite::Connection,
    mut record: SessionRecord,
) -> Result<SessionRecord, String> {
    record.debug_info = load_session_debug_info(connection, &record.id)?;

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

        if matches!(task_status.as_deref(), Some("completed") | Some("canceled")) {
            record.status = "closed".into();
        }
    }

    Ok(record)
}

fn decorate_session_record(record: SessionRecord) -> Result<SessionRecord, String> {
    let connection = database::open_connection()?;
    decorate_session_record_with_connection(&connection, record)
}

fn load_decorated_session_record(
    session_dir: &std::path::Path,
    session_id: &str,
    subscribed: bool,
) -> Result<SessionRecord, String> {
    let record = get_session(session_dir, session_id, subscribed)?;
    decorate_session_record(record)
}

fn resolve_session_runtime_root(
    connection: &rusqlite::Connection,
    session_id: &str,
    storage_project_root: &std::path::Path,
    session_dir: &std::path::Path,
) -> Result<PathBuf, String> {
    if let Some(debug_info) = load_session_debug_info(connection, session_id)? {
        if let Some(session_cwd) = debug_info.session_cwd {
            return Ok(PathBuf::from(session_cwd));
        }
        if let Some(project_root) = debug_info.project_root {
            return Ok(PathBuf::from(project_root));
        }
    }

    if let Some(header_cwd) = get_session_header_cwd(session_dir, session_id)? {
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

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionRecord>, String> {
    let subscribed = state.subscribed_session_ids()?;
    spawn_blocking(move || {
        let mut sessions = all_session_contexts()?
            .into_iter()
            .map(|context| list_real_sessions(&context.session_dir, &subscribed))
            .collect::<Result<Vec<_>, _>>()?
            .into_iter()
            .flatten()
            .map(decorate_session_record)
            .collect::<Result<Vec<_>, _>>()?;
        sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
        Ok::<_, String>(sessions)
    })
    .await
    .map_err(|error| format!("Unable to join list_sessions task: {error}"))?
}

#[tauri::command]
pub async fn get_session_record(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let subscribed = state.subscribed_session_ids()?.contains(&session_id);
    let session_id_for_task = session_id.clone();
    spawn_blocking(move || {
        let context = find_session_context_for_session(&session_id_for_task)?;
        load_decorated_session_record(&context.session_dir, &session_id_for_task, subscribed)
    })
    .await
    .map_err(|error| format!("Unable to join get_session_record task: {error}"))?
}

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
) -> Result<SessionRecord, String> {
    let title_for_task = title.clone();
    let (project_root, session_dir, created) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
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
    let _ = app_events::emit_session_change(&app, "sessions.create", [created.record.id.clone()]);

    let decorated_record = spawn_blocking(move || {
        load_decorated_session_record(&session_dir, &created.record.id, true)
    })
    .await
    .map_err(|error| format!("Unable to join create_session record task: {error}"))??;

    Ok(decorated_record)
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
        let (_, session_dir) = resolve_session_paths(&session_id_for_task)?;
        delete_session_file(&session_dir, &session_id_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join delete_session task: {error}"))??;
    state.log(
        "info",
        "sessions.delete",
        &format!("Deleted pi session {}", session_id),
    );
    let _ = app_events::emit_session_change(&app, "sessions.delete", [session_id]);
    Ok(())
}

#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = spawn_blocking(move || resolve_session_paths(&session_id_for_task))
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

    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        load_decorated_session_record(&session_dir, &session_id_for_task, true)
    })
    .await
    .map_err(|error| format!("Unable to join resume_session record task: {error}"))??;
    state.log(
        "info",
        "sessions.resume",
        &format!("Resumed pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub async fn subscribe_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = spawn_blocking(move || resolve_session_paths(&session_id_for_task))
    .await
    .map_err(|error| format!("Unable to join subscribe_session context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir.clone(),
        &session_id,
    )?;
    runtime.set_subscribed(true);

    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        load_decorated_session_record(&session_dir, &session_id_for_task, true)
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

#[tauri::command]
pub async fn unsubscribe_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    state.set_session_subscription(&session_id, false)?;
    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(false);
    }

    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        let (_, session_dir) = resolve_session_paths(&session_id_for_task)?;
        load_decorated_session_record(&session_dir, &session_id_for_task, false)
    })
    .await
    .map_err(|error| format!("Unable to join unsubscribe_session task: {error}"))??;
    state.log(
        "info",
        "sessions.unsubscribe",
        &format!("Unsubscribed from pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub async fn get_session_model_state(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionModelState, String> {
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = spawn_blocking(move || resolve_session_paths(&session_id_for_task))
    .await
    .map_err(|error| format!("Unable to join get_session_model_state context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;

    let runtime = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(true);
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
        .map_err(|error| format!("Unable to join get_session_model_state runtime task: {error}"))?
}

#[tauri::command]
pub async fn set_session_model(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<SessionModelState, String> {
    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = spawn_blocking(move || resolve_session_paths(&session_id_for_task))
    .await
    .map_err(|error| format!("Unable to join set_session_model context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;

    let result = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(true);
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
        let result = spawn_blocking(move || {
            apply_session_model(
                &project_root_for_task,
                &session_dir_for_task,
                &session_id_for_task,
                &provider_for_task,
                &model_id_for_task,
            )
        })
        .await
        .map_err(|error| format!("Unable to join set_session_model file task: {error}"))??;
        let _ = ensure_runtime(
            &state.session_runtimes,
            app,
            project_root,
            session_dir,
            &session_id,
        )?;
        result
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

    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = spawn_blocking(move || resolve_session_paths(&session_id_for_task))
    .await
    .map_err(|error| format!("Unable to join send_session_message context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir,
        &session_id,
    )?;
    runtime.set_subscribed(true);

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
            }],
            debug_info: None,
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

        let decorated =
            decorate_session_record_with_connection(&connection, make_session_record("session-1"))
                .expect("session decoration should succeed");

        assert_eq!(decorated.status, "closed");
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

        let decorated =
            decorate_session_record_with_connection(&connection, make_session_record("session-1"))
                .expect("session decoration should succeed");

        assert_eq!(decorated.status, "active");
    }
}
