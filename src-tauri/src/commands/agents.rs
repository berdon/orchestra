use crate::{
    models::{
        AgentDefinition, AgentMemoryInfo, AgentSummary, AgentUpsertInput, AgentValidationResult,
    },
    services::{agents, database},
};

#[tauri::command]
pub fn list_agents(include_archived: Option<bool>) -> Result<Vec<AgentSummary>, String> {
    let connection = database::open_connection()?;
    agents::list_agents(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_agent(agent_id: String) -> Result<AgentDefinition, String> {
    let connection = database::open_connection()?;
    agents::get_agent(&connection, &agent_id)
}

#[tauri::command]
pub fn validate_agent(input: AgentUpsertInput) -> Result<AgentValidationResult, String> {
    let connection = database::open_connection()?;
    agents::validate_agent(&connection, &input)
}

#[tauri::command]
pub fn create_agent(input: AgentUpsertInput) -> Result<AgentDefinition, String> {
    let mut connection = database::open_connection()?;
    agents::create_agent(&mut connection, input)
}

#[tauri::command]
pub fn update_agent(agent_id: String, input: AgentUpsertInput) -> Result<AgentDefinition, String> {
    let mut connection = database::open_connection()?;
    agents::update_agent(&mut connection, &agent_id, input)
}

#[tauri::command]
pub fn archive_agent(agent_id: String) -> Result<AgentDefinition, String> {
    let connection = database::open_connection()?;
    agents::archive_agent(&connection, &agent_id)
}

#[tauri::command]
pub fn get_agent_memory_info(agent_id: String) -> Result<AgentMemoryInfo, String> {
    let connection = database::open_connection()?;
    agents::get_agent_memory_info(&connection, &agent_id)
}
