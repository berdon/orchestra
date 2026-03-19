use crate::{
    models::{PolicyDefinition, PolicySummary},
    services::{database, policies},
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
