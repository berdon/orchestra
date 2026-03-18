use std::thread;

use tauri::{AppHandle, Emitter, Manager, State};

use crate::{
    models::{QueuedSessionMessage, SessionModelState, SessionRecord, SessionStreamEvent},
    services::pi_sessions::{
        create_session_file, detect_session_context, get_session,
        get_session_model_state as load_session_model_state, list_sessions as list_real_sessions,
        set_session_model as apply_session_model, stream_prompt_session,
    },
    state::AppState,
};

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionRecord>, String> {
    let context = detect_session_context(None)?;
    let subscribed = state.subscribed_session_ids()?;
    list_real_sessions(&context.session_dir, &subscribed)
}

#[tauri::command]
pub fn create_session(state: State<'_, AppState>, title: Option<String>) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    let created = create_session_file(
        &context.project_root,
        &context.session_dir,
        title.as_deref(),
        true,
    )?;

    state.set_session_subscription(&created.record.id, true)?;
    state.log(
        "info",
        "sessions.create",
        &format!(
            "Created real pi session {} at {}",
            created.record.id,
            created.path.display()
        ),
    );

    Ok(created.record)
}

#[tauri::command]
pub fn resume_session(state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;

    let record = get_session(&context.session_dir, &session_id, true)?;
    state.log("info", "sessions.resume", &format!("Resumed pi session {}", record.id));
    Ok(record)
}

#[tauri::command]
pub fn subscribe_session(state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;

    let record = get_session(&context.session_dir, &session_id, true)?;
    state.log(
        "info",
        "sessions.subscribe",
        &format!("Subscribed to pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub fn unsubscribe_session(state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, false)?;

    let record = get_session(&context.session_dir, &session_id, false)?;
    state.log(
        "info",
        "sessions.unsubscribe",
        &format!("Unsubscribed from pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub fn get_session_model_state(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionModelState, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;
    load_session_model_state(&context.project_root, &context.session_dir, &session_id)
}

#[tauri::command]
pub fn set_session_model(
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<SessionModelState, String> {
    if state.is_session_running(&session_id)? {
        return Err("Wait for the current response to finish before changing models".into());
    }

    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;
    let result = apply_session_model(
        &context.project_root,
        &context.session_dir,
        &session_id,
        &provider,
        &model_id,
    )?;

    state.log(
        "info",
        "sessions.model",
        &format!("Changed session {} to {}/{}", session_id, provider, model_id),
    );

    Ok(result)
}

#[tauri::command]
pub fn send_session_message(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    message: String,
    run_id: String,
) -> Result<QueuedSessionMessage, String> {
    let trimmed_message = message.trim().to_string();
    if trimmed_message.is_empty() {
        return Err("Message cannot be empty".into());
    }

    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;
    state.begin_session_run(&session_id, &run_id)?;
    state.log(
        "info",
        "sessions.message.start",
        &format!("Queueing background pi RPC turn for session {}", session_id),
    );

    let queued = QueuedSessionMessage {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        message: trimmed_message.clone(),
        timestamp: crate::state::now_iso(),
    };

    let project_root = context.project_root.clone();
    let session_dir = context.session_dir.clone();
    let app_handle = app.clone();

    thread::spawn(move || {
        let result = stream_prompt_session(
            &project_root,
            &session_dir,
            &session_id,
            &run_id,
            &trimmed_message,
            true,
            |event| {
                let _ = app_handle.emit("session-stream", event);
            },
        );

        match result {
            Ok(record) => {
                emit_session_stream(
                    &app_handle,
                    SessionStreamEvent {
                        session_id: record.id.clone(),
                        run_id: run_id.clone(),
                        event: "sessionUpdated".into(),
                        timestamp: None,
                        delta: None,
                        message: None,
                        record: Some(record.clone()),
                    },
                );
                app_handle.state::<AppState>().log(
                    "info",
                    "sessions.message.end",
                    &format!("Completed pi RPC turn for session {}", record.id),
                );
            }
            Err(error) => {
                if let Ok(record) = get_session(&session_dir, &session_id, true) {
                    emit_session_stream(
                        &app_handle,
                        SessionStreamEvent {
                            session_id: record.id.clone(),
                            run_id: run_id.clone(),
                            event: "sessionUpdated".into(),
                            timestamp: None,
                            delta: None,
                            message: None,
                            record: Some(record),
                        },
                    );
                }

                emit_session_stream(
                    &app_handle,
                    SessionStreamEvent {
                        session_id: session_id.clone(),
                        run_id: run_id.clone(),
                        event: "error".into(),
                        timestamp: None,
                        delta: None,
                        message: Some(error.clone()),
                        record: None,
                    },
                );
                app_handle.state::<AppState>().log(
                    "error",
                    "sessions.message.error",
                    &format!("Session {} failed during pi RPC turn: {}", session_id, error),
                );
            }
        }

        let _ = app_handle.state::<AppState>().end_session_run(&session_id, &run_id);
    });

    Ok(queued)
}

fn emit_session_stream(app: &AppHandle, payload: SessionStreamEvent) {
    let _ = app.emit("session-stream", payload);
}
