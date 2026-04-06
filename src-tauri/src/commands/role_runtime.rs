use tauri::State;

use crate::{
    models::{
        AuthorizationContext, RoleOperationsDetail, RoleOperationsSnapshot, RoleQueueEntry,
        RoleQueueEntryInput,
    },
    services::{command_authorization, database, role_runtime},
    state::AppState,
};

#[tauri::command]
pub fn list_role_operations(
    include_archived: Option<bool>,
    authorization: Option<AuthorizationContext>,
) -> Result<Vec<RoleOperationsSnapshot>, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.read")?;
    role_runtime::list_role_operations(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_role_operations(
    role_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleOperationsDetail, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(&connection, authorization.as_ref(), "roles.read")?;
    role_runtime::get_role_operations(&connection, &role_id)
}

#[tauri::command]
pub fn enqueue_role_work(
    state: State<'_, AppState>,
    input: RoleQueueEntryInput,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleQueueEntry, String> {
    let mut connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "roles.enqueue",
    )?;
    let queue_entry = role_runtime::enqueue_role_work(&mut connection, input)?;
    state.log(
        "info",
        "role.queue.updated",
        &format!(
            "Queued runtime work {} for role {}",
            queue_entry.id, queue_entry.role_id
        ),
    );
    state.log_authorized_action(
        "auth.audit",
        "enqueue_role_work",
        authorization.as_ref(),
        Some("roles.enqueue"),
        &queue_entry.id,
        "success",
    );
    Ok(queue_entry)
}

#[tauri::command]
pub fn delete_role_queue_entry(
    state: State<'_, AppState>,
    queue_entry_id: String,
    authorization: Option<AuthorizationContext>,
) -> Result<RoleQueueEntry, String> {
    let connection = database::open_connection()?;
    command_authorization::require_permission(
        &connection,
        authorization.as_ref(),
        "roles.enqueue",
    )?;
    let queue_entry = role_runtime::delete_role_queue_entry(&connection, &queue_entry_id)?;
    state.log(
        "info",
        "role.queue.updated",
        &format!("Deleted queued runtime work {}", queue_entry.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "delete_role_queue_entry",
        authorization.as_ref(),
        Some("roles.enqueue"),
        &queue_entry.id,
        "success",
    );
    Ok(queue_entry)
}
