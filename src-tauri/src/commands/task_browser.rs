use tauri::{AppHandle, Manager, State};

use crate::{
    models::{TaskBrowserSession, TaskCommentDomAnchor},
    services::{database, task_browser},
    state::AppState,
};

#[tauri::command]
pub fn show_task_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskBrowserSession, String> {
    let session = task_browser::show_task_browser(&app, &task_id)?;
    state.log(
        "info",
        "task.browser.show",
        &format!("Revealed task browser {} for task {}", session.id, task_id),
    );
    Ok(session)
}

#[tauri::command]
pub fn get_task_browser_state(task_id: String) -> Result<TaskBrowserSession, String> {
    let mut connection = database::open_connection()?;
    task_browser::ensure_task_browser_session(&mut connection, &task_id)
}

#[tauri::command]
pub fn navigate_task_browser(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    url: String,
) -> Result<TaskBrowserSession, String> {
    let session = task_browser::navigate_task_browser(&app, &task_id, &url)?;
    state.log(
        "info",
        "task.browser.navigate",
        &format!(
            "Navigated task browser {} for task {} to {}",
            session.id, task_id, url
        ),
    );
    let _ = task_browser::emit_task_browser_change(&app, &session, "navigate");
    Ok(session)
}

#[tauri::command]
pub fn set_task_browser_inspect_mode(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    enabled: bool,
) -> Result<TaskBrowserSession, String> {
    let session = task_browser::set_task_browser_inspect_mode(&app, &task_id, enabled)?;
    state.log(
        "info",
        "task.browser.inspect_mode",
        &format!(
            "Set inspect mode={} for task browser {}",
            enabled, session.id
        ),
    );
    let _ = task_browser::emit_task_browser_change(&app, &session, "inspect_mode");
    Ok(session)
}

#[tauri::command]
pub fn reveal_task_browser_dom_anchor(
    app: AppHandle,
    task_id: String,
    anchor: TaskCommentDomAnchor,
) -> Result<TaskBrowserSession, String> {
    let session = task_browser::reveal_task_browser_dom_anchor(&app, &task_id, &anchor)?;
    let _ = task_browser::emit_task_browser_change(&app, &session, "reveal_anchor");
    Ok(session)
}

#[tauri::command]
pub fn task_browser_page_state_changed(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    session_id: String,
    state_payload: task_browser::TaskBrowserPageState,
) -> Result<TaskBrowserSession, String> {
    let connection = database::open_connection()?;
    let reason = state_payload
        .reason
        .clone()
        .unwrap_or_else(|| "page_state".into());
    let session = task_browser::update_task_browser_session_page_state(
        &connection,
        &task_id,
        &session_id,
        state_payload,
    )?;
    let _ = task_browser::emit_task_browser_change(&app, &session, reason.clone());
    state.log(
        "debug",
        "task.browser.page_state",
        &format!(
            "Updated task browser {} for task {} ({reason})",
            session.id, task_id
        ),
    );
    Ok(session)
}

#[tauri::command]
pub fn debug_eval_task_browser(
    app: AppHandle,
    task_id: String,
    script: String,
) -> Result<(), String> {
    if std::env::var("ORCHESTRA_DESKTOP_E2E")
        .map(|value| value != "1")
        .unwrap_or(true)
    {
        return Err("debug_eval_task_browser is only available during desktop E2E runs".into());
    }

    let mut connection = database::open_connection()?;
    let session = task_browser::ensure_task_browser_session(&mut connection, &task_id)?;
    let window = app
        .get_webview_window(&session.window_label)
        .ok_or_else(|| format!("Task browser window {} is not open", session.window_label))?;
    window
        .eval(&script)
        .map_err(|error| format!("Unable to evaluate task browser script: {error}"))
}
