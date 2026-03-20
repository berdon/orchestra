use crate::{
    models::{PolicyDefinition, PolicySummary, ResolvedPermissions},
    services::{authorization, database, policies},
};

#[tauri::command]
pub fn list_policies() -> Result<Vec<PolicySummary>, String> {
    let connection = database::open_connection()?;
    policies::list_policies(&connection)
}

#[tauri::command]
pub fn get_policy(policy_id: String) -> Result<PolicyDefinition, String> {
    let connection = database::open_connection()?;
    policies::get_policy(&connection, &policy_id)
}

#[tauri::command]
pub fn get_agent_permissions(agent_id: String) -> Result<ResolvedPermissions, String> {
    let connection = database::open_connection()?;
    authorization::resolve_agent_permissions(&connection, &agent_id)
}

#[tauri::command]
pub fn get_role_permissions(role_id: String) -> Result<ResolvedPermissions, String> {
    let connection = database::open_connection()?;
    authorization::resolve_role_permissions(&connection, &role_id)
}

#[tauri::command]
pub fn get_role_instance_permissions(instance_id: String) -> Result<ResolvedPermissions, String> {
    let connection = database::open_connection()?;
    authorization::resolve_role_instance_permissions(&connection, &instance_id)
}
