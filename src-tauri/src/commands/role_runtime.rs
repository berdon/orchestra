use tauri::State;

use crate::{
    models::{RoleOperationsDetail, RoleOperationsSnapshot, RoleQueueEntry, RoleQueueEntryInput},
    services::{database, role_runtime},
    state::AppState,
};

#[tauri::command]
pub fn list_role_operations(
    include_archived: Option<bool>,
) -> Result<Vec<RoleOperationsSnapshot>, String> {
    let connection = database::open_connection()?;
    role_runtime::list_role_operations(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_role_operations(role_id: String) -> Result<RoleOperationsDetail, String> {
    let connection = database::open_connection()?;
    role_runtime::get_role_operations(&connection, &role_id)
}

#[tauri::command]
pub fn enqueue_role_work(
    state: State<'_, AppState>,
    input: RoleQueueEntryInput,
) -> Result<RoleQueueEntry, String> {
    let mut connection = database::open_connection()?;
    let queue_entry = role_runtime::enqueue_role_work(&mut connection, input)?;
    state.log(
        "info",
        "role.queue.updated",
        &format!(
            "Queued runtime work {} for role {}",
            queue_entry.id, queue_entry.role_id
        ),
    );
    Ok(queue_entry)
}
