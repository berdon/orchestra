use tauri::State;

use crate::{
    models::{AppInfo, LogEntry, SessionStorageInfo},
    services::pi_sessions::detect_session_context,
    state::AppState,
};

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    AppInfo {
        app_name: "Orchestra".into(),
        environment: "tauri".into(),
        backend_status: "connected".into(),
    }
}

#[tauri::command]
pub fn get_logs(state: State<'_, AppState>) -> Vec<LogEntry> {
    state
        .logs
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn get_session_storage_info(project_slug: Option<String>) -> Result<SessionStorageInfo, String> {
    let context = detect_session_context(project_slug.as_deref())?;

    Ok(SessionStorageInfo {
        orchestra_root: context.orchestra_root.display().to_string(),
        project_slug: context.project_slug,
        session_dir: context.session_dir.display().to_string(),
    })
}
