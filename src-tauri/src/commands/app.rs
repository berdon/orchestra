use tauri::State;

use crate::{
    models::{AppInfo, LogEntry, SessionStorageInfo},
    services::orchestra_paths::{default_orchestra_root, project_session_dir, sanitize_slug},
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
    let root = default_orchestra_root()?;
    let project_slug = sanitize_slug(project_slug.as_deref().unwrap_or("orchestra"));
    let session_dir = project_session_dir(&root, &project_slug);

    Ok(SessionStorageInfo {
        orchestra_root: root.display().to_string(),
        project_slug,
        session_dir: session_dir.display().to_string(),
    })
}
