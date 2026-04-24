use serde::Serialize;
use tauri::{AppHandle, Manager};

use crate::{models::NotificationIntent, state::AppState};

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

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InboxChangeEvent {
    pub delivery_ids: Vec<String>,
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
    let event = TaskChangeEvent {
        task_ids: task_ids.into_iter().collect(),
        reason: reason.into(),
    };
    let _ = app.state::<AppState>().publish_remote_event(
        "task.updated",
        None,
        None,
        event.task_ids.first().cloned(),
        None,
        &event,
    );
    emit_window_event(app, "orchestra:task-change", &event)
}

pub fn emit_session_change(
    app: &AppHandle,
    reason: impl Into<String>,
    session_ids: impl IntoIterator<Item = String>,
) -> Result<(), String> {
    let event = SessionChangeEvent {
        session_ids: session_ids.into_iter().collect(),
        reason: reason.into(),
    };
    let _ = app.state::<AppState>().publish_remote_event(
        "session.updated",
        None,
        event.session_ids.first().cloned(),
        None,
        None,
        &event,
    );
    emit_window_event(app, "orchestra:session-change", &event)
}

pub fn emit_inbox_change(
    app: &AppHandle,
    reason: impl Into<String>,
    delivery_ids: impl IntoIterator<Item = String>,
) -> Result<(), String> {
    let event = InboxChangeEvent {
        delivery_ids: delivery_ids.into_iter().collect(),
        reason: reason.into(),
    };
    let _ = app.state::<AppState>().publish_remote_event(
        "inbox.updated",
        None,
        None,
        None,
        event.delivery_ids.first().cloned(),
        &event,
    );
    emit_window_event(app, "orchestra:inbox-change", &event)
}

pub fn emit_notification_intent(
    app: &AppHandle,
    intent: &NotificationIntent,
) -> Result<(), String> {
    let _ = app.state::<AppState>().publish_remote_event(
        "notification.intent",
        intent.project_id.clone(),
        None,
        intent.task_id.clone(),
        intent.delivery_id.clone(),
        intent,
    );
    emit_window_event(app, "orchestra:notification-intent", intent)
}
