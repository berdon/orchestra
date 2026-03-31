use tauri::{AppHandle, Manager, State};

use crate::{
    models::{
        AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput,
        AgentRuntimeState, SessionRecord,
    },
    services::{
        agent_dispatch, agent_runtime, agent_terminal, app_events, database,
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions::{detect_session_context, get_session},
    },
    state::AppState,
};

#[tauri::command]
pub fn list_agent_operations(
    include_archived: Option<bool>,
    project_id: Option<String>,
) -> Result<Vec<AgentOperationsSnapshot>, String> {
    let connection = database::open_connection()?;
    match project_id.as_deref() {
        Some(project_id) => agent_runtime::list_agent_operations_for_project(
            &connection,
            project_id,
            include_archived.unwrap_or(false),
        ),
        None => agent_runtime::list_agent_operations(&connection, include_archived.unwrap_or(false)),
    }
}

#[tauri::command]
pub fn get_agent_operations(
    agent_id: String,
    project_id: Option<String>,
) -> Result<AgentOperationsDetail, String> {
    let connection = database::open_connection()?;
    match project_id.as_deref() {
        Some(project_id) => agent_runtime::get_agent_operations_for_project(&connection, project_id, &agent_id),
        None => agent_runtime::get_agent_operations(&connection, &agent_id),
    }
}

#[tauri::command]
pub fn enqueue_agent_work(
    state: State<'_, AppState>,
    input: AgentQueueEntryInput,
) -> Result<AgentQueueEntry, String> {
    let connection = database::open_connection()?;
    let entry = agent_runtime::enqueue_agent_work(&connection, input)?;
    state.log("info", "agent.queue.updated", &format!("Queued agent work {}", entry.id));
    Ok(entry)
}

#[tauri::command]
pub fn delete_agent_queue_entry(
    state: State<'_, AppState>,
    queue_entry_id: String,
) -> Result<AgentQueueEntry, String> {
    let connection = database::open_connection()?;
    let entry = agent_runtime::delete_agent_queue_entry(&connection, &queue_entry_id)?;
    state.log("info", "agent.queue.updated", &format!("Deleted queued agent work {}", entry.id));
    Ok(entry)
}

#[tauri::command]
pub async fn ensure_agent_session(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    project_id: Option<String>,
) -> Result<SessionRecord, String> {
    let (context, resolved_project_id) = if let Some(project_id) = project_id {
        (
            crate::services::pi_sessions::session_context_for_project_id(&project_id)?,
            project_id,
        )
    } else {
        (detect_session_context(None)?, "orchestra".to_string())
    };
    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        &resolved_project_id,
        &agent_id,
    )?;
    let session_id = runtime_state
        .main_session_id
        .ok_or_else(|| format!("Agent {agent_id} does not have a main session"))?;

    if runtime_state.terminal_attached {
        let mut record = get_session(&context.session_dir, &session_id, false)?;
        record.terminal_attached = true;
        let _ = app_events::emit_session_change(&app, "sessions.ensure_agent", [record.id.clone()]);
        return Ok(record);
    }

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        context.project_root,
        context.session_dir.clone(),
        &session_id,
    )?;
    runtime.set_subscribed(true);

    let record = get_session(&context.session_dir, &session_id, true)?;
    let _ = app_events::emit_session_change(&app, "sessions.ensure_agent", [record.id.clone()]);
    Ok(record)
}

#[tauri::command]
pub async fn open_agent_session_terminal(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
    project_id: Option<String>,
) -> Result<AgentRuntimeState, String> {
    let (context, resolved_project_id) = if let Some(project_id) = project_id {
        (
            crate::services::pi_sessions::session_context_for_project_id(&project_id)?,
            project_id,
        )
    } else {
        (detect_session_context(None)?, "orchestra".to_string())
    };

    let ensured_runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        &resolved_project_id,
        &agent_id,
    )?;
    let connection = database::open_connection()?;
    let runtime_state = agent_runtime::reconcile_agent_terminal_state_for_project(&connection, &resolved_project_id, &agent_id)
        .unwrap_or(ensured_runtime_state);
    let session_id = runtime_state
        .main_session_id
        .clone()
        .ok_or_else(|| format!("Agent {agent_id} does not have a main session"))?;

    if runtime_state.terminal_attached {
        return Ok(runtime_state);
    }

    if runtime_state.status == "running" || runtime_state.current_queue_entry_id.is_some() {
        return Err("Only idle agent sessions can be opened in a terminal window.".into());
    }

    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        if runtime.has_active_prompt() {
            return Err("This agent session is still processing a message. Wait for it to go idle before opening it in a terminal window.".into());
        }
        state.set_session_subscription(&session_id, false)?;
        runtime.set_subscribed(false);
    } else {
        state.set_session_subscription(&session_id, false)?;
    }

    let runtime_cwd = runtime_state
        .runtime_cwd
        .clone()
        .unwrap_or_else(|| context.project_root.display().to_string());
    let mut terminal_child = agent_terminal::open_agent_terminal_window(
        &session_id,
        &context.session_dir,
        std::path::Path::new(&runtime_cwd),
    )?;
    let terminal_pid = terminal_child.id();
    let updated = agent_runtime::update_agent_terminal_state_for_project(
        &connection,
        &resolved_project_id,
        &agent_id,
        true,
        Some(terminal_pid),
        Some(&crate::state::now_iso()),
    )?;
    state.set_terminal_session_attachment(&session_id, terminal_pid)?;
    let app_handle = app.clone();
    let session_id_for_thread = session_id.clone();
    std::thread::spawn(move || {
        let _ = terminal_child.wait();
        let state = app_handle.state::<AppState>();
        let _ = state.clear_terminal_session_attachment(&session_id_for_thread);
        state.log("info", "sessions.terminal.detach", &format!("Detached terminal from session {}", session_id_for_thread));
        let _ = app_events::emit_session_change(&app_handle, "sessions.terminal.detach", [session_id_for_thread]);
    });
    state.log("info", "sessions.terminal.attach", &format!("Attached session {} to terminal pid {}", session_id, terminal_pid));
    let _ = app_events::emit_session_change(&app, "sessions.terminal.attach", [session_id]);
    Ok(updated)
}
