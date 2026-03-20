use crate::{
    models::{
        AgentDefinition, AgentMemoryInfo, AgentSummary, AgentUpsertInput, AgentValidationResult,
        AuthorizationContext,
    },
    services::{agents, command_authorization, database},
};

#[tauri::command]
pub fn list_agents(
    include_archived: Option<bool>,
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<AgentSummary>, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.read")?;
    agents::list_agents(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_agent(
    agent_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.read")?;
    agents::get_agent(&connection, &agent_id)
}

#[tauri::command]
pub fn validate_agent(
    input: AgentUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentValidationResult, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.read")?;
    agents::validate_agent(&connection, &input)
}

#[tauri::command]
pub fn create_agent(
    input: AgentUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "agents.create",
    )?;
    agents::create_agent(&mut connection, input)
}

#[tauri::command]
pub fn update_agent(
    agent_id: String,
    input: AgentUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "agents.update",
    )?;
    agents::update_agent(&mut connection, &agent_id, input)
}

#[tauri::command]
pub fn archive_agent(
    agent_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "agents.archive",
    )?;
    agents::archive_agent(&connection, &agent_id)
}

#[tauri::command]
pub fn get_agent_memory_info(
    agent_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentMemoryInfo, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.read")?;
    agents::get_agent_memory_info(&connection, &agent_id)
}
