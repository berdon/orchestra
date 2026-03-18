use tauri::State;

use crate::{
    models::SessionRecord,
    services::pi_sessions::{
        create_session_file, detect_session_context, get_session, list_sessions as list_real_sessions,
        prompt_session,
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
pub fn send_session_message(
    state: State<'_, AppState>,
    session_id: String,
    message: String,
) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;
    state.log(
        "info",
        "sessions.message.start",
        &format!("Sending prompt through pi RPC for session {}", session_id),
    );

    let record = prompt_session(
        &context.project_root,
        &context.session_dir,
        &session_id,
        &message,
        true,
    )?;

    state.log(
        "info",
        "sessions.message.end",
        &format!("Completed pi RPC turn for session {}", record.id),
    );
    Ok(record)
}
