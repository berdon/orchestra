use tauri::State;

use crate::{models::{AppInfo, LogEntry}, state::AppState};

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
