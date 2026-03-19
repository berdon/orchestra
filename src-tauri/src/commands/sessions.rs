use tauri::{async_runtime::spawn_blocking, AppHandle, State};

use crate::{
    models::{QueuedSessionMessage, SessionModelState, SessionRecord},
    services::{
        live_sessions::{ensure_runtime, maybe_runtime},
        pi_sessions::{
            create_session_file, delete_session_file, detect_session_context, get_session,
            list_sessions as list_real_sessions, set_session_model as apply_session_model,
        },
    },
    state::AppState,
};

#[tauri::command]
pub async fn list_sessions(state: State<'_, AppState>) -> Result<Vec<SessionRecord>, String> {
    let subscribed = state.subscribed_session_ids()?;
    spawn_blocking(move || {
        let context = detect_session_context(None)?;
        list_real_sessions(&context.session_dir, &subscribed)
    })
    .await
    .map_err(|error| format!("Unable to join list_sessions task: {error}"))?
}

#[tauri::command]
pub async fn create_session(
    app: AppHandle,
    state: State<'_, AppState>,
    title: Option<String>,
) -> Result<SessionRecord, String> {
    let title_for_task = title.clone();
    let (project_root, session_dir, created) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        let created = create_session_file(
            &context.project_root,
            &context.session_dir,
            title_for_task.as_deref(),
            true,
        )?;
        Ok::<_, String>((context.project_root, context.session_dir, created))
    })
    .await
    .map_err(|error| format!("Unable to join create_session task: {error}"))??;

    state.set_session_subscription(&created.record.id, true)?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir,
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
pub async fn delete_session(state: State<'_, AppState>, session_id: String) -> Result<(), String> {
    if let Some(runtime) = state.remove_session_runtime(&session_id)? {
        runtime.shutdown();
    }
    state.clear_session_tracking(&session_id)?;
    let session_id_for_task = session_id.clone();
    spawn_blocking(move || {
        let context = detect_session_context(None)?;
        delete_session_file(&context.session_dir, &session_id_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join delete_session task: {error}"))??;
    state.log(
        "info",
        "sessions.delete",
        &format!("Deleted pi session {}", session_id),
    );
    Ok(())
}

#[tauri::command]
pub async fn resume_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let (project_root, session_dir) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        Ok::<_, String>((context.project_root, context.session_dir))
    })
    .await
    .map_err(|error| format!("Unable to join resume_session context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let _ = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir.clone(),
        &session_id,
    )?;

    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || get_session(&session_dir, &session_id_for_task, true))
        .await
        .map_err(|error| format!("Unable to join resume_session record task: {error}"))??;
    state.log(
        "info",
        "sessions.resume",
        &format!("Resumed pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub async fn subscribe_session(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    let (project_root, session_dir) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        Ok::<_, String>((context.project_root, context.session_dir))
    })
    .await
    .map_err(|error| format!("Unable to join subscribe_session context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir.clone(),
        &session_id,
    )?;
    runtime.set_subscribed(true);

    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || get_session(&session_dir, &session_id_for_task, true))
        .await
        .map_err(|error| format!("Unable to join subscribe_session record task: {error}"))??;
    state.log(
        "info",
        "sessions.subscribe",
        &format!("Subscribed to pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub async fn unsubscribe_session(
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionRecord, String> {
    state.set_session_subscription(&session_id, false)?;
    if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(false);
    }

    let session_id_for_task = session_id.clone();
    let record = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        get_session(&context.session_dir, &session_id_for_task, false)
    })
    .await
    .map_err(|error| format!("Unable to join unsubscribe_session task: {error}"))??;
    state.log(
        "info",
        "sessions.unsubscribe",
        &format!("Unsubscribed from pi session {}", record.id),
    );
    Ok(record)
}

#[tauri::command]
pub async fn get_session_model_state(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
) -> Result<SessionModelState, String> {
    let (project_root, session_dir) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        Ok::<_, String>((context.project_root, context.session_dir))
    })
    .await
    .map_err(|error| format!("Unable to join get_session_model_state context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;

    let runtime = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(true);
        runtime
    } else {
        ensure_runtime(
            &state.session_runtimes,
            app,
            project_root,
            session_dir,
            &session_id,
        )?
    };

    spawn_blocking(move || runtime.get_model_state())
        .await
        .map_err(|error| format!("Unable to join get_session_model_state runtime task: {error}"))?
}

#[tauri::command]
pub async fn set_session_model(
    app: AppHandle,
    state: State<'_, AppState>,
    session_id: String,
    provider: String,
    model_id: String,
) -> Result<SessionModelState, String> {
    let (project_root, session_dir) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        Ok::<_, String>((context.project_root, context.session_dir))
    })
    .await
    .map_err(|error| format!("Unable to join set_session_model context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;

    let result = if let Some(runtime) = maybe_runtime(&state.session_runtimes, &session_id) {
        runtime.set_subscribed(true);
        let provider_for_task = provider.clone();
        let model_id_for_task = model_id.clone();
        spawn_blocking(move || runtime.set_model(&provider_for_task, &model_id_for_task))
            .await
            .map_err(|error| format!("Unable to join set_session_model runtime task: {error}"))??
    } else {
        let project_root_for_task = project_root.clone();
        let session_dir_for_task = session_dir.clone();
        let session_id_for_task = session_id.clone();
        let provider_for_task = provider.clone();
        let model_id_for_task = model_id.clone();
        let result = spawn_blocking(move || {
            apply_session_model(
                &project_root_for_task,
                &session_dir_for_task,
                &session_id_for_task,
                &provider_for_task,
                &model_id_for_task,
            )
        })
        .await
        .map_err(|error| format!("Unable to join set_session_model file task: {error}"))??;
        let _ = ensure_runtime(
            &state.session_runtimes,
            app,
            project_root,
            session_dir,
            &session_id,
        )?;
        result
    };

    state.log(
        "info",
        "sessions.model",
        &format!(
            "Changed session {} to {}/{}",
            session_id, provider, model_id
        ),
    );

    Ok(result)
}

#[tauri::command]
pub async fn send_session_message(
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

    let (project_root, session_dir) = spawn_blocking(move || {
        let context = detect_session_context(None)?;
        Ok::<_, String>((context.project_root, context.session_dir))
    })
    .await
    .map_err(|error| format!("Unable to join send_session_message context task: {error}"))??;

    state.set_session_subscription(&session_id, true)?;
    let runtime = ensure_runtime(
        &state.session_runtimes,
        app,
        project_root,
        session_dir,
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

    let run_id_for_task = run_id.clone();
    let message_for_task = trimmed_message.clone();
    match spawn_blocking(move || runtime.start_run(&run_id_for_task, &message_for_task))
        .await
        .map_err(|error| format!("Unable to join send_session_message runtime task: {error}"))?
    {
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
