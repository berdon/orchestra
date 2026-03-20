use tauri::{AppHandle, State};

use crate::{
    models::{AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput, SessionRecord},
    services::{app_events, agent_dispatch, agent_runtime, database, live_sessions::ensure_runtime, pi_sessions::{detect_session_context, get_session}},
    state::AppState,
};

#[tauri::command]
pub fn list_agent_operations(
    include_archived: Option<bool>,
) -> Result<Vec<AgentOperationsSnapshot>, String> {
    let connection = database::open_connection()?;
    agent_runtime::list_agent_operations(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_agent_operations(agent_id: String) -> Result<AgentOperationsDetail, String> {
    let connection = database::open_connection()?;
    agent_runtime::get_agent_operations(&connection, &agent_id)
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
pub async fn ensure_agent_session(
    app: AppHandle,
    state: State<'_, AppState>,
    agent_id: String,
) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    let runtime_state = agent_dispatch::ensure_main_session(&context.project_root, &context.session_dir, &agent_id)?;
    let session_id = runtime_state
        .main_session_id
        .ok_or_else(|| format!("Agent {agent_id} does not have a main session"))?;

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
