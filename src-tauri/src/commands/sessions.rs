use tauri::State;

use crate::{
    models::SessionRecord,
    state::{assistant_reply, create_session_event, generate_id, now_iso, AppState},
};

#[tauri::command]
pub fn list_sessions(state: State<'_, AppState>) -> Vec<SessionRecord> {
    let mut sessions = state
        .sessions
        .lock()
        .map(|sessions| sessions.clone())
        .unwrap_or_default();

    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    sessions
}

#[tauri::command]
pub fn create_session(state: State<'_, AppState>, title: Option<String>) -> Result<SessionRecord, String> {
    let timestamp = now_iso();
    let session = SessionRecord {
        id: generate_id("session"),
        title: title
            .map(|value| value.trim().to_string())
            .filter(|value| !value.is_empty())
            .unwrap_or_else(|| "New session".into()),
        status: "active".into(),
        created_at: timestamp.clone(),
        updated_at: timestamp,
        subscribed: true,
        events: vec![
            create_session_event("system", "Session created from the Orchestra Sessions page."),
            create_session_event(
                "assistant",
                "Session is active. Send a message to begin the interaction loop.",
            ),
        ],
    };

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Unable to access session state".to_string())?;
    sessions.insert(0, session.clone());

    state.log("info", "sessions.create", &format!("Created session {}", session.id));
    Ok(session)
}

#[tauri::command]
pub fn resume_session(state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Unable to access session state".to_string())?;

    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("Unable to find session {}", session_id))?;

    session.status = "active".into();
    session.subscribed = true;
    session.updated_at = now_iso();
    session
        .events
        .push(create_session_event("system", "Session resumed from the Sessions page."));

    let updated = session.clone();
    state.log("info", "sessions.resume", &format!("Resumed session {}", updated.id));
    Ok(updated)
}

#[tauri::command]
pub fn subscribe_session(state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Unable to access session state".to_string())?;

    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("Unable to find session {}", session_id))?;

    session.subscribed = true;
    session.updated_at = now_iso();
    session.events.push(create_session_event(
        "system",
        "Live subscription enabled for this session.",
    ));

    let updated = session.clone();
    state.log(
        "info",
        "sessions.subscribe",
        &format!("Subscribed to session {}", updated.id),
    );
    Ok(updated)
}

#[tauri::command]
pub fn unsubscribe_session(state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Unable to access session state".to_string())?;

    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("Unable to find session {}", session_id))?;

    session.subscribed = false;
    session.updated_at = now_iso();
    session.events.push(create_session_event(
        "system",
        "Live subscription disabled for this session.",
    ));

    let updated = session.clone();
    state.log(
        "info",
        "sessions.unsubscribe",
        &format!("Unsubscribed from session {}", updated.id),
    );
    Ok(updated)
}

#[tauri::command]
pub fn send_session_message(
    state: State<'_, AppState>,
    session_id: String,
    message: String,
) -> Result<SessionRecord, String> {
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Message cannot be empty".into());
    }

    let mut sessions = state
        .sessions
        .lock()
        .map_err(|_| "Unable to access session state".to_string())?;

    let session = sessions
        .iter_mut()
        .find(|session| session.id == session_id)
        .ok_or_else(|| format!("Unable to find session {}", session_id))?;

    session.status = "active".into();
    session.updated_at = now_iso();
    session
        .events
        .push(create_session_event("user", trimmed));
    session.events.push(create_session_event(
        "assistant",
        &assistant_reply(trimmed),
    ));

    let updated = session.clone();
    state.log(
        "info",
        "sessions.message",
        &format!("Sent message to session {}", updated.id),
    );
    Ok(updated)
}
