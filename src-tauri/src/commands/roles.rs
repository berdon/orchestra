use tauri::State;

use crate::{
    models::{
        AuthorizationContext, RoleDefinition, RoleSummary, RoleUpsertInput, RoleValidationResult,
    },
    services::{command_authorization, database, roles},
    state::AppState,
};

#[tauri::command]
pub fn list_roles(
    include_archived: Option<bool>,
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<RoleSummary>, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.read")?;
    roles::list_roles(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_role(
    role_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleDefinition, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.read")?;
    roles::get_role(&connection, &role_id)
}

#[tauri::command]
pub fn validate_role(
    input: RoleUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleValidationResult, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.read")?;
    roles::validate_role(&connection, &input)
}

#[tauri::command]
pub fn create_role(
    state: State<'_, AppState>,
    input: RoleUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleDefinition, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.create")?;
    let role = roles::create_role(&mut connection, input)?;
    state.log("info", "role.created", &format!("Created role {}", role.id));
    Ok(role)
}

#[tauri::command]
pub fn update_role(
    state: State<'_, AppState>,
    role_id: String,
    input: RoleUpsertInput,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleDefinition, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.update")?;
    let role = roles::update_role(&mut connection, &role_id, input)?;
    state.log("info", "role.updated", &format!("Updated role {}", role.id));
    Ok(role)
}

#[tauri::command]
pub fn archive_role(
    state: State<'_, AppState>,
    role_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleDefinition, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "roles.archive",
    )?;
    let role = roles::archive_role(&connection, &role_id)?;
    state.log(
        "info",
        "role.archived",
        &format!("Archived role {}", role.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "archive_role",
        authorization.as_ref(),
        Some("roles.archive"),
        &role_id,
        "success",
    );
    Ok(role)
}
