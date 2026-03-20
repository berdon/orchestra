use tauri::State;

use crate::{
    models::{
        AgentDefinition, AgentMemoryInfo, AgentSummary, AgentUpsertInput, AgentValidationResult,
        AuthorizationContext,
    },
    services::{agents, command_authorization, database},
    state::AppState,
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
    state: State<'_, AppState>,
    input: AgentUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.create")?;
    let agent = agents::create_agent(&mut connection, input)?;
    state.log_authorized_action(
        "auth.audit",
        "create_agent",
        authorization.as_ref(),
        Some("agents.create"),
        &agent.id,
        "success",
    );
    Ok(agent)
}

#[tauri::command]
pub fn update_agent(
    state: State<'_, AppState>,
    agent_id: String,
    input: AgentUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.update")?;
    let agent = agents::update_agent(&mut connection, &agent_id, input)?;
    state.log_authorized_action(
        "auth.audit",
        "update_agent",
        authorization.as_ref(),
        Some("agents.update"),
        &agent_id,
        "success",
    );
    Ok(agent)
}

#[tauri::command]
pub fn archive_agent(
    state: State<'_, AppState>,
    agent_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<AgentDefinition, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "agents.archive")?;
    let agent = agents::archive_agent(&connection, &agent_id)?;
    state.log_authorized_action(
        "auth.audit",
        "archive_agent",
        authorization.as_ref(),
        Some("agents.archive"),
        &agent_id,
        "success",
    );
    Ok(agent)
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
