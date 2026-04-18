use std::net::TcpListener;

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State as AxumState, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::json;
use tauri::{AppHandle, Manager};
use tokio::sync::oneshot;

use crate::{
    commands::app::get_app_info,
    models::{
        AppInfo, MailboxMessage, QueuedSessionMessage, RemoteAccessSettings, RemoteAccessStatus,
        RemoteAuthResponse, RemoteDeviceRecord, RemoteEventEnvelope, RemotePairingCompleteInput,
        RemotePushTokenInput, SendMailboxMessageInput, SessionRecord, TaskDetail, TaskSummary,
    },
    services::{
        agent_dispatch, app_events, database,
        live_sessions::ensure_runtime,
        messages, pi_sessions, projects, remote_access, task_runtime, tasks,
    },
    state::{generate_id, now_iso, AppState, RemoteApiServerHandle},
};

#[derive(Clone)]
struct RemoteApiContext {
    app: AppHandle,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ApiError {
    error: String,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct HealthResponse {
    status: &'static str,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListQuery {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxListQuery {
    project_id: Option<String>,
    include_archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMessageInput {
    message: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSelectionMessage {
    #[serde(rename = "type")]
    message_type: String,
    project_id: Option<String>,
    session_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WsAuthQuery {
    token: Option<String>,
}

fn api_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn detect_lan_base_url(port: u16) -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    Some(format!("http://{}:{}", ip, port))
}

fn build_remote_api_context(app: AppHandle) -> Router {
    let context = RemoteApiContext { app };
    Router::new()
        .route("/api/v1/health", get(get_health))
        .route("/api/v1/app-info", get(get_remote_app_info))
        .route("/api/v1/pair/complete", post(post_pair_complete))
        .route("/api/v1/projects", get(get_projects))
        .route("/api/v1/projects/:project_id/tasks", get(get_project_tasks))
        .route("/api/v1/projects/:project_id/supervisor", get(get_supervisor_session))
        .route(
            "/api/v1/projects/:project_id/supervisor/message",
            post(post_supervisor_message),
        )
        .route("/api/v1/tasks/:task_id", get(get_task_detail))
        .route("/api/v1/tasks/:task_id/approve", post(post_task_approve))
        .route("/api/v1/tasks/:task_id/needs-work", post(post_task_needs_work))
        .route("/api/v1/inbox", get(get_inbox_messages))
        .route("/api/v1/devices/push-token", post(post_register_push_token))
        .route("/api/v1/inbox/send", post(post_send_inbox_message))
        .route("/api/v1/inbox/:delivery_id/read", post(post_mark_inbox_read))
        .route(
            "/api/v1/inbox/:delivery_id/archive",
            post(post_archive_inbox_message),
        )
        .route("/api/v1/sessions", get(get_sessions))
        .route("/api/v1/sessions/:session_id", get(get_session_record))
        .route(
            "/api/v1/sessions/:session_id/message",
            post(post_session_message),
        )
        .route("/api/v1/ws", get(ws_handler))
        .with_state(context)
}

pub fn stop_remote_api_server(state: &AppState) -> Result<(), String> {
    if let Some(mut current) = state.take_remote_server()? {
        if let Some(shutdown) = current.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    state.clear_remote_server()?;
    Ok(())
}

pub fn ensure_remote_api_server(app: AppHandle, state: &AppState) -> Result<(), String> {
    let connection = database::open_connection()?;
    let settings = remote_access::load_settings(&connection)?;
    drop(connection);

    if !settings.enabled {
        stop_remote_api_server(state)?;
        state.clear_remote_server_error()?;
        return Ok(());
    }

    start_remote_api_server(app, state, &settings)
}

pub fn build_remote_access_status(state: &AppState) -> Result<RemoteAccessStatus, String> {
    let connection = database::open_connection()?;
    let mut settings = remote_access::load_settings(&connection)?;
    if let Some((_, _, base_url, websocket_url, lan_base_url, started_at)) =
        state.remote_server_snapshot()?
    {
        settings.base_url = Some(base_url);
        settings.websocket_url = Some(websocket_url);
        settings.lan_base_url = lan_base_url;
        settings.started_at = Some(started_at);
    }
    settings.last_error = state.remote_server_error()?;
    let pairing_codes = remote_access::list_pairing_codes(&connection)?;
    let devices = state.with_remote_device_client_counts(remote_access::list_devices(&connection)?)?;
    let active_clients = state.list_remote_clients()?;
    Ok(RemoteAccessStatus {
        settings,
        pairing_codes,
        devices,
        active_clients,
    })
}

pub fn start_remote_api_server(
    app: AppHandle,
    state: &AppState,
    settings: &RemoteAccessSettings,
) -> Result<(), String> {
    stop_remote_api_server(state)?;

    let bind_address = format!("{}:{}", settings.bind_host, settings.port);
    let listener = TcpListener::bind(&bind_address)
        .map_err(|error| format!("Unable to bind remote API server on {bind_address}: {error}"))?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Unable to configure remote API listener: {error}"))?;
    let local_addr = listener
        .local_addr()
        .map_err(|error| format!("Unable to read remote API listener address: {error}"))?;
    let tokio_listener = tokio::net::TcpListener::from_std(listener)
        .map_err(|error| format!("Unable to create async remote API listener: {error}"))?;

    let local_host = if settings.bind_host == "0.0.0.0" {
        "127.0.0.1".to_string()
    } else {
        settings.bind_host.clone()
    };
    let port = local_addr.port();
    let base_url = format!("http://{}:{}", local_host, port);
    let websocket_url = format!("ws://{}:{}/api/v1/ws", local_host, port);
    let lan_base_url = detect_lan_base_url(port);
    let router = build_remote_api_context(app.clone());
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app_for_task = app.clone();

    tauri::async_runtime::spawn(async move {
        let server = axum::serve(tokio_listener, router).with_graceful_shutdown(async move {
            let _ = shutdown_rx.await;
        });
        if let Err(error) = server.await {
            let state = app_for_task.state::<AppState>();
            let message = format!("Remote API server stopped unexpectedly: {error}");
            let _ = state.set_remote_server_error(message.clone());
            state.log("error", "remote.api.server", &message);
        }
    });

    let handle = RemoteApiServerHandle {
        bind_host: settings.bind_host.clone(),
        port,
        base_url,
        websocket_url,
        lan_base_url,
        started_at: now_iso(),
        shutdown: Some(shutdown_tx),
    };
    state.set_remote_server(handle)?;
    state.log(
        "info",
        "remote.api.server",
        &format!("Remote API server listening on {}", bind_address),
    );
    Ok(())
}

fn resolve_remote_auth(
    app: &AppHandle,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<RemoteDeviceRecord, (StatusCode, Json<ApiError>)> {
    let bearer_token = headers
        .get("authorization")
        .and_then(|value| value.to_str().ok())
        .and_then(|value| value.strip_prefix("Bearer "))
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| query_token.map(str::trim).filter(|value| !value.is_empty()).map(str::to_string))
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Missing remote device token"))?;

    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    remote_access::authenticate_token(&connection, &bearer_token)
        .map_err(|error| api_error(StatusCode::UNAUTHORIZED, error))
        .map(|device| {
            app.state::<AppState>().log(
                "info",
                "remote.api.auth",
                &format!("Authenticated remote device {} ({})", device.label, device.id),
            );
            device
        })
}

fn attach_remote_urls(
    state: &AppState,
    mut response: RemoteAuthResponse,
) -> Result<RemoteAuthResponse, String> {
    if let Some((_, _, base_url, websocket_url, lan_base_url, _)) = state.remote_server_snapshot()? {
        let chosen_base_url = lan_base_url.unwrap_or(base_url);
        let chosen_websocket_url = format!("{}/api/v1/ws", chosen_base_url.replacen("http", "ws", 1));
        response.base_url = Some(chosen_base_url);
        response.websocket_url = Some(if chosen_websocket_url.is_empty() {
            websocket_url
        } else {
            chosen_websocket_url
        });
    }
    Ok(response)
}

fn resolve_session_runtime_root(session_id: &str) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let context = pi_sessions::find_session_context_for_session(session_id)?;
    let runtime_root = pi_sessions::get_session_header_cwd(&context.session_dir, session_id)?
        .filter(|path| path.is_dir())
        .unwrap_or(context.project_root.clone());
    Ok((runtime_root, context.session_dir))
}

fn load_remote_session_record(state: &AppState, session_id: &str) -> Result<SessionRecord, String> {
    let context = pi_sessions::find_session_context_for_session(session_id)?;
    let subscribed = state.has_session_subscribers(session_id)?;
    let mut record = pi_sessions::get_session(&context.session_dir, session_id, subscribed)?;
    record.terminal_attached = state.get_terminal_window_label(session_id)?.is_some();
    Ok(record)
}

fn list_remote_sessions(state: &AppState, project_id: Option<&str>) -> Result<Vec<SessionRecord>, String> {
    let project_slug = if let Some(project_id) = project_id {
        let connection = database::open_connection()?;
        Some(projects::get_project(&connection, project_id)?.slug)
    } else {
        None
    };

    let subscribed = state.subscribed_session_ids()?;
    let terminal_attached = state.terminal_attached_session_ids()?;
    let mut sessions = Vec::new();
    for context in pi_sessions::all_session_contexts()? {
        if project_slug
            .as_deref()
            .is_some_and(|slug| slug != context.project_slug)
        {
            continue;
        }
        let mut records = pi_sessions::list_sessions(&context.session_dir, &subscribed)?;
        for record in &mut records {
            record.subscribed = state.has_session_subscribers(&record.id)?;
            record.terminal_attached = terminal_attached.contains(&record.id);
        }
        sessions.extend(records);
    }
    sessions.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(sessions)
}

async fn send_session_message_internal(
    app: AppHandle,
    state: &AppState,
    session_id: String,
    message: String,
) -> Result<QueuedSessionMessage, String> {
    let trimmed_message = message.trim().to_string();
    if trimmed_message.is_empty() {
        return Err("Message cannot be empty".into());
    }

    let session_id_for_task = session_id.clone();
    let (project_root, session_dir) = tauri::async_runtime::spawn_blocking(move || {
        resolve_session_runtime_root(&session_id_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join remote session runtime lookup task: {error}"))??;

    let runtime = ensure_runtime(
        &state.session_runtimes,
        app.clone(),
        project_root,
        session_dir,
        &session_id,
    )?;
    runtime.set_subscribed(state.has_session_subscribers(&session_id)?);

    let run_id = generate_id("remote-run");
    let mut delivery_mode = "prompt";
    let mut owns_prompt_run = false;

    match state.begin_session_run(&session_id, &run_id) {
        Ok(()) => {
            if runtime.has_active_prompt() {
                let _ = state.end_session_run(&session_id, &run_id);
                delivery_mode = "follow_up";
            } else {
                owns_prompt_run = true;
            }
        }
        Err(error) if error == "This session is already processing a message" => {
            if runtime.has_active_prompt() {
                delivery_mode = "follow_up";
            } else {
                state.clear_active_session_run(&session_id)?;
                state.begin_session_run(&session_id, &run_id)?;
                owns_prompt_run = true;
            }
        }
        Err(error) => return Err(error),
    }

    let queued = QueuedSessionMessage {
        session_id: session_id.clone(),
        run_id: run_id.clone(),
        message: trimmed_message.clone(),
        timestamp: now_iso(),
    };

    let run_id_for_task = run_id.clone();
    let message_for_task = trimmed_message.clone();
    let delivery_mode_for_task = delivery_mode.to_string();
    match tauri::async_runtime::spawn_blocking(move || {
        runtime.start_delivery(&run_id_for_task, &delivery_mode_for_task, &message_for_task)
    })
    .await
    .map_err(|error| format!("Unable to join remote session send task: {error}"))?
    {
        Ok(()) => Ok(queued),
        Err(error) => {
            if owns_prompt_run {
                let _ = state.end_session_run(&session_id, &run_id);
            }
            Err(error)
        }
    }
}

fn ensure_supervisor_session_id(project_id: &str) -> Result<String, String> {
    let context = pi_sessions::session_context_for_project_id(project_id)?;
    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        project_id,
        "agent-supervisor",
    )?;
    runtime_state
        .main_session_id
        .ok_or_else(|| "Supervisor agent does not have a main session".to_string())
}

async fn get_health() -> Json<HealthResponse> {
    Json(HealthResponse { status: "ok" })
}

async fn get_remote_app_info() -> Json<AppInfo> {
    Json(get_app_info())
}

async fn post_pair_complete(
    AxumState(context): AxumState<RemoteApiContext>,
    Json(input): Json<RemotePairingCompleteInput>,
) -> Result<Json<RemoteAuthResponse>, (StatusCode, Json<ApiError>)> {
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let response = remote_access::consume_pairing_code(&connection, input)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    let response = attach_remote_urls(context.app.state::<AppState>().inner(), response)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(Json(response))
}

async fn get_projects(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
) -> Result<Json<Vec<crate::models::ProjectSummary>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    projects::list_projects(&connection)
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn get_project_tasks(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<Json<Vec<TaskSummary>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    tasks::list_tasks(&connection, &project_id, false)
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn get_task_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    tasks::get_task_context(&connection, &task_id)
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn post_task_approve(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let state = context.app.state::<AppState>();
    let session_context = pi_sessions::session_context_for_project_id(
        &tasks::get_task_context(&database::open_connection().map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?, &task_id)
            .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?
            .project_id,
    )
    .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let mut connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let mut task = task_runtime::approve_pending_lane_completion(
        &mut connection,
        &session_context.project_root,
        &session_context.session_dir,
        &task_id,
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;

    let auto_dispatches = task_runtime::collect_post_completion_auto_dispatches(&mut connection, &task_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    for outcome in &auto_dispatches {
        task_runtime::start_assignment_run(
            context.app.clone(),
            state.inner(),
            outcome.session_dir.clone(),
            &outcome.assignment,
        )
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
        if let Some(session_id) = outcome.assignment.session_id.clone() {
            let _ = app_events::emit_session_change(
                &context.app,
                "task.transition.next_assignment",
                [session_id],
            );
        }
    }
    if !auto_dispatches.is_empty() {
        task = tasks::get_task_context(&connection, &task_id)
            .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
        let mut changed_task_ids = vec![task.id.clone()];
        changed_task_ids.extend(auto_dispatches.iter().map(|outcome| outcome.task_id.clone()));
        let _ = app_events::emit_task_change(
            &context.app,
            "task.transition.auto_dispatch",
            changed_task_ids,
        );
    }
    let _ = app_events::emit_task_change(
        &context.app,
        "task.transition.approved_success",
        [task.id.clone()],
    );
    state.log(
        "info",
        "remote.api.task.approve",
        &format!("{} approved task {}", device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_needs_work(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let state = context.app.state::<AppState>();
    let project_id = tasks::get_task_context(&database::open_connection().map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?, &task_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?
        .project_id;
    let session_context = pi_sessions::session_context_for_project_id(&project_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let assignment = task_runtime::send_lane_back_for_work(&connection, &task_id)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    task_runtime::start_assignment_follow_up(
        context.app.clone(),
        state.inner(),
        session_context.session_dir.clone(),
        &assignment,
        &task_runtime::lane_rework_follow_up_prompt(),
    )
    .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    if let Some(session_id) = assignment.session_id.clone() {
        let _ = app_events::emit_session_change(&context.app, "task.transition.rework", [session_id]);
    }
    let task = tasks::get_task_context(&connection, &task_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let _ = app_events::emit_task_change(&context.app, "task.transition.needs_work", [task.id.clone()]);
    state.log(
        "info",
        "remote.api.task.needs_work",
        &format!("{} sent task {} back for work", device.label, task_id),
    );
    Ok(Json(task))
}

async fn get_inbox_messages(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<InboxListQuery>,
) -> Result<Json<Vec<MailboxMessage>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    messages::list_user_messages(
        &connection,
        query.project_id.as_deref(),
        query.include_archived.unwrap_or(false),
    )
    .map(Json)
    .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn post_mark_inbox_read(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(delivery_id): Path<String>,
) -> Result<Json<Vec<MailboxMessage>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let updated = messages::mark_user_messages_read(&connection, Some(&[delivery_id.clone()]))
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let _ = app_events::emit_inbox_change(&context.app, "mailbox.read", [delivery_id]);
    Ok(Json(updated))
}

async fn post_archive_inbox_message(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(delivery_id): Path<String>,
) -> Result<Json<Vec<MailboxMessage>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let updated = messages::archive_user_messages(&connection, Some(&[delivery_id.clone()]))
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let _ = app_events::emit_inbox_change(&context.app, "mailbox.archived", [delivery_id]);
    Ok(Json(updated))
}

async fn post_send_inbox_message(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<SendMailboxMessageInput>,
) -> Result<Json<MailboxMessage>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let message = messages::send_mailbox_message_from_user(
        context.app.clone(),
        context.app.state::<AppState>().inner(),
        &connection,
        SendMailboxMessageInput {
            sender_label: Some(device.label),
            ..input
        },
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    let _ = app_events::emit_inbox_change(&context.app, "mailbox.sent", [message.delivery_id.clone()]);
    if let Some(task_id) = message.task_id.clone() {
        let _ = app_events::emit_task_change(&context.app, "mailbox.sent", [task_id]);
    }
    Ok(Json(message))
}

async fn post_register_push_token(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<RemotePushTokenInput>,
) -> Result<Json<RemoteDeviceRecord>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let updated = remote_access::set_device_push_token(
        &connection,
        &device.id,
        input.push_token.as_deref(),
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    Ok(Json(updated))
}

async fn get_sessions(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> Result<Json<Vec<SessionRecord>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    list_remote_sessions(context.app.state::<AppState>().inner(), query.project_id.as_deref())
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn get_session_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<SessionRecord>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    load_remote_session_record(context.app.state::<AppState>().inner(), &session_id)
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn post_session_message(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<SessionMessageInput>,
) -> Result<Json<QueuedSessionMessage>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    send_session_message_internal(
        context.app.clone(),
        context.app.state::<AppState>().inner(),
        session_id,
        input.message,
    )
    .await
    .map(Json)
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))
}

async fn get_supervisor_session(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<Json<SessionRecord>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let session_id = ensure_supervisor_session_id(&project_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    load_remote_session_record(context.app.state::<AppState>().inner(), &session_id)
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn post_supervisor_message(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<SessionMessageInput>,
) -> Result<Json<QueuedSessionMessage>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let session_id = ensure_supervisor_session_id(&project_id)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let state = context.app.state::<AppState>();
    send_session_message_internal(
        context.app.clone(),
        state.inner(),
        session_id,
        input.message,
    )
    .await
    .map(Json)
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))
}

async fn ws_handler(
    ws: WebSocketUpgrade,
    headers: HeaderMap,
    Query(query): Query<WsAuthQuery>,
    AxumState(context): AxumState<RemoteApiContext>,
) -> Response {
    let token = query.token.clone().unwrap_or_default();
    let device = match resolve_remote_auth(&context.app, &headers, query.token.as_deref()) {
        Ok(device) => device,
        Err((status, body)) => return (status, body).into_response(),
    };

    ws.on_upgrade(move |socket| handle_ws_socket(context.app, socket, device, token))
}

async fn handle_ws_socket(
    app: AppHandle,
    socket: WebSocket,
    device: RemoteDeviceRecord,
    token: String,
) {
    let client_id = generate_id("remote-client");
    let state = app.state::<AppState>();
    if let Err(error) = state.register_remote_client(
        &client_id,
        "remote_driver",
        Some(device.id.clone()),
        Some(device.label.clone()),
        None,
    ) {
        state.log("error", "remote.api.ws", &error);
        return;
    }

    let (mut sender, mut receiver) = socket.split();
    let mut event_rx = state.subscribe_remote_events();
    let hello = json!({
        "type": "connected",
        "clientId": client_id,
        "deviceId": device.id,
        "deviceLabel": device.label,
    })
    .to_string();
    if sender.send(Message::Text(hello)).await.is_err() {
        let _ = state.unregister_remote_client(&client_id);
        return;
    }

    loop {
        tokio::select! {
            message = receiver.next() => {
                match message {
                    Some(Ok(Message::Text(payload))) => {
                        if remote_device_token_still_valid(&app, &token).is_err() {
                            break;
                        }
                        let _ = state.touch_remote_client(&client_id);
                        match serde_json::from_str::<ProjectSelectionMessage>(&payload) {
                            Ok(message) if message.message_type == "subscribe_session" => {
                                if let Some(session_id) = message.session_id.as_deref() {
                                    let _ = state.set_remote_session_subscription(&client_id, session_id, true);
                                }
                            }
                            Ok(message) if message.message_type == "unsubscribe_session" => {
                                if let Some(session_id) = message.session_id.as_deref() {
                                    let _ = state.set_remote_session_subscription(&client_id, session_id, false);
                                }
                            }
                            Ok(message) if message.message_type == "select_project" => {
                                let _ = state.set_remote_client_project(&client_id, message.project_id.clone());
                            }
                            Ok(message) if message.message_type == "ping" => {
                                let _ = sender.send(Message::Text(json!({"type":"pong"}).to_string())).await;
                            }
                            _ => {
                                let _ = sender.send(Message::Text(json!({"type":"error","error":"Unsupported websocket message"}).to_string())).await;
                            }
                        }
                    }
                    Some(Ok(Message::Close(_))) | None => break,
                    Some(Ok(Message::Ping(payload))) => {
                        let _ = sender.send(Message::Pong(payload)).await;
                    }
                    Some(Ok(_)) => {}
                    Some(Err(_)) => break,
                }
            }
            event = event_rx.recv() => {
                match event {
                    Ok(event) => {
                        if remote_device_token_still_valid(&app, &token).is_err() {
                            break;
                        }
                        if should_deliver_event(state.inner(), &client_id, &event).unwrap_or(false) {
                            if sender.send(Message::Text(json!({"type":"event","event":event}).to_string())).await.is_err() {
                                break;
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
                }
            }
        }
    }

    let _ = state.unregister_remote_client(&client_id);
}

fn remote_device_token_still_valid(app: &AppHandle, token: &str) -> Result<(), String> {
    let connection = database::open_connection()?;
    let _ = remote_access::authenticate_token(&connection, token)?;
    let _ = app;
    Ok(())
}

fn should_deliver_event(
    state: &AppState,
    client_id: &str,
    event: &RemoteEventEnvelope,
) -> Result<bool, String> {
    if event.topic == "session.stream" {
        return Ok(event
            .session_id
            .as_deref()
            .is_some_and(|session_id| {
                state
                    .remote_client_is_subscribed_to_session(client_id, session_id)
                    .unwrap_or(false)
            }));
    }
    Ok(true)
}
