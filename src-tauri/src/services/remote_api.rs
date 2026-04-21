use std::{
    env,
    ffi::OsStr,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State as AxumState, WebSocketUpgrade,
    },
    http::{HeaderMap, StatusCode},
    response::{IntoResponse, Response},
    routing::{get, get_service, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use tokio::sync::oneshot;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

use crate::{
    commands::{app::build_app_info, sessions as session_commands, tasks as task_commands},
    models::{
        AppInfo, MailboxMessage, QueuedSessionMessage, RemoteAccessSettings, RemoteAccessStatus,
        RemoteAuthResponse, RemoteDeviceRecord, RemoteEventEnvelope, RemotePairingCompleteInput,
        RemotePushTokenInput, SendMailboxMessageInput, SessionRecord, TaskDetail, TaskSummary,
    },
    services::{
        agent_dispatch, app_events, database, live_sessions::ensure_runtime, messages, pi_sessions,
        projects, remote_access, tasks,
    },
    state::{generate_id, now_iso, AppState, RemoteApiServerHandle, RemoteWebServerHandle},
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

const REMOTE_WEB_BIND_HOST: &str = "127.0.0.1";
const REMOTE_WEB_PORT: u16 = 8788;
const REMOTE_WEB_TAILSCALE_PORT: u16 = 9443;

#[derive(Debug)]
struct TailscaleServeInfo {
    active: bool,
    url: Option<String>,
    had_any_web_config_on_port: bool,
}

fn api_error(status: StatusCode, message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    (
        status,
        Json(ApiError {
            error: message.into(),
        }),
    )
}

fn remote_api_target_url(port: u16) -> String {
    format!("http://127.0.0.1:{port}")
}

fn remote_web_target_url(port: u16) -> String {
    format!("http://{REMOTE_WEB_BIND_HOST}:{port}")
}

fn command_output_message(stderr: &[u8], stdout: &[u8], fallback: impl Into<String>) -> String {
    let stderr = String::from_utf8_lossy(stderr).trim().to_string();
    if !stderr.is_empty() {
        return stderr;
    }

    let stdout = String::from_utf8_lossy(stdout).trim().to_string();
    if !stdout.is_empty() {
        return stdout;
    }

    fallback.into()
}

fn is_matching_serve_port(host_port: &str, serve_port: u16) -> bool {
    host_port
        .rsplit(':')
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        == Some(serve_port)
}

fn get_serve_web_configs(payload: &Value) -> Vec<(String, Value)> {
    let mut configs = Vec::new();

    if let Some(web) = payload.get("Web").and_then(Value::as_object) {
        for (host_port, config) in web {
            configs.push((host_port.clone(), config.clone()));
        }
    }

    if let Some(services) = payload.get("Services").and_then(Value::as_object) {
        for service in services.values() {
            if let Some(web) = service.get("Web").and_then(Value::as_object) {
                for (host_port, config) in web {
                    configs.push((host_port.clone(), config.clone()));
                }
            }
        }
    }

    configs
}

fn tailscale_fallback_paths() -> Vec<PathBuf> {
    let executable = format!("tailscale{}", env::consts::EXE_SUFFIX);
    vec![
        PathBuf::from("/opt/homebrew/bin").join(&executable),
        PathBuf::from("/opt/homebrew/sbin").join(&executable),
        PathBuf::from("/usr/local/bin").join(&executable),
        PathBuf::from("/usr/local/sbin").join(&executable),
        PathBuf::from("/Applications/Tailscale.app/Contents/MacOS/Tailscale"),
    ]
}

fn tailscale_search_paths(path_var: Option<&OsStr>) -> Vec<PathBuf> {
    let executable = format!("tailscale{}", env::consts::EXE_SUFFIX);
    let mut candidates = Vec::new();

    if let Some(path_var) = path_var {
        for directory in env::split_paths(path_var) {
            let candidate = directory.join(&executable);
            if !candidates.contains(&candidate) {
                candidates.push(candidate);
            }
        }
    }

    for candidate in tailscale_fallback_paths() {
        if !candidates.contains(&candidate) {
            candidates.push(candidate);
        }
    }

    candidates
}

fn resolve_tailscale_executable() -> Option<PathBuf> {
    let path_var = env::var_os("PATH");
    tailscale_search_paths(path_var.as_deref())
        .into_iter()
        .find(|candidate| candidate.is_file())
}

fn tailscale_missing_message() -> String {
    let checked_locations = tailscale_fallback_paths()
        .into_iter()
        .map(|path| path.display().to_string())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "Tailscale CLI is not installed or not available on PATH. Also checked common install locations: {checked_locations}. Install Tailscale or disable `Use Tailscale Serve`."
    )
}

fn tailscale_command() -> Result<Command, String> {
    let executable = resolve_tailscale_executable().ok_or_else(tailscale_missing_message)?;
    Ok(Command::new(executable))
}

fn tailscale_dns_name() -> Result<Option<String>, String> {
    let mut command = tailscale_command()?;
    let output = command
        .args(["status", "--json"])
        .output()
        .map_err(|error| format!("Unable to run `tailscale status --json`: {error}"))?;
    if !output.status.success() {
        return Err(command_output_message(
            &output.stderr,
            &output.stdout,
            "`tailscale status --json` failed",
        ));
    }
    let payload: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse `tailscale status --json`: {error}"))?;
    Ok(payload
        .get("Self")
        .and_then(|value| value.get("DNSName"))
        .and_then(Value::as_str)
        .map(|value| value.trim_end_matches('.').to_string())
        .filter(|value| !value.is_empty()))
}

fn tailscale_url_for_port(port: u16) -> Result<Option<String>, String> {
    Ok(tailscale_dns_name()?.map(|dns_name| {
        if port == 443 {
            format!("https://{dns_name}/")
        } else {
            format!("https://{dns_name}:{port}")
        }
    }))
}

fn tailscale_cli_available() -> bool {
    let Ok(mut command) = tailscale_command() else {
        return false;
    };

    command
        .arg("version")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .is_ok()
}

fn ensure_tailscale_cli_available() -> Result<(), String> {
    if tailscale_cli_available() {
        Ok(())
    } else {
        Err(tailscale_missing_message())
    }
}

fn get_tailscale_serve_info(target: &str, serve_port: u16) -> Result<TailscaleServeInfo, String> {
    let url = tailscale_url_for_port(serve_port)?;
    let mut command = tailscale_command()?;
    let output = command
        .args(["serve", "status", "--json"])
        .output()
        .map_err(|error| format!("Unable to run `tailscale serve status --json`: {error}"))?;
    if !output.status.success() {
        return Err(command_output_message(
            &output.stderr,
            &output.stdout,
            "`tailscale serve status --json` failed",
        ));
    }

    let payload: Value = serde_json::from_slice(&output.stdout)
        .map_err(|error| format!("Unable to parse `tailscale serve status --json`: {error}"))?;
    let matching_configs = get_serve_web_configs(&payload)
        .into_iter()
        .filter(|(host_port, _)| is_matching_serve_port(host_port, serve_port))
        .collect::<Vec<_>>();

    let active = matching_configs.iter().any(|(_, config)| {
        config
            .get("Handlers")
            .and_then(Value::as_object)
            .into_iter()
            .flat_map(|handlers| handlers.values())
            .any(|handler| handler.get("Proxy").and_then(Value::as_str) == Some(target))
    });

    Ok(TailscaleServeInfo {
        active,
        url,
        had_any_web_config_on_port: !matching_configs.is_empty(),
    })
}

fn ensure_tailscale_serve(target: &str, serve_port: u16) -> Result<Option<String>, String> {
    let info = get_tailscale_serve_info(target, serve_port)?;
    if info.active {
        return Ok(info.url);
    }

    let mut command = tailscale_command()?;
    let output = command
        .args([
            "serve",
            "--bg",
            "--yes",
            &format!("--https={serve_port}"),
            target,
        ])
        .output()
        .map_err(|error| format!("Unable to run `tailscale serve` for {target}: {error}"))?;
    if !output.status.success() {
        let prefix = if info.had_any_web_config_on_port {
            format!("Unable to replace existing Tailscale Serve route on HTTPS port {serve_port}")
        } else {
            format!("Unable to enable Tailscale Serve on HTTPS port {serve_port}")
        };
        return Err(format!(
            "{prefix}: {}",
            command_output_message(
                &output.stderr,
                &output.stdout,
                format!("`tailscale serve` exited with {}", output.status),
            )
        ));
    }

    Ok(tailscale_url_for_port(serve_port)?)
}

fn disable_matching_tailscale_serve(target: &str, serve_port: u16) -> Result<(), String> {
    let info = get_tailscale_serve_info(target, serve_port)?;
    if !info.active {
        return Ok(());
    }

    let mut command = tailscale_command()?;
    let output = command
        .args(["serve", "--yes", &format!("--https={serve_port}"), "off"])
        .output()
        .map_err(|error| {
            format!("Unable to disable Tailscale Serve on HTTPS port {serve_port}: {error}")
        })?;
    if output.status.success() {
        return Ok(());
    }

    Err(command_output_message(
        &output.stderr,
        &output.stdout,
        format!("`tailscale serve off` exited with {}", output.status),
    ))
}

fn disable_any_tailscale_serve_on_port(serve_port: u16) -> Result<(), String> {
    let info = get_tailscale_serve_info("", serve_port)?;
    if !info.had_any_web_config_on_port {
        return Ok(());
    }

    let mut command = tailscale_command()?;
    let output = command
        .args(["serve", "--yes", &format!("--https={serve_port}"), "off"])
        .output()
        .map_err(|error| {
            format!("Unable to disable Tailscale Serve on HTTPS port {serve_port}: {error}")
        })?;
    if output.status.success() {
        return Ok(());
    }

    Err(command_output_message(
        &output.stderr,
        &output.stdout,
        format!("`tailscale serve off` exited with {}", output.status),
    ))
}

fn forwarded_request_base_url(headers: &HeaderMap) -> Option<String> {
    let forwarded = headers.get("forwarded")?.to_str().ok()?;
    let mut proto = None;
    let mut host = None;
    for segment in forwarded.split(';') {
        let (key, value) = segment.trim().split_once('=')?;
        let normalized = value.trim().trim_matches('"');
        if key.eq_ignore_ascii_case("proto") {
            proto = Some(normalized);
        } else if key.eq_ignore_ascii_case("host") {
            host = Some(normalized);
        }
    }
    Some(format!("{}://{}", proto?, host?))
}

fn request_base_url_from_headers(headers: &HeaderMap) -> Option<String> {
    if let Some(base_url) = forwarded_request_base_url(headers) {
        return Some(base_url);
    }

    let host = headers
        .get("x-forwarded-host")
        .or_else(|| headers.get("host"))
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())?;

    let scheme = headers
        .get("x-forwarded-proto")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .or_else(|| {
            headers
                .get("origin")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| {
                    value
                        .split_once("://")
                        .map(|(scheme, _)| scheme.to_string())
                })
        })
        .unwrap_or_else(|| "http".to_string());

    Some(format!("{}://{}", scheme, host))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tailscale_search_paths_include_path_and_common_fallback_locations() {
        let paths = tailscale_search_paths(Some(OsStr::new("/tmp/custom/bin:/usr/local/bin")));
        let executable = format!("tailscale{}", env::consts::EXE_SUFFIX);

        assert_eq!(
            paths.first(),
            Some(&PathBuf::from("/tmp/custom/bin").join(&executable))
        );
        assert!(paths.contains(&PathBuf::from("/opt/homebrew/bin").join(&executable)));
        assert!(paths.contains(&PathBuf::from("/usr/local/bin").join(&executable)));
    }

    #[test]
    fn tailscale_search_paths_do_not_duplicate_common_locations() {
        let paths = tailscale_search_paths(Some(OsStr::new("/opt/homebrew/bin:/usr/local/bin")));
        let executable = format!("tailscale{}", env::consts::EXE_SUFFIX);

        assert_eq!(
            paths
                .iter()
                .filter(|path| **path == PathBuf::from("/opt/homebrew/bin").join(&executable))
                .count(),
            1
        );
        assert_eq!(
            paths
                .iter()
                .filter(|path| **path == PathBuf::from("/usr/local/bin").join(&executable))
                .count(),
            1
        );
    }
}

fn detect_lan_base_url(port: u16) -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    Some(format!("http://{}:{}", ip, port))
}

fn build_remote_api_context(app: AppHandle) -> Router {
    let context = RemoteApiContext { app };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);

    Router::new()
        .route("/api/v1/health", get(get_health))
        .route("/api/v1/app-info", get(get_remote_app_info))
        .route("/api/v1/pair/complete", post(post_pair_complete))
        .route("/api/v1/projects", get(get_projects))
        .route("/api/v1/projects/:project_id/tasks", get(get_project_tasks))
        .route(
            "/api/v1/projects/:project_id/supervisor",
            get(get_supervisor_session),
        )
        .route(
            "/api/v1/projects/:project_id/supervisor/message",
            post(post_supervisor_message),
        )
        .route("/api/v1/tasks/:task_id", get(get_task_detail))
        .route("/api/v1/tasks/:task_id/approve", post(post_task_approve))
        .route(
            "/api/v1/tasks/:task_id/needs-work",
            post(post_task_needs_work),
        )
        .route("/api/v1/tasks/:task_id/resume", post(post_task_resume))
        .route("/api/v1/tasks/:task_id/pause", post(post_task_pause))
        .route(
            "/api/v1/tasks/:task_id/stop-activity",
            post(post_task_stop_activity),
        )
        .route("/api/v1/inbox", get(get_inbox_messages))
        .route("/api/v1/devices/push-token", post(post_register_push_token))
        .route("/api/v1/inbox/send", post(post_send_inbox_message))
        .route(
            "/api/v1/inbox/:delivery_id/read",
            post(post_mark_inbox_read),
        )
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
        .route(
            "/api/v1/sessions/:session_id/stop",
            post(post_stop_session_runtime),
        )
        .route("/api/v1/ws", get(ws_handler))
        .layer(cors)
        .with_state(context)
}

fn resolve_mobile_web_root(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resolve("mobile-web", BaseDirectory::Resource)
        .map_err(|error| format!("Unable to resolve packaged mobile web assets: {error}"))?;
    if bundled.exists() {
        return Ok(bundled);
    }

    let repo = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../mobile/dist-web");
    if repo.exists() {
        return Ok(repo);
    }

    Err(format!(
        "Unable to locate Orchestra web driver assets. Expected {} or {}. Run `cd mobile && npm install && npm run web:build` before enabling Tailscale support.",
        bundled.display(),
        repo.display()
    ))
}

fn build_remote_web_context(root: PathBuf) -> Router {
    let index_file = root.join("index.html");
    Router::new().fallback_service(get_service(
        ServeDir::new(root).not_found_service(ServeFile::new(index_file)),
    ))
}

pub fn stop_remote_web_server(state: &AppState) -> Result<(), String> {
    if let Some(mut current) = state.take_remote_web_server()? {
        if let Some(shutdown) = current.shutdown.take() {
            let _ = shutdown.send(());
        }
    }
    state.clear_remote_web_server()?;
    Ok(())
}

fn start_remote_web_server(app: AppHandle, state: &AppState) -> Result<(), String> {
    stop_remote_web_server(state)?;

    let root = resolve_mobile_web_root(&app)?;
    let bind_address = format!("{REMOTE_WEB_BIND_HOST}:{REMOTE_WEB_PORT}");
    let listener = TcpListener::bind(&bind_address).map_err(|error| {
        format!("Unable to bind Orchestra web driver server on {bind_address}: {error}")
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Unable to configure Orchestra web driver listener: {error}"))?;
    let router = build_remote_web_context(root.clone());
    let (shutdown_tx, shutdown_rx) = oneshot::channel();
    let app_for_task = app.clone();

    std::thread::spawn(move || {
        let state = app_for_task.state::<AppState>();
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let message =
                    format!("Unable to create Orchestra web driver Tokio runtime: {error}");
                let _ = state.clear_remote_web_server();
                let _ = state.set_remote_server_error(message.clone());
                state.log("error", "remote.web.server", &message);
                return;
            }
        };

        let result = runtime.block_on(async move {
            let tokio_listener = tokio::net::TcpListener::from_std(listener).map_err(|error| {
                format!("Unable to create async Orchestra web driver listener: {error}")
            })?;
            axum::serve(tokio_listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .map_err(|error| {
                    format!("Orchestra web driver server stopped unexpectedly: {error}")
                })
        });
        if let Err(message) = result {
            let _ = state.clear_remote_web_server();
            let _ = state.set_remote_server_error(message.clone());
            state.log("error", "remote.web.server", &message);
        }
    });

    state.set_remote_web_server(RemoteWebServerHandle {
        bind_host: REMOTE_WEB_BIND_HOST.to_string(),
        port: REMOTE_WEB_PORT,
        base_url: remote_web_target_url(REMOTE_WEB_PORT),
        started_at: now_iso(),
        shutdown: Some(shutdown_tx),
    })?;
    state.log(
        "info",
        "remote.web.server",
        &format!(
            "Orchestra web driver server listening on {bind_address} from {}",
            root.display()
        ),
    );
    Ok(())
}

pub fn disable_remote_tailscale_api_route(api_port: u16) -> Result<(), String> {
    if !tailscale_cli_available() {
        return Ok(());
    }
    disable_matching_tailscale_serve(&remote_api_target_url(api_port), api_port)
}

fn sync_tailscale_routes(settings: &RemoteAccessSettings, state: &AppState) -> Result<(), String> {
    let api_target = remote_api_target_url(settings.port);
    if !tailscale_cli_available() {
        if settings.use_tailscale {
            return ensure_tailscale_cli_available();
        }
        stop_remote_web_server(state)?;
        return Ok(());
    }

    if settings.use_tailscale {
        ensure_tailscale_serve(&api_target, settings.port)?;
        ensure_tailscale_serve(
            &remote_web_target_url(REMOTE_WEB_PORT),
            REMOTE_WEB_TAILSCALE_PORT,
        )?;
    } else {
        disable_matching_tailscale_serve(&api_target, settings.port)?;
        disable_matching_tailscale_serve(
            &remote_web_target_url(REMOTE_WEB_PORT),
            REMOTE_WEB_TAILSCALE_PORT,
        )?;
        stop_remote_web_server(state)?;
    }
    Ok(())
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
        let api_target = remote_api_target_url(settings.port);
        if tailscale_cli_available() {
            let _ = disable_matching_tailscale_serve(&api_target, settings.port);
            let _ = disable_matching_tailscale_serve(
                &remote_web_target_url(REMOTE_WEB_PORT),
                REMOTE_WEB_TAILSCALE_PORT,
            );
        }
        stop_remote_web_server(state)?;
        stop_remote_api_server(state)?;
        state.clear_remote_server_error()?;
        return Ok(());
    }

    let mut runtime_settings = settings.clone();
    runtime_settings.bind_host = remote_access::effective_bind_host(&settings);

    if settings.use_tailscale && runtime_settings.port == REMOTE_WEB_PORT {
        return Err(format!(
            "Remote API port {} conflicts with the internal web driver port {} used for Tailscale Serve.",
            runtime_settings.port, REMOTE_WEB_PORT
        ));
    }
    if settings.use_tailscale && runtime_settings.port == REMOTE_WEB_TAILSCALE_PORT {
        return Err(format!(
            "Remote API port {} conflicts with the fixed Tailscale web driver HTTPS port {}.",
            runtime_settings.port, REMOTE_WEB_TAILSCALE_PORT
        ));
    }

    let api_matches =
        state
            .remote_server_snapshot()?
            .is_some_and(|(bind_host, port, _, _, _, _)| {
                bind_host == runtime_settings.bind_host && port == runtime_settings.port
            });
    if !api_matches {
        start_remote_api_server(app.clone(), state, &runtime_settings)?;
    }

    if settings.use_tailscale {
        let web_matches =
            state
                .remote_web_server_snapshot()?
                .is_some_and(|(bind_host, port, _, _)| {
                    bind_host == REMOTE_WEB_BIND_HOST && port == REMOTE_WEB_PORT
                });
        if !web_matches {
            start_remote_web_server(app, state)?;
        }
    }

    sync_tailscale_routes(&runtime_settings, state)?;
    state.clear_remote_server_error()?;
    Ok(())
}

pub fn build_remote_access_status(state: &AppState) -> Result<RemoteAccessStatus, String> {
    let connection = database::open_connection()?;
    let mut settings = remote_access::load_settings(&connection)?;
    settings.bind_host = remote_access::effective_bind_host(&settings);
    if let Some((_, _, base_url, websocket_url, lan_base_url, started_at)) =
        state.remote_server_snapshot()?
    {
        settings.base_url = Some(base_url);
        settings.websocket_url = Some(websocket_url);
        settings.lan_base_url = lan_base_url;
        settings.started_at = Some(started_at);
    }
    if let Some((_, _, web_url, _)) = state.remote_web_server_snapshot()? {
        settings.web_url = Some(web_url);
    }
    if settings.use_tailscale {
        settings.tailscale_url = tailscale_url_for_port(settings.port).ok().flatten();
        settings.tailscale_web_url = tailscale_url_for_port(REMOTE_WEB_TAILSCALE_PORT)
            .ok()
            .flatten();
    }
    settings.last_error = state.remote_server_error()?;
    let pairing_codes = remote_access::list_pairing_codes(&connection)?;
    let devices =
        state.with_remote_device_client_counts(remote_access::list_devices(&connection)?)?;
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

    std::thread::spawn(move || {
        let state = app_for_task.state::<AppState>();
        let runtime = match tokio::runtime::Builder::new_multi_thread()
            .enable_all()
            .build()
        {
            Ok(runtime) => runtime,
            Err(error) => {
                let message = format!("Unable to create remote API Tokio runtime: {error}");
                let _ = state.clear_remote_server();
                let _ = state.set_remote_server_error(message.clone());
                state.log("error", "remote.api.server", &message);
                return;
            }
        };

        let result = runtime.block_on(async move {
            let tokio_listener = tokio::net::TcpListener::from_std(listener)
                .map_err(|error| format!("Unable to create async remote API listener: {error}"))?;
            axum::serve(tokio_listener, router)
                .with_graceful_shutdown(async move {
                    let _ = shutdown_rx.await;
                })
                .await
                .map_err(|error| format!("Remote API server stopped unexpectedly: {error}"))
        });
        if let Err(message) = result {
            let _ = state.clear_remote_server();
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
        .or_else(|| {
            query_token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(str::to_string)
        })
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Missing remote device token"))?;

    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    remote_access::authenticate_token(&connection, &bearer_token)
        .map_err(|error| api_error(StatusCode::UNAUTHORIZED, error))
        .map(|device| {
            app.state::<AppState>().log(
                "info",
                "remote.api.auth",
                &format!(
                    "Authenticated remote device {} ({})",
                    device.label, device.id
                ),
            );
            device
        })
}

fn attach_remote_urls(
    state: &AppState,
    headers: Option<&HeaderMap>,
    mut response: RemoteAuthResponse,
) -> Result<RemoteAuthResponse, String> {
    if let Some((_, _, base_url, websocket_url, lan_base_url, _)) =
        state.remote_server_snapshot()?
    {
        let chosen_base_url = headers
            .and_then(request_base_url_from_headers)
            .or(lan_base_url)
            .unwrap_or(base_url);
        let chosen_websocket_url =
            format!("{}/api/v1/ws", chosen_base_url.replacen("http", "ws", 1));
        response.base_url = Some(chosen_base_url);
        response.websocket_url = Some(if chosen_websocket_url.is_empty() {
            websocket_url
        } else {
            chosen_websocket_url
        });
    }
    Ok(response)
}

fn resolve_session_runtime_root(
    session_id: &str,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
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

fn list_remote_sessions(
    state: &AppState,
    project_id: Option<&str>,
) -> Result<Vec<SessionRecord>, String> {
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

async fn get_remote_app_info(AxumState(context): AxumState<RemoteApiContext>) -> Json<AppInfo> {
    Json(build_app_info(context.app.state::<AppState>().inner()))
}

async fn post_pair_complete(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<RemotePairingCompleteInput>,
) -> Result<Json<RemoteAuthResponse>, (StatusCode, Json<ApiError>)> {
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let response = remote_access::consume_pairing_code(&connection, input)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    let response = attach_remote_urls(
        context.app.state::<AppState>().inner(),
        Some(&headers),
        response,
    )
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
    let task = task_commands::approve_task_review(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
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
    let task = task_commands::mark_task_needs_work(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        None,
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.needs_work",
        &format!("{} sent task {} back for work", device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_resume(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::resume_task_lane(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        None,
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.resume",
        &format!("{} resumed task {}", device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_pause(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::pause_task_lane(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        None,
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.pause",
        &format!("{} paused task {}", device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_stop_activity(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::stop_task_activity(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        None,
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.stop_activity",
        &format!("{} stopped task activity for {}", device.label, task_id),
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
    let _ =
        app_events::emit_inbox_change(&context.app, "mailbox.sent", [message.delivery_id.clone()]);
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
    let updated =
        remote_access::set_device_push_token(&connection, &device.id, input.push_token.as_deref())
            .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    Ok(Json(updated))
}

async fn get_sessions(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<SessionListQuery>,
) -> Result<Json<Vec<SessionRecord>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    list_remote_sessions(
        context.app.state::<AppState>().inner(),
        query.project_id.as_deref(),
    )
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

async fn post_stop_session_runtime(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<Json<SessionRecord>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let record = session_commands::stop_session_runtime(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id.clone(),
        None,
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.session.stop",
        &format!("{} stopped session {}", device.label, session_id),
    );
    Ok(Json(record))
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
        return Ok(event.session_id.as_deref().is_some_and(|session_id| {
            state
                .remote_client_is_subscribed_to_session(client_id, session_id)
                .unwrap_or(false)
        }));
    }
    Ok(true)
}
