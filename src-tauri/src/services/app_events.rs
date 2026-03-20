use serde::Serialize;
use tauri::{AppHandle, Manager};

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskChangeEvent {
    pub task_ids: Vec<String>,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionChangeEvent {
    pub session_ids: Vec<String>,
    pub reason: String,
}

pub fn emit_window_event<T: Serialize>(
    app: &AppHandle,
    event_name: &str,
    payload: &T,
) -> Result<(), String> {
    let serialized = serde_json::to_string(payload)
        .map_err(|error| format!("Unable to serialize {event_name} payload: {error}"))?;
    let script = format!(
        "window.dispatchEvent(new CustomEvent('{event_name}', {{ detail: {serialized} }}));"
    );

    let window = app
        .get_webview_window("main")
        .ok_or_else(|| format!("Main webview window unavailable while emitting {event_name}"))?;

    window
        .eval(&script)
        .map_err(|error| format!("Unable to deliver {event_name}: {error}"))
}

pub fn emit_task_change(
    app: &AppHandle,
    reason: impl Into<String>,
    task_ids: impl IntoIterator<Item = String>,
) -> Result<(), String> {
    emit_window_event(
        app,
        "orchestra:task-change",
        &TaskChangeEvent {
            task_ids: task_ids.into_iter().collect(),
            reason: reason.into(),
        },
    )
}

pub fn emit_session_change(
    app: &AppHandle,
    reason: impl Into<String>,
    session_ids: impl IntoIterator<Item = String>,
) -> Result<(), String> {
    emit_window_event(
        app,
        "orchestra:session-change",
        &SessionChangeEvent {
            session_ids: session_ids.into_iter().collect(),
            reason: reason.into(),
        },
    )
}
