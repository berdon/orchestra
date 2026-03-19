use crate::{models::AgentSummary, services::{agents, database}};

#[tauri::command]
pub fn list_agents(include_archived: Option<bool>) -> Result<Vec<AgentSummary>, String> {
    let connection = database::open_connection()?;
    agents::list_agents(&connection, include_archived.unwrap_or(false))
}
