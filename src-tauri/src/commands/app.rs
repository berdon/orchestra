use std::path::PathBuf;

use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};

use crate::{
    models::{AppInfo, LogEntry, SessionModel, SessionStorageInfo},
    services::pi_sessions::{detect_session_context, list_available_models},
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
pub fn clear_logs(state: State<'_, AppState>) {
    state.clear_logs();
}

#[tauri::command]
pub fn open_logs_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("logs") {
        window
            .show()
            .map_err(|error| format!("Unable to show logs window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Unable to focus logs window: {error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "logs", WebviewUrl::App(PathBuf::from("index.html")))
        .title("Orchestra Logs")
        .inner_size(980.0, 760.0)
        .resizable(true)
        .visible(true)
        .build()
        .map_err(|error| format!("Unable to create logs window: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn get_session_storage_info(
    project_slug: Option<String>,
) -> Result<SessionStorageInfo, String> {
    let context = detect_session_context(project_slug.as_deref())?;

    Ok(SessionStorageInfo {
        orchestra_root: context.orchestra_root.display().to_string(),
        project_slug: context.project_slug,
        session_dir: context.session_dir.display().to_string(),
    })
}

#[tauri::command]
pub async fn list_pi_models() -> Result<Vec<SessionModel>, String> {
    tauri::async_runtime::spawn_blocking(list_available_models)
        .await
        .map_err(|error| format!("Unable to join PI model discovery task: {error}"))?
}
