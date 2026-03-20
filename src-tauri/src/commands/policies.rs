use crate::{
    models::{
        AuthorizationContext, OrchestraToolDefinition, PolicyDefinition, PolicySummary,
        ResolvedPermissions,
    },
    services::{authorization, command_authorization, database, policies},
};

#[tauri::command]
pub fn list_policies(
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<PolicySummary>, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "policies.read",
    )?;
    policies::list_policies(&connection)
}

#[tauri::command]
pub fn get_policy(
    policy_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<PolicyDefinition, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "policies.read",
    )?;
    policies::get_policy(&connection, &policy_id)
}

#[tauri::command]
pub fn get_agent_permissions(
    agent_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<ResolvedPermissions, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "policies.read",
    )?;
    authorization::resolve_agent_permissions(&connection, &agent_id)
}

#[tauri::command]
pub fn get_role_permissions(
    role_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<ResolvedPermissions, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "policies.read",
    )?;
    authorization::resolve_role_permissions(&connection, &role_id)
}

#[tauri::command]
pub fn get_role_instance_permissions(
    instance_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<ResolvedPermissions, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "policies.read",
    )?;
    authorization::resolve_role_instance_permissions(&connection, &instance_id)
}

#[tauri::command]
pub fn list_orchestra_tools(
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<OrchestraToolDefinition>, String> {
    let connection = database::open_connection()?;
    command_authorization::list_allowed_tools(&connection, authorization.as_ref())
}
