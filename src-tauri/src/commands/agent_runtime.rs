use tauri::{AppHandle, State};

use crate::{
    models::{AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput, SessionRecord},
    services::{app_events, agent_dispatch, agent_runtime, database, live_sessions::ensure_runtime, pi_sessions::{detect_session_context, get_session}},
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
