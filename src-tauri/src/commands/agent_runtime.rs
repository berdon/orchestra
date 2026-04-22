use std::path::PathBuf;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{
    models::{
        AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput,
        SessionRecord,
    },
    services::{
        agent_dispatch, agent_runtime, agent_terminal, app_events, database,
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions::{find_session_context_for_session, get_session, get_session_path},
    },
    state::AppState,
};

fn decorate_runtime_state(
    state: &AppState,
    mut detail: AgentOperationsDetail,
) -> Result<AgentOperationsDetail, String> {
    detail.runtime_state.terminal_attached = detail
        .runtime_state
        .main_session_id
        .as_deref()
        .map(|session_id| state.get_terminal_window_label(session_id))
        .transpose()?
        .flatten()
        .is_some();
    Ok(detail)
}

fn decorate_snapshot(
    state: &AppState,
    mut snapshot: AgentOperationsSnapshot,
) -> Result<AgentOperationsSnapshot, String> {
    snapshot.runtime_state.terminal_attached = snapshot
        .runtime_state
        .main_session_id
        .as_deref()
        .map(|session_id| state.get_terminal_window_label(session_id))
        .transpose()?
        .flatten()
        .is_some();
    Ok(snapshot)
}

#[tauri::command]
pub fn list_agent_operations(
    state: State<'_, AppState>,
    include_archived: Option<bool>,
    project_id: Option<String>,
) -> Result<Vec<AgentOperationsSnapshot>, String> {
    let connection = database::open_connection()?;
    let snapshots = match project_id.as_deref() {
        Some(project_id) => agent_runtime::list_agent_operations_for_project(
            &connection,
            project_id,
            include_archived.unwrap_or(false),
        ),
        None => {
            agent_runtime::list_agent_operations(&connection, include_archived.unwrap_or(false))
        }
    }?;
    snapshots
        .into_iter()
        .map(|snapshot| decorate_snapshot(&state, snapshot))
        .collect()
}

#[tauri::command]
pub fn get_agent_operations(
    state: State<'_, AppState>,
    agent_id: String,
    project_id: Option<String>,
) -> Result<AgentOperationsDetail, String> {
    let connection = database::open_connection()?;
    let detail = match project_id.as_deref() {
        Some(project_id) => {
            agent_runtime::get_agent_operations_for_project(&connection, project_id, &agent_id)
        }
        None => agent_runtime::get_agent_operations(&connection, &agent_id),
    }?;
    decorate_runtime_state(&state, detail)
}

#[tauri::command]
pub fn enqueue_agent_work(
    state: State<'_, AppState>,
    input: AgentQueueEntryInput,
) -> Result<AgentQueueEntry, String> {
    let connection = database::open_connection()?;
    let entry = agent_runtime::enqueue_agent_work(&connection, input)?;
    state.log(
        "info",
        "agent.queue.updated",
        &format!("Queued agent work {}", entry.id),
    );
    Ok(entry)
}

#[tauri::command]
pub fn delete_agent_queue_entry(
    state: State<'_, AppState>,
    queue_entry_id: String,
) -> Result<AgentQueueEntry, String> {
    let connection = database::open_connection()?;
    let entry = agent_runtime::delete_agent_queue_entry(&connection, &queue_entry_id)?;
    state.log(
        "info",
        "agent.queue.updated",
        &format!("Deleted queued agent work {}", entry.id),
    );
    Ok(entry)
}

#[tauri::command]
pub async fn ensure_agent_session(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    project_id: Option<String>,
) -> Result<SessionRecord, String> {
    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to open agent session because PI is unavailable: {error}")
    })?;
    let resolved_project_id = if let Some(project_id) = project_id {
        project_id
    } else {
        let connection = database::open_connection()?;
        crate::services::projects::require_requested_or_default_project_id(
            &connection,
            None,
            "Create a project first before starting agent sessions.",
        )?
    };
    let context =
        crate::services::pi_sessions::session_context_for_project_id(&resolved_project_id)?;
    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        &resolved_project_id,
        &agent_id,
    )?;
    let session_id = runtime_state
        .main_session_id
        .ok_or_else(|| format!("Agent {agent_id} does not have a main session"))?;

    let session_context = find_session_context_for_session(&session_id)?;

    if state.get_terminal_window_label(&session_id)?.is_some() {
        let mut record = get_session(&session_context.session_dir, &session_id, false)?;
        record.terminal_attached = true;
        let _ = app_events::emit_session_change(&app, "sessions.ensure_agent", [record.id.clone()]);
        return Ok(record);
    }

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        context.project_root,
        session_context.session_dir.clone(),
        &session_id,
    )?;
    runtime.set_subscribed(true);

    let record = get_session(&session_context.session_dir, &session_id, false)?;
    let _ = app_events::emit_session_change(&app, "sessions.ensure_agent", [record.id.clone()]);
    Ok(record)
}

#[tauri::command]
pub async fn open_agent_session_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    project_id: Option<String>,
) -> Result<SessionRecord, String> {
    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to open agent terminal because PI is unavailable: {error}")
    })?;
    let resolved_project_id = if let Some(project_id) = project_id {
        project_id
    } else {
        let connection = database::open_connection()?;
        crate::services::projects::require_requested_or_default_project_id(
            &connection,
            None,
            "Create a project first before starting agent sessions.",
        )?
    };
    let context =
        crate::services::pi_sessions::session_context_for_project_id(&resolved_project_id)?;

    let connection = database::open_connection()?;
    let detail = decorate_runtime_state(
        &state,
        agent_runtime::get_agent_operations_for_project(
            &connection,
            &resolved_project_id,
            &agent_id,
        )?,
    )?;
    if detail.runtime_state.status == "running"
        || detail.runtime_state.current_queue_entry_id.is_some()
    {
        return Err("Only idle agent sessions can be opened in a terminal window.".into());
    }

    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        &resolved_project_id,
        &agent_id,
    )?;
    let session_id = runtime_state
        .main_session_id
        .clone()
        .ok_or_else(|| format!("Agent {agent_id} does not have a main session"))?;

    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        if runtime.has_active_prompt() {
            return Err("This agent session is still processing a message. Wait for it to go idle before opening it in a terminal window.".into());
        }
        state.set_session_subscription(&session_id, false)?;
    } else {
        state.set_session_subscription(&session_id, false)?;
    }

    let window_label = format!("agent-terminal-{session_id}");
    let session_context = find_session_context_for_session(&session_id)?;

    if let Some(existing) = app.get_webview_window(&window_label) {
        existing
            .show()
            .map_err(|error| format!("Unable to show agent terminal window: {error}"))?;
        existing
            .set_focus()
            .map_err(|error| format!("Unable to focus agent terminal window: {error}"))?;
        let mut record = get_session(&session_context.session_dir, &session_id, false)?;
        record.terminal_attached = true;
        return Ok(record);
    }

    state.set_terminal_window(&session_id, &window_label)?;

    let initialization_script = format!(
        "window.__ORCHESTRA_WINDOW_KIND__ = 'agent-terminal'; window.__ORCHESTRA_AGENT_TERMINAL_SESSION_ID__ = {};",
        serde_json::to_string(&session_id).map_err(|error| format!("Unable to serialize agent terminal session id: {error}"))?
    );

    let window = WebviewWindowBuilder::new(
        &app,
        &window_label,
        WebviewUrl::App(PathBuf::from("index.html")),
    )
    .initialization_script(initialization_script)
    .title(&format!("{} · Terminal", detail.agent.name))
    .inner_size(1180.0, 820.0)
    .resizable(true)
    .visible(true)
    .build()
    .map_err(|error| format!("Unable to create agent terminal window: {error}"))?;

    let app_for_window_events = app.clone();
    let session_id_for_window_events = session_id.clone();
    window.on_window_event(move |event| {
        if matches!(
            event,
            WindowEvent::Destroyed | WindowEvent::CloseRequested { .. }
        ) {
            let state = app_for_window_events.state::<AppState>();
            if let Ok(Some(session)) = state.remove_terminal_session(&session_id_for_window_events)
            {
                session.shutdown();
            }
            let _ = state.clear_terminal_window(&session_id_for_window_events);
            let _ = app_events::emit_session_change(
                &app_for_window_events,
                "sessions.terminal.detach",
                [session_id_for_window_events.clone()],
            );
        }
    });

    let session_path = get_session_path(&session_context.session_dir, &session_id)?;
    let runtime_cwd = runtime_state
        .runtime_cwd
        .clone()
        .unwrap_or_else(|| context.project_root.display().to_string());
    let terminal_session = agent_terminal::AgentTerminalSession::spawn(
        app.clone(),
        &session_id,
        &session_path,
        &session_context.session_dir,
        std::path::Path::new(&runtime_cwd),
        &window_label,
    )?;
    state.insert_terminal_session(&session_id, terminal_session)?;
    let _ = app_events::emit_session_change(&app, "sessions.terminal.attach", [session_id.clone()]);

    let mut record = get_session(&session_context.session_dir, &session_id, false)?;
    record.terminal_attached = true;
    Ok(record)
}

#[tauri::command]
pub fn write_agent_terminal_input(
    state: State<'_, AppState>,
    session_id: String,
    data: String,
) -> Result<(), String> {
    let Some(session) = state.get_terminal_session(&session_id)? else {
        return Err(format!(
            "No terminal session is attached for session {session_id}"
        ));
    };
    session.write_input(&data)
}

#[tauri::command]
pub fn resize_agent_terminal(
    state: State<'_, AppState>,
    session_id: String,
    cols: u16,
    rows: u16,
) -> Result<(), String> {
    let Some(session) = state.get_terminal_session(&session_id)? else {
        return Err(format!(
            "No terminal session is attached for session {session_id}"
        ));
    };
    session.resize(cols, rows)
}

#[tauri::command]
pub fn get_agent_terminal_buffer(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<String, String> {
    let Some(session) = state.get_terminal_session(&session_id)? else {
        return Ok(String::new());
    };
    session.buffer()
}

#[tauri::command]
pub fn shutdown_agent_terminal_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<(), String> {
    if let Some(session) = state.remove_terminal_session(&session_id)? {
        session.shutdown();
    }
    state.clear_terminal_window(&session_id)?;
    Ok(())
}
