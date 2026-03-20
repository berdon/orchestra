use tauri::State;

use crate::{
    models::RoleOperationsDetail,
    services::{database, pi_sessions, role_dispatch},
    state::AppState,
};

#[tauri::command]
pub fn dispatch_role_queue(
    state: State<'_, AppState>,
    role_id: String,
) -> Result<RoleOperationsDetail, String> {
    let context = pi_sessions::detect_session_context(None)?;
    let mut connection = database::open_connection()?;
    let detail = role_dispatch::dispatch_role_queue(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &role_id,
    )?;
    state.log(
        "info",
        "role.queue.updated",
        &format!("Dispatched queued runtime work for role {}", role_id),
    );
    Ok(detail)
}

#[tauri::command]
pub fn release_role_instance(
    state: State<'_, AppState>,
    instance_id: String,
    outcome: String,
    error_message: Option<String>,
) -> Result<RoleOperationsDetail, String> {
    let context = pi_sessions::detect_session_context(None)?;
    let mut connection = database::open_connection()?;
    let detail = role_dispatch::release_role_instance(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &instance_id,
        &outcome,
        error_message,
    )?;
    state.log(
        "info",
        "role.instance.released",
        &format!(
            "Released role instance {} with outcome {}",
            instance_id, outcome
        ),
    );
    Ok(detail)
}

#[tauri::command]
pub fn dispose_role_instance(
    state: State<'_, AppState>,
    instance_id: String,
) -> Result<RoleOperationsDetail, String> {
    let context = pi_sessions::detect_session_context(None)?;
    let mut connection = database::open_connection()?;
    let detail =
        role_dispatch::dispose_role_instance(&mut connection, &context.project_root, &instance_id)?;
    state.log(
        "info",
        "role.worktree.disposed",
        &format!("Disposed role instance {}", instance_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "dispose_role_instance",
        None,
        None,
        &instance_id,
        "success",
    );
    Ok(detail)
}
