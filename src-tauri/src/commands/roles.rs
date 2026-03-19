use tauri::State;

use crate::{
    models::{RoleDefinition, RoleSummary, RoleUpsertInput, RoleValidationResult},
    services::{database, roles},
    state::AppState,
};

#[tauri::command]
pub fn list_roles(include_archived: Option<bool>) -> Result<Vec<RoleSummary>, String> {
    let connection = database::open_connection()?;
    roles::list_roles(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_role(role_id: String) -> Result<RoleDefinition, String> {
    let connection = database::open_connection()?;
    roles::get_role(&connection, &role_id)
}

#[tauri::command]
pub fn validate_role(input: RoleUpsertInput) -> Result<RoleValidationResult, String> {
    let connection = database::open_connection()?;
    roles::validate_role(&connection, &input)
}

#[tauri::command]
pub fn create_role(
    state: State<'_, AppState>,
    input: RoleUpsertInput,
) -> Result<RoleDefinition, String> {
    let mut connection = database::open_connection()?;
    let role = roles::create_role(&mut connection, input)?;
    state.log("info", "role.created", &format!("Created role {}", role.id));
    Ok(role)
}

#[tauri::command]
pub fn update_role(
    state: State<'_, AppState>,
    role_id: String,
    input: RoleUpsertInput,
) -> Result<RoleDefinition, String> {
    let mut connection = database::open_connection()?;
    let role = roles::update_role(&mut connection, &role_id, input)?;
    state.log("info", "role.updated", &format!("Updated role {}", role.id));
    Ok(role)
}

#[tauri::command]
pub fn archive_role(state: State<'_, AppState>, role_id: String) -> Result<RoleDefinition, String> {
    let connection = database::open_connection()?;
    let role = roles::archive_role(&connection, &role_id)?;
    state.log(
        "info",
        "role.archived",
        &format!("Archived role {}", role.id),
    );
    Ok(role)
}
