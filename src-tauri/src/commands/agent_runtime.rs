use tauri::State;

use crate::{
    models::{AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput},
    services::{agent_runtime, database},
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
