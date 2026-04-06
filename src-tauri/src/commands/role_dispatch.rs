use tauri::{AppHandle, State};

use crate::{
    models::RoleOperationsDetail,
    services::{app_events, database, live_sessions, pi_sessions, role_dispatch},
    state::AppState,
};

#[tauri::command]
pub fn dispatch_role_queue(
    state: State<'_, AppState>,
    role_id: String,
) -> Result<RoleOperationsDetail, String> {
    state
        .sync_pi_runtime_health()
        .map_err(|error| format!("Unable to dispatch role queue because PI is unavailable: {error}"))?;
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
pub fn reset_role_assignments(
    app: AppHandle,
    state: State<'_, AppState>,
    role_id: String,
) -> Result<RoleOperationsDetail, String> {
    let mut connection = database::open_connection()?;
    let (detail, task_ids, session_contexts) =
        role_dispatch::reset_role_assignments(&mut connection, &role_id)?;
    state.log(
        "info",
        "role.assignments.reset",
        &format!("Reset queued/active assignments for role {}", role_id),
    );
    if !task_ids.is_empty() {
        let _ = app_events::emit_task_change(&app, "role.assignments.reset", task_ids);
    }
    if !session_contexts.is_empty() {
        let session_ids = session_contexts
            .iter()
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        let _ =
            app_events::emit_session_change(&app, "role.assignments.reset", session_ids.clone());
        for (session_id, session_dir) in session_contexts {
            let _ = pi_sessions::delete_session_file(&session_dir, &session_id);
            live_sessions::schedule_session_retirement(
                app.clone(),
                session_id,
                std::time::Duration::ZERO,
                "role.assignments.reset",
            );
        }
    }
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
