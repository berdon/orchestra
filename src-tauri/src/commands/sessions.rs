use tauri::{AppHandle, State};

use crate::{
    models::{QueuedSessionMessage, SessionModelState, SessionRecord},
    services::{
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions::{
            create_session_file, detect_session_context, get_session, list_sessions as list_real_sessions,
            set_session_model as apply_session_model,
        },
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
pub fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    let created = create_session_file(
        &context.project_root,
        &context.session_dir,
        title.as_deref(),
        true,
    )?;

    state.set_session_subscription(&created.record.id, true)?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app,
        context.project_root,
        context.session_dir,
        &created.record.id,
    )?;
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
pub fn resume_session(app: AppHandle, state: State<'_, AppState>, session_id: String) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app,
        context.project_root.clone(),
        context.session_dir.clone(),
        &session_id,
    )?;

    let record = get_session(&context.session_dir, &session_id, true)?;
    state.log("info", "sessions.resume", &format!("Resumed pi session {}", record.id));
    Ok(record)
}

#[tauri::command]
pub fn subscribe_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        context.project_root.clone(),
        context.session_dir.clone(),
        &session_id,
    )?;
    runtime.set_subscribed(true);

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
    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(false);
    }

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
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionModelState, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;

    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(true);
        return runtime.get_model_state();
    }

    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        context.project_root,
        context.session_dir,
        &session_id,
    )?;
    runtime.get_model_state()
}

#[tauri::command]
pub fn set_session_model(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<SessionModelState, String> {
    let context = detect_session_context(None)?;
    state.set_session_subscription(&session_id, true)?;

    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(true);
        let result = runtime.set_model(&provider, &model_id)?;
        state.log(
            "info",
            "sessions.model",
            &format!("Changed session {} to {}/{}", session_id, provider, model_id),
        );
        return Ok(result);
    }

    let result = apply_session_model(
        &context.project_root,
        &context.session_dir,
        &session_id,
        &provider,
        &model_id,
    )?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app,
        context.project_root,
        context.session_dir,
        &session_id,
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
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        context.project_root,
        context.session_dir,
        &session_id,
    )?;
    runtime.set_subscribed(true);
    state.begin_session_run(&session_id, &run_id)?;

    let queued = QueuedSessionMessage {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        message: trimmed_message.clone(),
        timestamp: crate::state::now_iso(),
    };

    match runtime.start_run(&run_id, &trimmed_message) {
        Ok(()) => {
            state.log(
                "info",
                "sessions.message.start",
                &format!("Sent prompt to live pi RPC session {}", session_id),
            );
            Ok(queued)
        }
        Err(error) => {
            let _ = state.end_session_run(&session_id, &run_id);
            Err(error)
        }
    }
}
