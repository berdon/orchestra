use std::path::PathBuf;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder, WindowEvent};

use crate::{
    commands::sessions::load_detail_session_record_for_state,
    models::{
        AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput,
        AgentRuntimeState, SessionRecord,
    },
    services::{
        agent_dispatch, agent_runtime, agent_terminal, app_events, database,
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions::{find_session_context_for_session, get_session_path},
        pi_setup, session_attachments,
    },
    state::AppState,
};

fn session_has_terminal_attachment(state: &AppState, session_id: &str) -> Result<bool, String> {
    Ok(state.get_terminal_window_label(session_id)?.is_some()
        || session_attachments::session_terminal_attached(session_id)?)
}

fn decorate_runtime_state(
    state: &AppState,
    mut detail: AgentOperationsDetail,
) -> Result<AgentOperationsDetail, String> {
    detail.runtime_state.terminal_attached = detail
        .runtime_state
        .main_session_id
        .as_deref()
        .map(|session_id| session_has_terminal_attachment(state, session_id))
        .transpose()?
        .unwrap_or(false);
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
        .map(|session_id| session_has_terminal_attachment(state, session_id))
        .transpose()?
        .unwrap_or(false);
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
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to open agent session because Pi setup is incomplete: {error}")
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

    state.log(
        "info",
        "agent.session.ensure",
        &format!(
            "ensure_agent_session agent={} requested_project={} runtime_project={} main_session_id={} runtime_cwd={}",
            agent_id,
            resolved_project_id,
            runtime_state.project_id,
            session_id,
            runtime_state.runtime_cwd.as_deref().unwrap_or("<none>"),
        ),
    );

    let session_context = find_session_context_for_session(&session_id)?;

    if session_has_terminal_attachment(&state, &session_id)? {
        let record = load_detail_session_record_for_state(
            state.inner(),
            &session_context.session_dir,
            &session_id,
            false,
        )?;
        state.log(
            "info",
            "agent.session.loaded",
            &format!(
                "Loaded attached agent session {} for agent {} in project {}",
                record.id, agent_id, resolved_project_id,
            ),
        );
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

    let record = load_detail_session_record_for_state(
        state.inner(),
        &session_context.session_dir,
        &session_id,
        true,
    )?;
    state.log(
        "info",
        "agent.session.loaded",
        &format!(
            "Loaded agent session {} for agent {} in project {}",
            record.id, agent_id, resolved_project_id,
        ),
    );
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
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to open agent terminal because Pi setup is incomplete: {error}")
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
        return load_detail_session_record_for_state(
            state.inner(),
            &session_context.session_dir,
            &session_id,
            false,
        );
    }

    session_attachments::claim_session_terminal_attachment(
        &session_id,
        "desktop-agent-terminal",
        Some(&window_label),
        std::process::id(),
    )?;
    if let Err(error) = state.set_terminal_window(&session_id, &window_label) {
        let _ = session_attachments::clear_session_terminal_attachment(&session_id);
        return Err(error);
    };

    let initialization_script = format!(
        "window.__ORCHESTRA_WINDOW_KIND__ = 'agent-terminal'; window.__ORCHESTRA_AGENT_TERMINAL_SESSION_ID__ = {};",
        serde_json::to_string(&session_id).map_err(|error| format!("Unable to serialize agent terminal session id: {error}"))?
    );

    let window = match WebviewWindowBuilder::new(
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
    {
        Ok(window) => window,
        Err(error) => {
            let _ = state.clear_terminal_window(&session_id);
            let _ = session_attachments::clear_session_terminal_attachment(&session_id);
            return Err(format!("Unable to create agent terminal window: {error}"));
        }
    };

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
            let _ = session_attachments::clear_session_terminal_attachment(
                &session_id_for_window_events,
            );
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
    let terminal_session = match agent_terminal::AgentTerminalSession::spawn(
        app.clone(),
        &session_id,
        &session_path,
        &session_context.session_dir,
        std::path::Path::new(&runtime_cwd),
        &window_label,
    ) {
        Ok(session) => session,
        Err(error) => {
            let _ = state.clear_terminal_window(&session_id);
            let _ = session_attachments::clear_session_terminal_attachment(&session_id);
            return Err(error);
        }
    };
    if let Err(error) = state.insert_terminal_session(&session_id, terminal_session) {
        let _ = state.clear_terminal_window(&session_id);
        let _ = session_attachments::clear_session_terminal_attachment(&session_id);
        return Err(error);
    };
    let _ = app_events::emit_session_change(&app, "sessions.terminal.attach", [session_id.clone()]);

    load_detail_session_record_for_state(
        state.inner(),
        &session_context.session_dir,
        &session_id,
        false,
    )
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
pub async fn update_agent_main_session(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    project_id: Option<String>,
    main_session_id: Option<String>,
) -> Result<AgentRuntimeState, String> {
    let _ = app;
    let _ = state;
    let connection = database::open_connection()?;
    let resolved_project_id = if let Some(pid) = project_id {
        pid
    } else {
        crate::services::projects::require_requested_or_default_project_id(
            &connection,
            None,
            "Create a project first before managing agent sessions.",
        )?
    };
    agent_runtime::update_agent_runtime_dispatch_state_for_project(
        &connection,
        &resolved_project_id,
        &agent_id,
        main_session_id.as_deref(),
        None, // Don't update runtime_cwd
        None, // Don't update current_queue_entry_id
        "",   // Don't change status
        None, // Don't change last_error
    )
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
    let _ = session_attachments::clear_session_terminal_attachment(&session_id);
    Ok(())
}
