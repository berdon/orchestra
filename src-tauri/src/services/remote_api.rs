use std::{
    env,
    ffi::OsStr,
    fs::{self, OpenOptions},
    io::Write,
    net::TcpListener,
    path::PathBuf,
    process::{Command, Stdio},
};

use axum::{
    extract::{
        ws::{Message, WebSocket},
        Path, Query, State as AxumState, WebSocketUpgrade,
    },
    http::{header, HeaderMap, HeaderValue, StatusCode},
    response::{IntoResponse, Response},
    routing::{delete, get, get_service, patch, post},
    Json, Router,
};
use futures_util::{SinkExt, StreamExt};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use tauri::{path::BaseDirectory, AppHandle, Manager, Runtime};
use tokio::sync::oneshot;
use tower_http::{
    cors::{Any, CorsLayer},
    services::{ServeDir, ServeFile},
};

use crate::{
    commands::{
        agent_runtime as agent_runtime_commands, agents as agent_commands,
        app::{
            build_app_info, get_source_control_settings, list_pi_models, report_client_error,
            update_source_control_settings,
        },
        channels as channel_commands, messages as message_commands, policies as policy_commands,
        project_settings as project_setting_commands, projects as project_commands,
        role_dispatch as role_dispatch_commands, role_runtime as role_runtime_commands,
        roles as role_commands, sessions as session_commands,
        task_schedules as task_schedule_commands, tasks as task_commands,
        workflows as workflow_commands,
    },
    models::{
        AgentQueueEntryInput, AgentUpsertInput, AppInfo, ArchiveMailboxMessagesInput,
        ChannelUpsertInput, MailboxMessage, MarkMailboxMessagesReadInput,
        OrchestraCapabilityAvailability, OrchestraCapabilityDescriptor,
        OrchestraClientAdminCapabilities, OrchestraClientAppCapabilities, OrchestraClientAuthMode,
        OrchestraClientBootstrap, OrchestraClientCapabilities, OrchestraClientCatalogCapabilities,
        OrchestraClientFeatureFlags, OrchestraClientHostCapabilities, OrchestraClientHostKind,
        OrchestraClientInboxCapabilities, OrchestraClientSessionCapabilities,
        OrchestraClientTaskCapabilities, OrchestraClientTransportUrls, ProjectUpsertInput,
        QueuedSessionMessage, RemoteAccessSettings, RemoteAccessStatus, RemoteAuthResponse,
        RemoteDeviceRecord, RemoteEventEnvelope, RemotePairingCompleteInput, RemotePushTokenInput,
        RepositoryRemoteInput, RepositoryUpsertInput, RoleQueueEntryInput, RoleUpsertInput,
        SendMailboxMessageInput, SessionRecord, TaskAttachmentInput, TaskCommentInput,
        TaskCommentUpdateInput, TaskDetail, TaskFileReferenceInput, TaskScheduleUpsertInput,
        TaskSummary, TaskTodoInput, TaskUpsertInput, WorkflowLaneInput, WorkflowLanePatchInput,
        WorkflowLaneReorderInput, WorkflowUpsertInput,
    },
    services::{
        agent_dispatch, app_events, database, messages,
        orchestra_paths::discover_dev_checkout_root, pi_sessions, projects, remote_access, tasks,
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

const FRONTEND_BOOTSTRAP_ROUTE: &str = "/api/v1/frontend/bootstrap";
const SESSION_MESSAGE_ROUTE: &str = "/api/v1/sessions/:session_id/message";

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionListQuery {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectScopedQuery {
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSlugQuery {
    project_slug: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct InboxListQuery {
    project_id: Option<String>,
    include_archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskListQueryParams {
    project_id: Option<String>,
    include_archived: Option<bool>,
    tags: Option<String>,
    tag_match: Option<String>,
    sort_by: Option<String>,
    sort_direction: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct IncludeArchivedQuery {
    include_archived: Option<bool>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LaneScopedQuery {
    lane_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CatalogListQuery {
    include_archived: Option<bool>,
    project_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct LimitQuery {
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct CommentFileMentionQuery {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct FileContentQuery {
    path: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionMessageInput {
    message: String,
    run_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct NotesInput {
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReassignTaskInput {
    lane_id: String,
    notes: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskDependencyInput {
    blocker_task_id: String,
    blocked_task_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCreateInput {
    title: Option<String>,
    project_slug: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionModelInput {
    provider: String,
    model_id: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionCompactInput {
    custom_instructions: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SourceControlSettingsPatchInput {
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SessionPromptSettingsPatchInput {
    project_slug: Option<String>,
    template: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TaskAutomationSettingsPatchInput {
    project_slug: Option<String>,
    auto_dispatch_on_blocker_completion: bool,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerOverlayQuery {
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct WorkerOverlayPatchInput {
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
    prompt: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ProjectSourceControlSettingsPatchInput {
    project_slug: Option<String>,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DefaultRepositoryInput {
    repository_id: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct DuplicateWorkflowInput {
    new_name: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ReleaseRoleInstanceInput {
    outcome: String,
    error_message: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct TelegramBotValidationInput {
    bot_token: String,
    api_base_url: Option<String>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClientErrorReportInput {
    target: String,
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
const ORCHESTRA_CLIENT_CONTRACT_VERSION: &str = "2026-04-23";
const REMOTE_AUTH_COOKIE_NAME: &str = "orchestra_remote_device_token";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RemoteAuthSource {
    SameOriginCookie,
    BearerToken,
    QueryToken,
}

#[derive(Debug, Clone)]
struct RemoteAuthCandidate {
    source: RemoteAuthSource,
    token: String,
}

#[derive(Debug, Clone)]
struct ResolvedRemoteAuth {
    source: RemoteAuthSource,
    token: String,
    device: RemoteDeviceRecord,
}

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

fn internal_api_error(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    api_error(StatusCode::INTERNAL_SERVER_ERROR, message)
}

fn command_error_status(message: &str) -> StatusCode {
    let normalized = message.to_ascii_lowercase();
    if normalized.contains("authentication required") || normalized.contains("unauthorized") {
        StatusCode::UNAUTHORIZED
    } else if normalized.contains("required permission") || normalized.contains("forbidden") {
        StatusCode::FORBIDDEN
    } else if normalized.contains("already exists") || normalized.contains("duplicate") {
        StatusCode::CONFLICT
    } else if normalized.contains("not found")
        || normalized.contains("was not found")
        || normalized.contains("does not exist")
    {
        StatusCode::NOT_FOUND
    } else {
        StatusCode::BAD_REQUEST
    }
}

fn command_api_error(message: impl Into<String>) -> (StatusCode, Json<ApiError>) {
    let message = message.into();
    api_error(command_error_status(&message), message)
}

fn require_remote_device(
    app: &AppHandle,
    headers: &HeaderMap,
) -> Result<ResolvedRemoteAuth, (StatusCode, Json<ApiError>)> {
    resolve_remote_auth(app, headers, None)
}

fn require_remote_auth_only(
    app: &AppHandle,
    headers: &HeaderMap,
) -> Result<(), (StatusCode, Json<ApiError>)> {
    require_remote_device(app, headers).map(|_| ())
}

fn split_tag_filters(raw: Option<&str>) -> Option<Vec<String>> {
    raw.map(|value| {
        value
            .split(',')
            .map(str::trim)
            .filter(|segment| !segment.is_empty())
            .map(str::to_string)
            .collect::<Vec<_>>()
    })
    .filter(|tags| !tags.is_empty())
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
    use axum::{
        body::{to_bytes, Body},
        http::Request,
    };
    use std::{path::PathBuf, process::Command, sync::Mutex};
    use tower::ServiceExt;

    struct RemoteApiParityFixture {
        app: tauri::App,
        auth_header: String,
    }

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn build_remote_api_parity_fixture(case: &str) -> Result<RemoteApiParityFixture, String> {
        database::initialize_database()
            .map_err(|error| format!("failed to initialize remote API parity database: {error}"))?;
        let mut connection = database::open_connection()
            .map_err(|error| format!("failed to open remote API parity database: {error}"))?;
        crate::services::auth_bootstrap::ensure_system_authorization_state(&mut connection, None)?;
        crate::services::install_seed::ensure_install_baseline_seeded(&mut connection)?;

        let app = tauri::Builder::default()
            .manage(AppState::new(
                crate::services::tool_bridge::dummy_tool_bridge_config(&format!(
                    "remote-api-parity-{case}"
                )),
            ))
            .build(tauri::test::mock_context(tauri::test::noop_assets()))
            .map_err(|error| format!("failed to build remote API parity app: {error}"))?;
        let auth_header = format!("Bearer {}", seed_hosted_web_e2e_fixture()?);

        Ok(RemoteApiParityFixture { app, auth_header })
    }

    fn perform_authenticated_json_request(
        app: &tauri::App,
        auth_header: &str,
        uri: &str,
    ) -> Result<Value, String> {
        let router = build_remote_api_context(app.handle().clone());
        let request = Request::builder()
            .uri(uri)
            .header(header::AUTHORIZATION, auth_header)
            .body(Body::empty())
            .map_err(|error| format!("failed to build remote API parity request {uri}: {error}"))?;
        let response = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("failed to build remote API parity runtime: {error}"))?
            .block_on(async move {
                router
                    .oneshot(request)
                    .await
                    .map_err(|error| format!("remote API parity request {uri} failed: {error}"))
            })?;
        if response.status() != StatusCode::OK {
            return Err(format!(
                "remote API parity request {uri} returned status {}",
                response.status()
            ));
        }
        let body = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| format!("failed to build remote API parity body runtime: {error}"))?
            .block_on(async move {
                to_bytes(response.into_body(), usize::MAX)
                    .await
                    .map_err(|error| {
                        format!("failed to read remote API parity response body {uri}: {error}")
                    })
            })?;
        serde_json::from_slice(&body)
            .map_err(|error| format!("failed to decode remote API parity JSON {uri}: {error}"))
    }

    fn run_production_route_probe(case: &str, extra_env: &[(&str, &str)]) -> Result<(), String> {
        let manifest_path = PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("Cargo.toml");
        let cargo = std::env::var("CARGO").unwrap_or_else(|_| "cargo".into());
        let mut command = Command::new(cargo);
        command.args([
            "run",
            "--quiet",
            "--manifest-path",
            manifest_path
                .to_str()
                .expect("manifest path should be valid utf-8"),
            "--bin",
            "remote_api_route_probe",
            "--",
            case,
        ]);
        command.env("CARGO_TERM_COLOR", "never");
        for (key, value) in extra_env {
            command.env(key, value);
        }

        let output = command
            .output()
            .map_err(|error| format!("failed to run production route probe `{case}`: {error}"))?;

        if output.status.success() {
            return Ok(());
        }

        Err(format!(
            "production route probe `{case}` failed with status {}\nstdout:\n{}\nstderr:\n{}",
            output.status,
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr),
        ))
    }

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

    #[test]
    fn task_list_query_params_deserialize_tag_filters_and_sort_fields() {
        let params: TaskListQueryParams = serde_json::from_value(json!({
            "projectId": "project-123",
            "includeArchived": true,
            "tags": "backend,urgent",
            "tagMatch": "any",
            "sortBy": "tags",
            "sortDirection": "asc"
        }))
        .expect("task list query params should deserialize");

        assert_eq!(params.project_id.as_deref(), Some("project-123"));
        assert_eq!(params.include_archived, Some(true));
        assert_eq!(params.tags.as_deref(), Some("backend,urgent"));
        assert_eq!(params.tag_match.as_deref(), Some("any"));
        assert_eq!(params.sort_by.as_deref(), Some("tags"));
        assert_eq!(params.sort_direction.as_deref(), Some("asc"));
    }

    #[test]
    fn websocket_message_type_aliases_cover_shared_and_legacy_clients() {
        assert_eq!(
            normalize_ws_message_type("subscribe_session"),
            "session.subscribe"
        );
        assert_eq!(
            normalize_ws_message_type("session.subscribe"),
            "session.subscribe"
        );
        assert_eq!(
            normalize_ws_message_type("unsubscribe_session"),
            "session.unsubscribe"
        );
        assert_eq!(
            normalize_ws_message_type("project.select"),
            "project.select"
        );
    }

    #[test]
    fn websocket_topics_translate_for_hosted_web_clients() {
        assert_eq!(
            remote_event_topic_for_client("hosted_web", "task.updated"),
            "task.change"
        );
        assert_eq!(
            remote_event_topic_for_client("hosted_web", "session.updated"),
            "session.change"
        );
        assert_eq!(
            remote_event_topic_for_client("hosted_web", "inbox.updated"),
            "inbox.change"
        );
        assert_eq!(
            remote_event_topic_for_client("remote_driver", "task.change"),
            "task.updated"
        );
        assert_eq!(
            remote_event_topic_for_client("remote_driver", "session.stream"),
            "session.stream"
        );
    }

    #[test]
    fn build_remote_auth_candidate_prefers_cookie_then_bearer_then_query_token() {
        let mut headers = HeaderMap::new();
        headers.insert(
            header::COOKIE,
            HeaderValue::from_static("other=value; orchestra_remote_device_token=cookie-token"),
        );
        headers.insert(
            header::AUTHORIZATION,
            HeaderValue::from_static("Bearer bearer-token"),
        );

        let candidate = build_remote_auth_candidate(&headers, Some("query-token"))
            .expect("cookie auth candidate should resolve");
        assert_eq!(candidate.source, RemoteAuthSource::SameOriginCookie);
        assert_eq!(candidate.token, "cookie-token");

        headers.remove(header::COOKIE);
        let candidate = build_remote_auth_candidate(&headers, Some("query-token"))
            .expect("bearer auth candidate should resolve");
        assert_eq!(candidate.source, RemoteAuthSource::BearerToken);
        assert_eq!(candidate.token, "bearer-token");

        headers.remove(header::AUTHORIZATION);
        let candidate = build_remote_auth_candidate(&headers, Some("query-token"))
            .expect("query auth candidate should resolve");
        assert_eq!(candidate.source, RemoteAuthSource::QueryToken);
        assert_eq!(candidate.token, "query-token");
    }

    #[test]
    fn websocket_url_from_base_url_tracks_http_and_https_schemes() {
        assert_eq!(
            websocket_url_from_base_url("http://127.0.0.1:49500"),
            "ws://127.0.0.1:49500/api/v1/ws"
        );
        assert_eq!(
            websocket_url_from_base_url("https://orchestra.example.test"),
            "wss://orchestra.example.test/api/v1/ws"
        );
    }

    #[test]
    fn build_remote_auth_cookie_sets_http_only_same_site_cookie() {
        let cookie = build_remote_auth_cookie("token-123", true)
            .expect("cookie header should build")
            .to_str()
            .expect("cookie should be utf-8")
            .to_string();

        assert!(cookie.contains("orchestra_remote_device_token=token-123"));
        assert!(cookie.contains("HttpOnly"));
        assert!(cookie.contains("SameSite=Lax"));
        assert!(cookie.contains("Secure"));
    }

    #[test]
    fn frontend_bootstrap_route_reflects_authenticated_capabilities() {
        let _probe_lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        run_production_route_probe("frontend_bootstrap", &[])
            .expect("frontend bootstrap production route probe should pass");
    }

    #[test]
    fn session_message_route_reuses_tauri_readiness_checks() {
        let _probe_lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        run_production_route_probe(
            "session_message",
            &[(
                "ORCHESTRA_PI_EXECUTABLE",
                "/definitely/missing/orchestra-pi-test-binary",
            )],
        )
        .expect("session message production route probe should pass");
    }

    #[test]
    fn tasks_route_matches_tauri_task_command_payloads() {
        let _probe_lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        run_production_route_probe("task_list_parity", &[])
            .expect("task list production parity probe should pass");
    }

    #[test]
    fn inbox_route_matches_tauri_inbox_command_payloads() {
        let _probe_lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        run_production_route_probe("inbox_parity", &[])
            .expect("inbox production parity probe should pass");
    }

    #[test]
    fn session_routes_match_remote_session_helpers() {
        let _probe_lock = TEST_ENV_LOCK
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        run_production_route_probe("sessions_parity", &[])
            .expect("sessions production parity probe should pass");
    }
}

fn detect_lan_base_url(port: u16) -> Option<String> {
    let socket = std::net::UdpSocket::bind("0.0.0.0:0").ok()?;
    socket.connect("8.8.8.8:80").ok()?;
    let ip = socket.local_addr().ok()?.ip();
    Some(format!("http://{}:{}", ip, port))
}

fn register_frontend_bootstrap_and_session_routes<S, R, SessionSender, SessionFuture>(
    router: Router<S>,
    app: AppHandle<R>,
    session_sender: SessionSender,
) -> Router<S>
where
    S: Clone + Send + Sync + 'static,
    R: Runtime,
    SessionSender:
        Fn(String, String, Option<String>) -> SessionFuture + Clone + Send + Sync + 'static,
    SessionFuture:
        std::future::Future<Output = Result<QueuedSessionMessage, String>> + Send + 'static,
{
    let bootstrap_app = app.clone();
    let session_app = app;

    router
        .route(
            FRONTEND_BOOTSTRAP_ROUTE,
            get(move |headers: HeaderMap| {
                let app = bootstrap_app.clone();
                async move { frontend_bootstrap_response(&app, headers) }
            }),
        )
        .route(
            SESSION_MESSAGE_ROUTE,
            post(
                move |headers: HeaderMap,
                      Path(session_id): Path<String>,
                      Json(input): Json<SessionMessageInput>| {
                    let app = session_app.clone();
                    let sender = session_sender.clone();
                    async move {
                        session_message_response_with_sender(
                            &app,
                            headers,
                            session_id,
                            input,
                            move |session_id, message, run_id| {
                                let sender = sender.clone();
                                async move { sender(session_id, message, run_id).await }
                            },
                        )
                        .await
                    }
                },
            ),
        )
}

fn build_remote_api_context(app: AppHandle) -> Router {
    let context = RemoteApiContext { app: app.clone() };
    let cors = CorsLayer::new()
        .allow_origin(Any)
        .allow_methods(Any)
        .allow_headers(Any);
    let app_for_session_sender = app.clone();

    let router = Router::new()
        .route("/api/v1/health", get(get_health))
        .route("/api/v1/app-info", get(get_remote_app_info))
        .route("/api/v1/client-errors", post(post_client_error_report))
        .route("/api/v1/pair/complete", post(post_pair_complete))
        .route("/api/v1/models", get(get_pi_model_catalog))
        .route(
            "/api/v1/settings/source-control",
            get(get_global_source_control_settings).patch(patch_global_source_control_settings),
        )
        .route(
            "/api/v1/project-settings/session-prompt",
            get(get_project_session_prompt_settings).patch(patch_project_session_prompt_settings),
        )
        .route(
            "/api/v1/project-settings/task-automation",
            get(get_project_task_automation_settings).patch(patch_project_task_automation_settings),
        )
        .route(
            "/api/v1/project-settings/source-control",
            get(get_project_source_control_settings).patch(patch_project_source_control_settings),
        )
        .route(
            "/api/v1/project-settings/worker-overlay",
            get(get_worker_overlay_settings).patch(patch_worker_overlay_settings),
        )
        .route(
            "/api/v1/projects",
            get(get_projects).post(post_project_create),
        )
        .route(
            "/api/v1/projects/:project_id",
            get(get_project_detail)
                .patch(patch_project_update)
                .delete(delete_project_record),
        )
        .route("/api/v1/projects/:project_id/tasks", get(get_project_tasks))
        .route(
            "/api/v1/projects/:project_id/repositories",
            get(get_project_repositories).post(post_project_repository_create),
        )
        .route(
            "/api/v1/projects/:project_id/default-repository",
            post(post_project_default_repository),
        )
        .route(
            "/api/v1/projects/:project_id/supervisor",
            get(get_supervisor_session),
        )
        .route(
            "/api/v1/projects/:project_id/supervisor/message",
            post(post_supervisor_message),
        )
        .route("/api/v1/repositories", get(get_repositories))
        .route(
            "/api/v1/repositories/:repository_id",
            get(get_repository_detail)
                .patch(patch_repository_update)
                .delete(delete_repository_record),
        )
        .route(
            "/api/v1/repositories/:repository_id/attach-remote",
            post(post_repository_attach_remote),
        )
        .route("/api/v1/agents", get(get_agents).post(post_agent_create))
        .route("/api/v1/agents/validate", post(post_validate_agent))
        .route("/api/v1/agent-operations", get(get_agent_operations))
        .route("/api/v1/agent-queue", post(post_enqueue_agent_work))
        .route(
            "/api/v1/agent-queue/:queue_entry_id",
            delete(delete_agent_queue_entry),
        )
        .route(
            "/api/v1/agents/:agent_id",
            get(get_agent_detail).patch(patch_agent_update),
        )
        .route("/api/v1/agents/:agent_id/archive", post(post_archive_agent))
        .route(
            "/api/v1/agents/:agent_id/operations",
            get(get_agent_operation_detail),
        )
        .route(
            "/api/v1/agents/:agent_id/permissions",
            get(get_agent_permissions),
        )
        .route(
            "/api/v1/agents/:agent_id/sessions/ensure",
            post(post_ensure_agent_session),
        )
        .route("/api/v1/roles", get(get_roles).post(post_role_create))
        .route("/api/v1/roles/validate", post(post_validate_role))
        .route("/api/v1/role-operations", get(get_role_operations))
        .route("/api/v1/role-queue", post(post_enqueue_role_work))
        .route(
            "/api/v1/role-queue/:queue_entry_id",
            delete(delete_role_queue_entry),
        )
        .route(
            "/api/v1/roles/:role_id",
            get(get_role_detail).patch(patch_role_update),
        )
        .route("/api/v1/roles/:role_id/archive", post(post_archive_role))
        .route(
            "/api/v1/roles/:role_id/operations",
            get(get_role_operation_detail),
        )
        .route(
            "/api/v1/roles/:role_id/permissions",
            get(get_role_permissions),
        )
        .route(
            "/api/v1/roles/:role_id/dispatch",
            post(post_dispatch_role_queue),
        )
        .route(
            "/api/v1/roles/:role_id/reset-assignments",
            post(post_reset_role_assignments),
        )
        .route(
            "/api/v1/role-instances/:instance_id/permissions",
            get(get_role_instance_permissions),
        )
        .route(
            "/api/v1/role-instances/:instance_id/release",
            post(post_release_role_instance),
        )
        .route(
            "/api/v1/role-instances/:instance_id/dispose",
            post(post_dispose_role_instance),
        )
        .route(
            "/api/v1/workflows",
            get(get_workflows).post(post_workflow_create),
        )
        .route("/api/v1/workflows/validate", post(post_validate_workflow))
        .route(
            "/api/v1/workflows/:workflow_id",
            get(get_workflow_detail)
                .patch(patch_workflow_update)
                .delete(delete_workflow_record),
        )
        .route(
            "/api/v1/workflows/:workflow_id/delete-impact",
            get(get_workflow_delete_impact),
        )
        .route(
            "/api/v1/workflows/:workflow_id/archive",
            post(post_archive_workflow),
        )
        .route(
            "/api/v1/workflows/:workflow_id/duplicate",
            post(post_duplicate_workflow),
        )
        .route(
            "/api/v1/workflows/:workflow_id/lanes",
            post(post_workflow_lane_create),
        )
        .route(
            "/api/v1/workflows/:workflow_id/lanes/reorder",
            post(post_workflow_lane_reorder),
        )
        .route(
            "/api/v1/workflows/:workflow_id/lanes/:lane_id",
            patch(patch_workflow_lane).delete(delete_workflow_lane),
        )
        .route("/api/v1/policies", get(get_policies))
        .route(
            "/api/v1/policies/orchestra-tools",
            get(get_policy_orchestra_tools),
        )
        .route("/api/v1/policies/:policy_id", get(get_policy_detail))
        .route(
            "/api/v1/channels",
            get(get_channels).post(post_channel_create),
        )
        .route(
            "/api/v1/channels/telegram/validate-bot",
            post(post_validate_telegram_bot),
        )
        .route(
            "/api/v1/channels/telegram/chat-candidates",
            post(post_list_telegram_chat_candidates),
        )
        .route(
            "/api/v1/channels/:channel_id",
            get(get_channel_detail)
                .patch(patch_channel_update)
                .delete(delete_channel_record),
        )
        .route(
            "/api/v1/channels/:channel_id/activity",
            get(get_channel_activity),
        )
        .route("/api/v1/tasks", get(get_tasks).post(post_task_create))
        .route(
            "/api/v1/tasks/:task_id",
            get(get_task_detail)
                .patch(patch_task_update)
                .delete(delete_task_record),
        )
        .route(
            "/api/v1/tasks/:task_id/subtasks",
            post(post_task_subtask_create),
        )
        .route(
            "/api/v1/tasks/:task_id/todos",
            get(get_task_todos).post(post_task_todo_create),
        )
        .route(
            "/api/v1/tasks/:task_id/todos/unfinished",
            get(get_unfinished_task_todos),
        )
        .route(
            "/api/v1/task-todos/:todo_id/finish",
            post(post_task_todo_finish),
        )
        .route(
            "/api/v1/task-todos/:todo_id/unfinish",
            post(post_task_todo_unfinish),
        )
        .route(
            "/api/v1/task-todos/:todo_id",
            delete(delete_task_todo_record),
        )
        .route(
            "/api/v1/tasks/:task_id/comments",
            get(get_task_comments).post(post_task_comment_create),
        )
        .route(
            "/api/v1/tasks/:task_id/comments/read",
            post(post_task_comments_read),
        )
        .route(
            "/api/v1/tasks/:task_id/comment-file-mentions",
            get(get_task_comment_file_mentions),
        )
        .route(
            "/api/v1/task-comments/:comment_id",
            patch(patch_task_comment).delete(delete_task_comment_record),
        )
        .route("/api/v1/tasks/:task_id/messages", get(get_task_messages))
        .route(
            "/api/v1/task-dependencies",
            post(post_task_dependency_create),
        )
        .route(
            "/api/v1/task-dependencies/:dependency_id",
            delete(delete_task_dependency_record),
        )
        .route(
            "/api/v1/tasks/:task_id/repositories",
            get(get_task_repositories),
        )
        .route(
            "/api/v1/tasks/:task_id/file-references",
            get(get_task_file_references).post(post_task_file_reference_create),
        )
        .route(
            "/api/v1/task-file-references/:reference_id/default",
            post(post_default_task_file_reference),
        )
        .route(
            "/api/v1/task-file-references/:reference_id",
            delete(delete_task_file_reference_record),
        )
        .route(
            "/api/v1/task-file-content",
            get(get_task_file_content_route),
        )
        .route(
            "/api/v1/tasks/:task_id/attachments",
            post(post_task_attachment_create),
        )
        .route(
            "/api/v1/task-attachments/:attachment_id",
            delete(delete_task_attachment_record),
        )
        .route(
            "/api/v1/task-schedules",
            get(get_task_schedules).post(post_task_schedule_create),
        )
        .route(
            "/api/v1/task-schedules/:schedule_id",
            get(get_task_schedule_detail)
                .patch(patch_task_schedule_update)
                .delete(delete_task_schedule_record),
        )
        .route("/api/v1/tasks/:task_id/dispatch", post(post_task_dispatch))
        .route("/api/v1/tasks/:task_id/approve", post(post_task_approve))
        .route(
            "/api/v1/tasks/:task_id/approve-review",
            post(post_task_approve),
        )
        .route(
            "/api/v1/tasks/:task_id/approve-completion",
            post(post_task_approve_completion),
        )
        .route(
            "/api/v1/tasks/:task_id/complete/success",
            post(post_task_complete_success),
        )
        .route(
            "/api/v1/tasks/:task_id/complete/failure",
            post(post_task_complete_failure),
        )
        .route(
            "/api/v1/tasks/:task_id/complete/needs-user",
            post(post_task_request_user_intervention),
        )
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
        .route("/api/v1/tasks/:task_id/reassign", post(post_task_reassign))
        .route(
            "/api/v1/tasks/:task_id/manual-whip",
            post(post_task_manual_whip),
        )
        .route(
            "/api/v1/tasks/:task_id/reset-runtime",
            post(post_task_reset_runtime),
        )
        .route("/api/v1/inbox", get(get_inbox_messages))
        .route("/api/v1/inbox/send", post(post_send_inbox_message))
        .route("/api/v1/inbox/read", post(post_mark_inbox_messages_read))
        .route("/api/v1/inbox/archive", post(post_archive_inbox_messages))
        .route(
            "/api/v1/inbox/:delivery_id/read",
            post(post_mark_inbox_read),
        )
        .route(
            "/api/v1/inbox/:delivery_id/archive",
            post(post_archive_inbox_message),
        )
        .route("/api/v1/devices/push-token", post(post_register_push_token))
        .route(
            "/api/v1/sessions",
            get(get_sessions).post(post_session_create),
        )
        .route(
            "/api/v1/sessions/:session_id",
            get(get_session_record).delete(delete_session_record),
        )
        .route(
            "/api/v1/sessions/:session_id/runtime",
            get(get_session_runtime_details),
        )
        .route("/api/v1/sessions/:session_id/stats", get(get_session_stats))
        .route(
            "/api/v1/sessions/:session_id/contextual",
            post(post_contextual_session_create),
        )
        .route(
            "/api/v1/sessions/:session_id/resume",
            post(post_session_resume),
        )
        .route(
            "/api/v1/sessions/:session_id/subscribe",
            post(post_session_subscribe),
        )
        .route(
            "/api/v1/sessions/:session_id/unsubscribe",
            post(post_session_unsubscribe),
        )
        .route(
            "/api/v1/sessions/:session_id/model",
            get(get_session_model_state).post(post_session_model_update),
        )
        .route(
            "/api/v1/sessions/:session_id/compact",
            post(post_session_compact),
        )
        .route(
            "/api/v1/sessions/:session_id/reload",
            post(post_session_reload),
        )
        .route(
            "/api/v1/sessions/:session_id/stop",
            post(post_stop_session_runtime),
        )
        .route("/api/v1/ws", get(ws_handler))
        .layer(cors)
        .with_state(context);

    register_frontend_bootstrap_and_session_routes(
        router,
        app,
        move |session_id, message, run_id| {
            let app = app_for_session_sender.clone();
            async move {
                let state_app = app.clone();
                let state = state_app.state::<AppState>();
                send_session_message_internal(app, state.inner(), session_id, message, run_id).await
            }
        },
    )
}

pub fn run_remote_api_route_probe(case: &str) -> Result<(), String> {
    database::initialize_database()
        .map_err(|error| format!("failed to initialize remote API probe database: {error}"))?;
    let connection = database::open_connection()
        .map_err(|error| format!("failed to open remote API probe database: {error}"))?;
    let pairing = remote_access::create_pairing_code(
        &connection,
        crate::models::RemotePairingCodeInput {
            label: Some("QA Browser".into()),
            platform: Some("test".into()),
        },
    )
    .map_err(|error| format!("failed to create remote API probe pairing code: {error}"))?;
    let auth = remote_access::consume_pairing_code(
        &connection,
        crate::models::RemotePairingCompleteInput {
            code: pairing
                .code
                .clone()
                .ok_or_else(|| "remote API probe pairing code was missing".to_string())?,
            label: Some("QA Browser".into()),
            platform: Some("test".into()),
            push_token: None,
        },
    )
    .map_err(|error| format!("failed to consume remote API probe pairing code: {error}"))?;
    let auth_header = format!("Bearer {}", auth.token);

    let app = tauri::Builder::default()
        .manage(AppState::new(
            crate::services::tool_bridge::dummy_tool_bridge_config(&format!(
                "remote-api-route-probe-{case}"
            )),
        ))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .map_err(|error| format!("failed to build remote API probe app: {error}"))?;
    let router = build_remote_api_context(app.handle().clone());

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("failed to build remote API probe runtime: {error}"))?
        .block_on(async move {
            let std_listener = std::net::TcpListener::bind("127.0.0.1:0")
                .map_err(|error| format!("failed to bind remote API probe listener: {error}"))?;
            std_listener
                .set_nonblocking(true)
                .map_err(|error| format!("failed to configure remote API probe listener: {error}"))?;
            let address = std_listener
                .local_addr()
                .map_err(|error| format!("failed to read remote API probe address: {error}"))?;
            let listener = tokio::net::TcpListener::from_std(std_listener)
                .map_err(|error| format!("failed to adopt remote API probe listener: {error}"))?;
            let (shutdown_tx, shutdown_rx) = oneshot::channel::<()>();
            let server = tokio::spawn(async move {
                axum::serve(listener, router)
                    .with_graceful_shutdown(async {
                        let _ = shutdown_rx.await;
                    })
                    .await
                    .map_err(|error| format!("remote API probe server failed: {error}"))
            });
            let client = reqwest::Client::new();
            let base_url = format!("http://{address}");

            let probe_result = match case {
                "frontend_bootstrap" => {
                    let unauthenticated = client
                        .get(format!("{base_url}{FRONTEND_BOOTSTRAP_ROUTE}"))
                        .header("host", "orchestra.example.test")
                        .header("x-forwarded-proto", "https")
                        .send()
                        .await
                        .map_err(|error| {
                            format!("frontend bootstrap probe request failed: {error}")
                        })?;
                    if unauthenticated.status() != StatusCode::OK {
                        return Err(format!(
                            "frontend bootstrap unauthenticated probe returned {}",
                            unauthenticated.status()
                        ));
                    }
                    let unauthenticated_body: Value = unauthenticated.json().await.map_err(|error| {
                        format!(
                            "frontend bootstrap unauthenticated probe body failed to deserialize: {error}"
                        )
                    })?;
                    if unauthenticated_body["authMode"] != "none"
                        || unauthenticated_body["urls"]["apiBaseUrl"]
                            != "https://orchestra.example.test"
                        || unauthenticated_body["urls"]["websocketUrl"]
                            != "wss://orchestra.example.test/api/v1/ws"
                        || unauthenticated_body["featureFlags"]["sharedSessions"] != false
                        || unauthenticated_body["capabilities"]["sessions"]["write"]["availability"]
                            != "unavailable"
                    {
                        return Err(format!(
                            "frontend bootstrap unauthenticated probe returned unexpected payload: {}",
                            unauthenticated_body
                        ));
                    }

                    let authenticated = client
                        .get(format!("{base_url}{FRONTEND_BOOTSTRAP_ROUTE}"))
                        .header("host", "orchestra.example.test")
                        .header("x-forwarded-proto", "https")
                        .header("authorization", &auth_header)
                        .send()
                        .await
                        .map_err(|error| {
                            format!("frontend bootstrap authenticated probe request failed: {error}")
                        })?;
                    if authenticated.status() != StatusCode::OK {
                        return Err(format!(
                            "frontend bootstrap authenticated probe returned {}",
                            authenticated.status()
                        ));
                    }
                    let authenticated_body: Value = authenticated.json().await.map_err(|error| {
                        format!(
                            "frontend bootstrap authenticated probe body failed to deserialize: {error}"
                        )
                    })?;
                    if authenticated_body["authMode"] != "bearer_token"
                        || authenticated_body["featureFlags"]["sharedSessions"] != true
                        || authenticated_body["capabilities"]["sessions"]["write"]["availability"]
                            != "available"
                    {
                        return Err(format!(
                            "frontend bootstrap authenticated probe returned unexpected payload: {}",
                            authenticated_body
                        ));
                    }
                    Ok(())
                }
                "session_message" => {
                    let response = client
                        .post(format!(
                            "{base_url}{}",
                            SESSION_MESSAGE_ROUTE.replace(":session_id", "session-test")
                        ))
                        .header("content-type", "application/json")
                        .header("authorization", &auth_header)
                        .body(r#"{"message":"hello from remote"}"#)
                        .send()
                        .await
                        .map_err(|error| {
                            format!("session message probe request failed: {error}")
                        })?;
                    if response.status() != StatusCode::BAD_REQUEST {
                        return Err(format!(
                            "session message probe returned {}",
                            response.status()
                        ));
                    }
                    let body: Value = response.json().await.map_err(|error| {
                        format!("session message probe body failed to deserialize: {error}")
                    })?;
                    let error = body["error"]
                        .as_str()
                        .ok_or_else(|| {
                            format!(
                                "session message probe returned non-string error payload: {}",
                                body
                            )
                        })?
                        .to_string();
                    if !error.contains("PI is unavailable") {
                        return Err(format!(
                            "session message probe returned unexpected error: {error}"
                        ));
                    }
                    Ok(())
                }
                "task_list_parity" => {
                    let parity_suffix = uuid::Uuid::new_v4().simple().to_string();
                    let parity_tag = format!("orc65-{}", &parity_suffix[..12]);
                    let mut connection = database::open_connection().map_err(|error| {
                        format!("task list parity probe could not open database: {error}")
                    })?;
                    let project_id = crate::services::projects::require_requested_or_default_project_id(
                        &connection,
                        None,
                        "Task list parity probe requires a default project.",
                    )
                    .map_err(|error| {
                        format!("task list parity probe could not resolve project: {error}")
                    })?;
                    crate::services::tasks::create_task(
                        &mut connection,
                        Some(&project_id),
                        crate::models::TaskUpsertInput {
                            title: format!("Task list parity {}", parity_tag),
                            description: Some("Compare remote task list responses to the Tauri command contract.".into()),
                            task_type: "task".into(),
                            tags: vec![parity_tag.clone(), "orc65".into()],
                            status: "ready".into(),
                            priority: "P2".into(),
                            workflow_id: None,
                            current_lane_id: None,
                            assignee_type: "unassigned".into(),
                            assignee_id: None,
                            repository_id: None,
                            repository_ids: Vec::new(),
                            parent_task_id: None,
                            whip_max_attempts: None,
                            archived: Some(false),
                        },
                    )
                    .map_err(|error| {
                        format!("task list parity probe could not seed task: {error}")
                    })?;
                    drop(connection);

                    let expected = crate::commands::tasks::list_tasks(
                        Some(project_id.clone()),
                        Some(false),
                        Some(vec![parity_tag.clone()]),
                        Some("all".into()),
                        Some("updatedAt".into()),
                        Some("desc".into()),
                    )
                    .map_err(|error| {
                        format!("task list parity probe could not list tasks via command: {error}")
                    })?;
                    let response = client
                        .get(format!(
                            "{base_url}/api/v1/tasks?projectId={project_id}&includeArchived=false&tags={parity_tag}&tagMatch=all&sortBy=updatedAt&sortDirection=desc"
                        ))
                        .header("authorization", &auth_header)
                        .send()
                        .await
                        .map_err(|error| {
                            format!("task list parity probe request failed: {error}")
                        })?;
                    if response.status() != StatusCode::OK {
                        return Err(format!(
                            "task list parity probe returned {}",
                            response.status()
                        ));
                    }
                    let body: Value = response.json().await.map_err(|error| {
                        format!("task list parity probe body failed to deserialize: {error}")
                    })?;
                    let expected_body = serde_json::to_value(expected).map_err(|error| {
                        format!("task list parity probe could not serialize command response: {error}")
                    })?;
                    if body != expected_body {
                        return Err(format!(
                            "task list parity probe returned a different payload than the Tauri command\nroute: {body}\ncommand: {expected_body}"
                        ));
                    }
                    Ok(())
                }
                "inbox_parity" => {
                    let seeded_auth_header = format!("Bearer {}", seed_hosted_web_e2e_fixture()?);
                    let expected = crate::commands::messages::list_inbox_messages(None, Some(true))
                        .map_err(|error| {
                            format!("inbox parity probe could not list inbox via command: {error}")
                        })?;
                    let response = client
                        .get(format!("{base_url}/api/v1/inbox?includeArchived=true"))
                        .header("authorization", &seeded_auth_header)
                        .send()
                        .await
                        .map_err(|error| format!("inbox parity probe request failed: {error}"))?;
                    if response.status() != StatusCode::OK {
                        return Err(format!("inbox parity probe returned {}", response.status()));
                    }
                    let body: Value = response.json().await.map_err(|error| {
                        format!("inbox parity probe body failed to deserialize: {error}")
                    })?;
                    let expected_body = serde_json::to_value(expected).map_err(|error| {
                        format!("inbox parity probe could not serialize command response: {error}")
                    })?;
                    if body != expected_body {
                        return Err(format!(
                            "inbox parity probe returned a different payload than the Tauri command\nroute: {body}\ncommand: {expected_body}"
                        ));
                    }
                    Ok(())
                }
                "sessions_parity" => {
                    let seeded_auth_header = format!("Bearer {}", seed_hosted_web_e2e_fixture()?);
                    let state = app.state::<AppState>();
                    let listed_sessions = list_remote_sessions(state.inner(), None).map_err(|error| {
                        format!("sessions parity probe could not list sessions directly: {error}")
                    })?;
                    let route_sessions = client
                        .get(format!("{base_url}/api/v1/sessions"))
                        .header("authorization", &seeded_auth_header)
                        .send()
                        .await
                        .map_err(|error| format!("sessions parity probe list request failed: {error}"))?;
                    if route_sessions.status() != StatusCode::OK {
                        return Err(format!(
                            "sessions parity probe list returned {}",
                            route_sessions.status()
                        ));
                    }
                    let route_sessions_body: Value = route_sessions.json().await.map_err(|error| {
                        format!("sessions parity probe list body failed to deserialize: {error}")
                    })?;
                    let expected_sessions_body = serde_json::to_value(&listed_sessions).map_err(|error| {
                        format!("sessions parity probe could not serialize direct list response: {error}")
                    })?;
                    if route_sessions_body != expected_sessions_body {
                        return Err(format!(
                            "sessions parity probe list returned a different payload than the direct helper\nroute: {route_sessions_body}\nhelper: {expected_sessions_body}"
                        ));
                    }

                    let first_session_id = listed_sessions
                        .first()
                        .map(|record| record.id.clone())
                        .ok_or_else(|| "sessions parity probe expected at least one seeded session".to_string())?;
                    let direct_record = load_remote_session_record(state.inner(), &first_session_id)
                        .map_err(|error| {
                            format!("sessions parity probe could not load direct session record: {error}")
                        })?;
                    let route_record = client
                        .get(format!("{base_url}/api/v1/sessions/{first_session_id}"))
                        .header("authorization", &seeded_auth_header)
                        .send()
                        .await
                        .map_err(|error| format!("sessions parity probe detail request failed: {error}"))?;
                    if route_record.status() != StatusCode::OK {
                        return Err(format!(
                            "sessions parity probe detail returned {}",
                            route_record.status()
                        ));
                    }
                    let route_record_body: Value = route_record.json().await.map_err(|error| {
                        format!("sessions parity probe detail body failed to deserialize: {error}")
                    })?;
                    let expected_record_body = serde_json::to_value(direct_record).map_err(|error| {
                        format!("sessions parity probe could not serialize direct record: {error}")
                    })?;
                    if route_record_body != expected_record_body {
                        return Err(format!(
                            "sessions parity probe detail returned a different payload than the direct helper\nroute: {route_record_body}\nhelper: {expected_record_body}"
                        ));
                    }
                    Ok(())
                }
                other => Err(format!("unknown remote API route probe case `{other}`")),
            };

            let _ = shutdown_tx.send(());
            let server_result = server
                .await
                .map_err(|error| format!("failed to join remote API probe server: {error}"))?;
            probe_result?;
            server_result?;
            Ok(())
        })
}

const HOSTED_WEB_E2E_PORT: u16 = 4175;

fn resolve_hosted_web_e2e_root() -> Result<PathBuf, String> {
    if let Some(explicit_root) = env::var_os("ORCHESTRA_HOSTED_WEB_E2E_ROOT") {
        let root = PathBuf::from(explicit_root);
        if root.exists() {
            return Ok(root);
        }
        return Err(format!(
            "Hosted-web E2E asset root {} does not exist.",
            root.display()
        ));
    }

    let root = discover_dev_checkout_root()
        .ok_or_else(|| {
            "Unable to locate the Orchestra repository root for hosted-web E2E assets.".to_string()
        })?
        .join("dist");
    if root.exists() {
        return Ok(root);
    }

    Err(format!(
        "Hosted-web E2E frontend assets were missing at {}. Run `VITE_ORCHESTRA_HOST_MODE=hosted_web npm run build` first.",
        root.display()
    ))
}

fn seed_hosted_web_e2e_fixture() -> Result<String, String> {
    let mut connection = database::open_connection()
        .map_err(|error| format!("failed to open hosted-web E2E database: {error}"))?;
    let project_id = projects::require_requested_or_default_project_id(
        &connection,
        None,
        "Hosted-web E2E requires a seeded default project.",
    )?;
    let project_slug = projects::resolve_default_project_slug(&connection)?
        .ok_or_else(|| "Hosted-web E2E could not resolve the default project slug.".to_string())?;

    let _browse_task = tasks::create_task(
        &mut connection,
        Some(&project_id),
        TaskUpsertInput {
            title: "Hosted web seeded task".into(),
            description: Some("Browser-hosted task coverage through the Remote API path.".into()),
            task_type: "task".into(),
            tags: vec!["shared".into(), "browser".into()],
            status: "ready".into(),
            priority: "P1".into(),
            workflow_id: None,
            current_lane_id: None,
            assignee_type: "unassigned".into(),
            assignee_id: None,
            repository_id: None,
            repository_ids: vec![],
            parent_task_id: None,
            whip_max_attempts: Some(10),
            archived: Some(false),
        },
    )?;

    let _attention_task = tasks::create_task(
        &mut connection,
        Some(&project_id),
        TaskUpsertInput {
            title: "Hosted web review task".into(),
            description: Some("Seeded attention task for the hosted-web inbox smoke test.".into()),
            task_type: "task".into(),
            tags: vec!["shared".into(), "review".into()],
            status: "in_review".into(),
            priority: "P2".into(),
            workflow_id: None,
            current_lane_id: None,
            assignee_type: "unassigned".into(),
            assignee_id: None,
            repository_id: None,
            repository_ids: vec![],
            parent_task_id: None,
            whip_max_attempts: Some(10),
            archived: Some(false),
        },
    )?;

    let _message = messages::send_mailbox_message_from_user_without_app(
        &connection,
        SendMailboxMessageInput {
            project_id: Some(project_id.clone()),
            task_id: None,
            recipient_type: "user".into(),
            recipient_id: None,
            sender_label: Some("Hosted Web Seeder".into()),
            body: "Hosted-web inbox message from the seeded Remote API fixture.".into(),
            priority: Some("interrupt".into()),
        },
    )?;

    let context = pi_sessions::detect_session_context(Some(&project_slug))?;
    let stored_session = pi_sessions::create_session_file(
        &context.project_root,
        &context.session_dir,
        Some("Hosted web seeded session"),
        true,
    )?;
    let session_path =
        pi_sessions::get_session_path(&context.session_dir, &stored_session.record.id)?;
    let mut session_file = OpenOptions::new()
        .append(true)
        .open(&session_path)
        .map_err(|error| {
            format!(
                "Unable to append hosted-web E2E session {}: {error}",
                session_path.display()
            )
        })?;
    writeln!(
        session_file,
        "{}",
        json!({
            "type": "message",
            "id": "hosted-web-user-message",
            "parentId": Value::Null,
            "timestamp": now_iso(),
            "message": {
                "role": "user",
                "content": "Hello from hosted-web E2E",
                "timestamp": 1773835260000i64,
                "attachments": [],
            }
        })
    )
    .map_err(|error| format!("Unable to write hosted-web E2E user message: {error}"))?;
    writeln!(
        session_file,
        "{}",
        json!({
            "type": "message",
            "id": "hosted-web-assistant-message",
            "parentId": "hosted-web-user-message",
            "timestamp": now_iso(),
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": "Hosted web reply from the seeded Remote API session." }],
                "api": "test",
                "provider": "test",
                "model": "stub",
                "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                "stopReason": "stop",
                "timestamp": 1773835261000i64,
            }
        })
    )
    .map_err(|error| format!("Unable to write hosted-web E2E assistant message: {error}"))?;
    session_file
        .flush()
        .map_err(|error| format!("Unable to flush hosted-web E2E session fixture: {error}"))?;

    let pairing = remote_access::create_pairing_code(
        &connection,
        crate::models::RemotePairingCodeInput {
            label: Some("Hosted Web Browser".into()),
            platform: Some("browser".into()),
        },
    )?;
    let auth = remote_access::consume_pairing_code(
        &connection,
        RemotePairingCompleteInput {
            code: pairing
                .code
                .clone()
                .ok_or_else(|| "Hosted-web E2E pairing code was missing.".to_string())?,
            label: Some("Hosted Web Browser".into()),
            platform: Some("browser".into()),
            push_token: None,
        },
    )?;

    Ok(auth.token)
}

pub fn run_hosted_web_e2e_server() -> Result<(), String> {
    let backend = crate::services::backend_bootstrap::initialize_backend()?;
    let app = tauri::Builder::default()
        .manage(AppState::new(backend.tool_bridge.clone()))
        .build(tauri::test::mock_context(tauri::test::noop_assets()))
        .map_err(|error| format!("failed to build hosted-web E2E app: {error}"))?;
    let auth_token = seed_hosted_web_e2e_fixture()?;
    let auth_cookie = build_remote_auth_cookie(&auth_token, false)
        .map_err(|error| format!("failed to build hosted-web E2E auth cookie: {error}"))?;
    let root = resolve_hosted_web_e2e_root()?;
    let index_file = root.join("index.html");
    if !index_file.exists() {
        return Err(format!(
            "Hosted-web E2E index file was missing at {}.",
            index_file.display()
        ));
    }

    let app_handle = app.handle().clone();
    let router = build_remote_api_context(app_handle)
        .route(
            "/",
            get({
                let auth_cookie = auth_cookie.clone();
                let index_file = index_file.clone();
                move || {
                    let auth_cookie = auth_cookie.clone();
                    let index_file = index_file.clone();
                    async move {
                        let html = fs::read_to_string(&index_file).map_err(|error| {
                            api_error(
                                StatusCode::INTERNAL_SERVER_ERROR,
                                format!(
                                    "Unable to read hosted-web E2E frontend {}: {error}",
                                    index_file.display()
                                ),
                            )
                        })?;
                        let mut response = axum::response::Html(html).into_response();
                        response
                            .headers_mut()
                            .insert(header::SET_COOKIE, auth_cookie.clone());
                        Ok::<_, (StatusCode, Json<ApiError>)>(response)
                    }
                }
            }),
        )
        .fallback_service(get_service(
            ServeDir::new(root).not_found_service(ServeFile::new(index_file)),
        ));

    let port = env::var("ORCHESTRA_HOSTED_WEB_E2E_PORT")
        .ok()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(HOSTED_WEB_E2E_PORT);
    let bind_address = format!("127.0.0.1:{port}");
    let listener = TcpListener::bind(&bind_address).map_err(|error| {
        format!("Unable to bind hosted-web E2E server on {bind_address}: {error}")
    })?;
    listener
        .set_nonblocking(true)
        .map_err(|error| format!("Unable to configure hosted-web E2E listener: {error}"))?;

    println!("Hosted-web E2E server ready at http://{bind_address}");

    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| format!("Unable to build hosted-web E2E runtime: {error}"))?
        .block_on(async move {
            let listener = tokio::net::TcpListener::from_std(listener)
                .map_err(|error| format!("Unable to adopt hosted-web E2E listener: {error}"))?;
            axum::serve(listener, router)
                .await
                .map_err(|error| format!("Hosted-web E2E server failed: {error}"))
        })
}

fn resolve_mobile_web_root(app: &AppHandle) -> Result<PathBuf, String> {
    let bundled = app
        .path()
        .resolve("mobile-web", BaseDirectory::Resource)
        .map_err(|error| format!("Unable to resolve packaged mobile web assets: {error}"))?;
    if bundled.exists() {
        return Ok(bundled);
    }

    let repo = discover_dev_checkout_root().map(|root| root.join("mobile/dist-web"));
    if let Some(repo_path) = repo.as_ref().filter(|path| path.exists()) {
        return Ok(repo_path.to_path_buf());
    }

    let repo_display = repo
        .as_ref()
        .map(|path| path.display().to_string())
        .unwrap_or_else(|| "<no development checkout detected>".into());

    Err(format!(
        "Unable to locate Orchestra web driver assets. Expected {} or {}. Run `cd mobile && npm install && npm run web:build` before enabling Tailscale support.",
        bundled.display(),
        repo_display
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

fn websocket_url_from_base_url(base_url: &str) -> String {
    format!(
        "{}/api/v1/ws",
        base_url
            .replacen("https://", "wss://", 1)
            .replacen("http://", "ws://", 1)
    )
}

fn extract_cookie_value(headers: &HeaderMap, name: &str) -> Option<String> {
    headers
        .get(header::COOKIE)
        .and_then(|value| value.to_str().ok())
        .and_then(|value| {
            value.split(';').find_map(|segment| {
                let (cookie_name, cookie_value) = segment.trim().split_once('=')?;
                if cookie_name == name {
                    let trimmed = cookie_value.trim();
                    if trimmed.is_empty() {
                        None
                    } else {
                        Some(trimmed.to_string())
                    }
                } else {
                    None
                }
            })
        })
}

fn build_remote_auth_candidate(
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Option<RemoteAuthCandidate> {
    extract_cookie_value(headers, REMOTE_AUTH_COOKIE_NAME)
        .map(|token| RemoteAuthCandidate {
            source: RemoteAuthSource::SameOriginCookie,
            token,
        })
        .or_else(|| {
            headers
                .get("authorization")
                .and_then(|value| value.to_str().ok())
                .and_then(|value| value.strip_prefix("Bearer "))
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|token| RemoteAuthCandidate {
                    source: RemoteAuthSource::BearerToken,
                    token: token.to_string(),
                })
        })
        .or_else(|| {
            query_token
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(|token| RemoteAuthCandidate {
                    source: RemoteAuthSource::QueryToken,
                    token: token.to_string(),
                })
        })
}

fn authenticate_remote_auth_candidate<R: Runtime>(
    app: &AppHandle<R>,
    candidate: RemoteAuthCandidate,
) -> Result<ResolvedRemoteAuth, String> {
    let connection = database::open_connection()?;
    let device = remote_access::authenticate_token(&connection, &candidate.token)?;
    app.state::<AppState>().log(
        "info",
        "remote.api.auth",
        &format!(
            "Authenticated remote device {} ({}) via {:?}",
            device.label, device.id, candidate.source
        ),
    );
    Ok(ResolvedRemoteAuth {
        source: candidate.source,
        token: candidate.token,
        device,
    })
}

#[cfg(test)]
fn resolve_test_remote_auth(headers: &HeaderMap) -> Option<ResolvedRemoteAuth> {
    headers
        .get("x-orchestra-test-remote-auth")
        .and_then(|value| value.to_str().ok())
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(|label| {
            let now = now_iso();
            ResolvedRemoteAuth {
                source: RemoteAuthSource::BearerToken,
                token: "test-remote-token".into(),
                device: RemoteDeviceRecord {
                    id: "remote-device-test".into(),
                    label: label.to_string(),
                    platform: "test".into(),
                    created_at: now.clone(),
                    updated_at: now.clone(),
                    last_seen_at: Some(now),
                    revoked_at: None,
                    push_token_configured: false,
                    active_client_count: 0,
                },
            }
        })
}

fn resolve_optional_remote_auth<R: Runtime>(
    app: &AppHandle<R>,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Option<ResolvedRemoteAuth> {
    #[cfg(test)]
    if let Some(auth) = resolve_test_remote_auth(headers) {
        return Some(auth);
    }

    let candidate = build_remote_auth_candidate(headers, query_token)?;
    authenticate_remote_auth_candidate(app, candidate).ok()
}

fn resolve_remote_auth<R: Runtime>(
    app: &AppHandle<R>,
    headers: &HeaderMap,
    query_token: Option<&str>,
) -> Result<ResolvedRemoteAuth, (StatusCode, Json<ApiError>)> {
    #[cfg(test)]
    if let Some(auth) = resolve_test_remote_auth(headers) {
        return Ok(auth);
    }

    let candidate = build_remote_auth_candidate(headers, query_token)
        .ok_or_else(|| api_error(StatusCode::UNAUTHORIZED, "Missing remote device token"))?;
    authenticate_remote_auth_candidate(app, candidate)
        .map_err(|error| api_error(StatusCode::UNAUTHORIZED, error))
}

fn auth_mode_for_remote_auth(auth: Option<&ResolvedRemoteAuth>) -> OrchestraClientAuthMode {
    match auth.map(|auth| auth.source) {
        Some(RemoteAuthSource::SameOriginCookie) => OrchestraClientAuthMode::SameOriginCookie,
        Some(RemoteAuthSource::BearerToken | RemoteAuthSource::QueryToken) => {
            OrchestraClientAuthMode::BearerToken
        }
        None => OrchestraClientAuthMode::None,
    }
}

fn build_remote_auth_cookie(token: &str, secure: bool) -> Result<HeaderValue, String> {
    let mut cookie = format!(
        "{REMOTE_AUTH_COOKIE_NAME}={token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=31536000"
    );
    if secure {
        cookie.push_str("; Secure");
    }
    HeaderValue::from_str(&cookie)
        .map_err(|error| format!("Unable to build remote auth cookie header: {error}"))
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
        let chosen_websocket_url = websocket_url_from_base_url(&chosen_base_url);
        response.base_url = Some(chosen_base_url);
        response.websocket_url = Some(if chosen_websocket_url.is_empty() {
            websocket_url
        } else {
            chosen_websocket_url
        });
    }
    Ok(response)
}

fn available_capability() -> OrchestraCapabilityDescriptor {
    OrchestraCapabilityDescriptor {
        availability: OrchestraCapabilityAvailability::Available,
        reason: None,
    }
}

fn unavailable_capability(reason: impl Into<String>) -> OrchestraCapabilityDescriptor {
    OrchestraCapabilityDescriptor {
        availability: OrchestraCapabilityAvailability::Unavailable,
        reason: Some(reason.into()),
    }
}

fn auth_guarded_capability(
    authenticated: bool,
    available_when_authenticated: bool,
    unavailable_reason: &str,
) -> OrchestraCapabilityDescriptor {
    if !authenticated {
        return unavailable_capability("Authentication required.");
    }
    if available_when_authenticated {
        available_capability()
    } else {
        unavailable_capability(unavailable_reason)
    }
}

fn build_frontend_feature_flags(authenticated: bool) -> OrchestraClientFeatureFlags {
    OrchestraClientFeatureFlags {
        shared_catalog: authenticated,
        shared_tasks: authenticated,
        shared_inbox: authenticated,
        shared_sessions: authenticated,
        task_schedules: authenticated,
        session_streaming: authenticated,
        session_controls: authenticated,
        task_comments: authenticated,
        task_files: authenticated,
        desktop_windows: false,
        agent_terminal: false,
    }
}

fn build_frontend_capabilities(authenticated: bool) -> OrchestraClientCapabilities {
    OrchestraClientCapabilities {
        app: OrchestraClientAppCapabilities {
            bootstrap: available_capability(),
            error_reporting: auth_guarded_capability(
                authenticated,
                true,
                "Hosted-web client error reporting is unavailable without remote authentication.",
            ),
        },
        catalog: OrchestraClientCatalogCapabilities {
            projects: auth_guarded_capability(authenticated, true, "Remote project endpoints are unavailable."),
            agents: auth_guarded_capability(authenticated, true, "Remote agent endpoints are unavailable."),
            roles: auth_guarded_capability(authenticated, true, "Remote role endpoints are unavailable."),
            workflows: auth_guarded_capability(authenticated, true, "Remote workflow endpoints are unavailable."),
        },
        admin: OrchestraClientAdminCapabilities {
            projects: auth_guarded_capability(
                authenticated,
                true,
                "Remote project administration endpoints are unavailable.",
            ),
            settings: auth_guarded_capability(
                authenticated,
                true,
                "Remote settings endpoints are unavailable.",
            ),
            workers: auth_guarded_capability(
                authenticated,
                true,
                "Remote worker administration endpoints are unavailable.",
            ),
            workflows: auth_guarded_capability(
                authenticated,
                true,
                "Remote workflow administration endpoints are unavailable.",
            ),
            policies: auth_guarded_capability(
                authenticated,
                true,
                "Remote policy endpoints are unavailable.",
            ),
            channels: auth_guarded_capability(
                authenticated,
                true,
                "Remote channel endpoints are unavailable.",
            ),
            model_catalog: auth_guarded_capability(
                authenticated,
                true,
                "Remote model catalog endpoints are unavailable.",
            ),
            pi_executable_diagnostic: unavailable_capability(
                "Local Pi executable diagnostics are only available in the desktop app.",
            ),
        },
        tasks: OrchestraClientTaskCapabilities {
            read: auth_guarded_capability(authenticated, true, "Remote task read endpoints are unavailable."),
            write: auth_guarded_capability(authenticated, true, "Remote task mutation endpoints are unavailable."),
            review: auth_guarded_capability(authenticated, true, "Remote task review endpoints are unavailable."),
            comments: auth_guarded_capability(authenticated, true, "Remote task comment endpoints are unavailable."),
            todos: auth_guarded_capability(authenticated, true, "Remote task todo endpoints are unavailable."),
            dependencies: auth_guarded_capability(authenticated, true, "Remote task dependency endpoints are unavailable."),
            attachments: auth_guarded_capability(authenticated, true, "Remote task attachment endpoints are unavailable."),
            file_references: auth_guarded_capability(authenticated, true, "Remote task file-reference endpoints are unavailable."),
            file_contents: auth_guarded_capability(authenticated, true, "Remote task file-content endpoints are unavailable."),
            schedules: auth_guarded_capability(authenticated, true, "Remote task schedule endpoints are unavailable."),
        },
        inbox: OrchestraClientInboxCapabilities {
            read: auth_guarded_capability(authenticated, true, "Remote inbox read endpoints are unavailable."),
            write: auth_guarded_capability(authenticated, true, "Remote inbox send endpoints are unavailable."),
            archive: auth_guarded_capability(authenticated, true, "Remote inbox archive endpoints are unavailable."),
        },
        sessions: OrchestraClientSessionCapabilities {
            read: auth_guarded_capability(authenticated, true, "Remote session read endpoints are unavailable."),
            write: auth_guarded_capability(authenticated, true, "Remote session write endpoints are unavailable."),
            stream: auth_guarded_capability(authenticated, true, "Remote session stream endpoints are unavailable."),
            runtime_controls: auth_guarded_capability(authenticated, true, "Remote session runtime-control endpoints are unavailable."),
            model_selection: auth_guarded_capability(authenticated, true, "Remote session model-selection endpoints are unavailable."),
        },
        host: OrchestraClientHostCapabilities {
            logs_window: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
            agent_terminal: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
            system_notifications: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
            bridge_diagnostics: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
            runtime_logs: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
            harness_settings: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
            remote_access: unavailable_capability(
                "This capability is only available when the shared frontend is hosted inside the Tauri desktop shell.",
            ),
        },
    }
}

fn resolve_frontend_transport_urls(
    state: &AppState,
    headers: &HeaderMap,
) -> Result<OrchestraClientTransportUrls, String> {
    if let Some((_, _, base_url, websocket_url, lan_base_url, _)) =
        state.remote_server_snapshot()?
    {
        let chosen_base_url = request_base_url_from_headers(headers)
            .or(lan_base_url)
            .unwrap_or(base_url);
        let chosen_websocket_url = websocket_url_from_base_url(&chosen_base_url);
        return Ok(OrchestraClientTransportUrls {
            api_base_url: Some(chosen_base_url),
            websocket_url: Some(if chosen_websocket_url.is_empty() {
                websocket_url
            } else {
                chosen_websocket_url
            }),
        });
    }

    let api_base_url = request_base_url_from_headers(headers);
    let websocket_url = api_base_url.as_deref().map(websocket_url_from_base_url);
    Ok(OrchestraClientTransportUrls {
        api_base_url,
        websocket_url,
    })
}

fn build_frontend_bootstrap_from_auth(
    state: &AppState,
    headers: &HeaderMap,
    auth: Option<&ResolvedRemoteAuth>,
) -> Result<OrchestraClientBootstrap, String> {
    let authenticated = auth.is_some();
    Ok(OrchestraClientBootstrap {
        contract_version: ORCHESTRA_CLIENT_CONTRACT_VERSION.to_string(),
        bootstrapped_at: now_iso(),
        host_kind: OrchestraClientHostKind::RemoteApi,
        auth_mode: auth_mode_for_remote_auth(auth),
        urls: resolve_frontend_transport_urls(state, headers)?,
        feature_flags: build_frontend_feature_flags(authenticated),
        capabilities: build_frontend_capabilities(authenticated),
        app_info: Some(build_app_info()),
    })
}

fn build_frontend_bootstrap<R: Runtime>(
    app: &AppHandle<R>,
    headers: &HeaderMap,
) -> Result<OrchestraClientBootstrap, String> {
    let state = app.state::<AppState>();
    let auth = resolve_optional_remote_auth(app, headers, None);
    build_frontend_bootstrap_from_auth(state.inner(), headers, auth.as_ref())
}

fn prepare_session_message_request<R: Runtime>(
    app: &AppHandle<R>,
    headers: &HeaderMap,
    input: SessionMessageInput,
) -> Result<(String, Option<String>), (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(app, headers, None)?;
    let trimmed_message = session_commands::validate_session_message_request(
        app.state::<AppState>().inner(),
        input.message,
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    Ok((trimmed_message, input.run_id))
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
    requested_run_id: Option<String>,
) -> Result<QueuedSessionMessage, String> {
    session_commands::send_session_message_with_optional_run_id(
        app,
        state,
        session_id,
        message,
        requested_run_id,
    )
    .await
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

async fn get_remote_app_info(AxumState(_context): AxumState<RemoteApiContext>) -> Json<AppInfo> {
    Json(build_app_info())
}

fn frontend_bootstrap_response<R: Runtime>(
    app: &AppHandle<R>,
    headers: HeaderMap,
) -> Result<Json<OrchestraClientBootstrap>, (StatusCode, Json<ApiError>)> {
    build_frontend_bootstrap(app, &headers)
        .map(Json)
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))
}

async fn post_pair_complete(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<RemotePairingCompleteInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
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
    let secure_cookie = request_base_url_from_headers(&headers)
        .map(|base_url| base_url.starts_with("https://"))
        .unwrap_or(false);
    let mut response_headers = HeaderMap::new();
    response_headers.insert(
        header::SET_COOKIE,
        build_remote_auth_cookie(&response.token, secure_cookie)
            .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?,
    );
    Ok((response_headers, Json(response)))
}

async fn post_client_error_report(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<ClientErrorReportInput>,
) -> Result<StatusCode, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    report_client_error(context.app.state::<AppState>(), input.target, input.message);
    Ok(StatusCode::ACCEPTED)
}

async fn get_pi_model_catalog(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    list_pi_models(context.app.state::<AppState>())
        .await
        .map(Json)
        .map_err(command_api_error)
}

async fn get_global_source_control_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    get_source_control_settings()
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_global_source_control_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<SourceControlSettingsPatchInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    update_source_control_settings(input.git_user_name_template, input.git_email_template)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_project_session_prompt_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectSlugQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::get_session_prompt_settings(query.project_slug)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_project_session_prompt_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<SessionPromptSettingsPatchInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::update_session_prompt_settings(input.project_slug, input.template)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_project_task_automation_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectSlugQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::get_task_automation_settings(query.project_slug)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_project_task_automation_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<TaskAutomationSettingsPatchInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::update_task_automation_settings(
        input.project_slug,
        input.auto_dispatch_on_blocker_completion,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_project_source_control_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectSlugQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::get_project_source_control_settings(query.project_slug)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_project_source_control_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<ProjectSourceControlSettingsPatchInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::update_project_source_control_settings(
        input.project_slug,
        input.git_user_name_template,
        input.git_email_template,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_worker_overlay_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<WorkerOverlayQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::get_worker_overlay(
        query.project_slug,
        query.worker_type,
        query.worker_slug,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn patch_worker_overlay_settings(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<WorkerOverlayPatchInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_setting_commands::update_worker_overlay(
        input.project_slug,
        input.worker_type,
        input.worker_slug,
        input.prompt,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_project_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<ProjectUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::create_project(context.app.state::<AppState>(), input)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_project_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::get_project(project_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_project_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<ProjectUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::update_project(context.app.state::<AppState>(), project_id, input)
        .map(Json)
        .map_err(command_api_error)
}

async fn delete_project_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::delete_project(context.app.state::<AppState>(), project_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_project_repositories(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::list_repositories(Some(project_id))
        .map(Json)
        .map_err(command_api_error)
}

async fn post_project_repository_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<RepositoryUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::create_repository(context.app.state::<AppState>(), project_id, input)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_project_default_repository(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(project_id): Path<String>,
    Json(input): Json<DefaultRepositoryInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::set_project_default_repository(
        context.app.state::<AppState>(),
        project_id,
        input.repository_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_repositories(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectScopedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::list_repositories(query.project_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_repository_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(repository_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::get_repository(repository_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_repository_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(repository_id): Path<String>,
    Json(input): Json<RepositoryUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::update_repository(context.app.state::<AppState>(), repository_id, input)
        .map(Json)
        .map_err(command_api_error)
}

async fn delete_repository_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(repository_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::delete_repository(context.app.state::<AppState>(), repository_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_repository_attach_remote(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(repository_id): Path<String>,
    Json(input): Json<RepositoryRemoteInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    project_commands::attach_repository_remote(
        context.app.state::<AppState>(),
        repository_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_agents(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<CatalogListQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_commands::list_agents(query.include_archived, query.project_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_validate_agent(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<AgentUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_commands::validate_agent(input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_agent_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<AgentUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_commands::create_agent(context.app.state::<AppState>(), input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_agent_operations(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<CatalogListQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_runtime_commands::list_agent_operations(
        context.app.state::<AppState>(),
        query.include_archived,
        query.project_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_enqueue_agent_work(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<AgentQueueEntryInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_runtime_commands::enqueue_agent_work(context.app.state::<AppState>(), input)
        .map(Json)
        .map_err(command_api_error)
}

async fn delete_agent_queue_entry(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(queue_entry_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_runtime_commands::delete_agent_queue_entry(
        context.app.state::<AppState>(),
        queue_entry_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_agent_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_commands::get_agent(agent_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_agent_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Json(input): Json<AgentUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_commands::update_agent(context.app.state::<AppState>(), agent_id, input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_archive_agent(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_commands::archive_agent(context.app.state::<AppState>(), agent_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_agent_operation_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Query(query): Query<ProjectScopedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_runtime_commands::get_agent_operations(
        context.app.state::<AppState>(),
        agent_id,
        query.project_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_agent_permissions(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    policy_commands::get_agent_permissions(agent_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_ensure_agent_session(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(agent_id): Path<String>,
    Query(query): Query<ProjectScopedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    agent_runtime_commands::ensure_agent_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        agent_id,
        query.project_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn get_roles(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<IncludeArchivedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_commands::list_roles(query.include_archived, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_validate_role(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<RoleUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_commands::validate_role(input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_role_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<RoleUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_commands::create_role(context.app.state::<AppState>(), input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_role_operations(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<IncludeArchivedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_runtime_commands::list_role_operations(query.include_archived, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_enqueue_role_work(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<RoleQueueEntryInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_runtime_commands::enqueue_role_work(context.app.state::<AppState>(), input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn delete_role_queue_entry(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(queue_entry_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_runtime_commands::delete_role_queue_entry(
        context.app.state::<AppState>(),
        queue_entry_id,
        None,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_role_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_commands::get_role(role_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_role_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
    Json(input): Json<RoleUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_commands::update_role(context.app.state::<AppState>(), role_id, input, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_archive_role(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_commands::archive_role(context.app.state::<AppState>(), role_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_role_operation_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_runtime_commands::get_role_operations(role_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_role_permissions(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    policy_commands::get_role_permissions(role_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_dispatch_role_queue(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_dispatch_commands::dispatch_role_queue(context.app.state::<AppState>(), role_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_reset_role_assignments(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(role_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_dispatch_commands::reset_role_assignments(
        context.app.clone(),
        context.app.state::<AppState>(),
        role_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_role_instance_permissions(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    policy_commands::get_role_instance_permissions(instance_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_release_role_instance(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
    Json(input): Json<ReleaseRoleInstanceInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_dispatch_commands::release_role_instance(
        context.app.state::<AppState>(),
        instance_id,
        input.outcome,
        input.error_message,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_dispose_role_instance(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(instance_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    role_dispatch_commands::dispose_role_instance(context.app.state::<AppState>(), instance_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_workflows(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<IncludeArchivedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::list_workflows(query.include_archived)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_validate_workflow(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<WorkflowUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::validate_workflow(input)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_workflow_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<WorkflowUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::create_workflow(context.app.state::<AppState>(), input)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_workflow_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::get_workflow(workflow_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_workflow_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
    Json(input): Json<WorkflowUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::update_workflow(context.app.state::<AppState>(), workflow_id, input)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_workflow_delete_impact(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::get_workflow_delete_impact(workflow_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn delete_workflow_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::delete_workflow(context.app.state::<AppState>(), workflow_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_archive_workflow(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::archive_workflow(context.app.state::<AppState>(), workflow_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_duplicate_workflow(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
    Json(input): Json<DuplicateWorkflowInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::duplicate_workflow(
        context.app.state::<AppState>(),
        workflow_id,
        input.new_name,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_workflow_lane_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
    Json(input): Json<WorkflowLaneInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::add_workflow_lane(context.app.state::<AppState>(), workflow_id, input)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_workflow_lane_reorder(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(workflow_id): Path<String>,
    Json(input): Json<WorkflowLaneReorderInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::reorder_workflow_lanes(context.app.state::<AppState>(), workflow_id, input)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_workflow_lane(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path((workflow_id, lane_id)): Path<(String, String)>,
    Json(input): Json<WorkflowLanePatchInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::update_workflow_lane(
        context.app.state::<AppState>(),
        workflow_id,
        lane_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_workflow_lane(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path((workflow_id, lane_id)): Path<(String, String)>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    workflow_commands::delete_workflow_lane(context.app.state::<AppState>(), workflow_id, lane_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_policies(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    policy_commands::list_policies(None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_policy_orchestra_tools(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    policy_commands::list_orchestra_tools(None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_policy_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(policy_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    policy_commands::get_policy(policy_id, None)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_channels(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::list_channels()
        .map(Json)
        .map_err(command_api_error)
}

async fn post_channel_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<ChannelUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::create_channel(context.app.clone(), context.app.state::<AppState>(), input)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_validate_telegram_bot(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<TelegramBotValidationInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::validate_telegram_bot(
        context.app.state::<AppState>(),
        input.bot_token,
        input.api_base_url,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_list_telegram_chat_candidates(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<TelegramBotValidationInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::list_telegram_chat_candidates(
        context.app.state::<AppState>(),
        input.bot_token,
        input.api_base_url,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_channel_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::get_channel(channel_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_channel_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Json(input): Json<ChannelUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::update_channel(
        context.app.clone(),
        context.app.state::<AppState>(),
        channel_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_channel_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::delete_channel(
        context.app.clone(),
        context.app.state::<AppState>(),
        channel_id,
    )
    .map(|_| StatusCode::NO_CONTENT)
    .map_err(command_api_error)
}

async fn get_channel_activity(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(channel_id): Path<String>,
    Query(query): Query<LimitQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    channel_commands::list_channel_activity(channel_id, query.limit)
        .map(Json)
        .map_err(command_api_error)
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
    Query(query_params): Query<TaskListQueryParams>,
) -> Result<Json<Vec<TaskSummary>>, (StatusCode, Json<ApiError>)> {
    let _device = resolve_remote_auth(&context.app, &headers, None)?;
    let connection = database::open_connection()
        .map_err(|error| api_error(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    let tags = query_params
        .tags
        .as_deref()
        .map(|raw| raw.split(',').map(str::to_string).collect::<Vec<_>>());
    let query = tasks::TaskListQuery::from_raw(
        query_params.include_archived,
        tags,
        query_params.tag_match.as_deref(),
        query_params.sort_by.as_deref(),
        query_params.sort_direction.as_deref(),
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    tasks::list_tasks_with_query(&connection, &project_id, query)
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

async fn get_tasks(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<TaskListQueryParams>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::list_tasks(
        query.project_id,
        query.include_archived,
        split_tag_filters(query.tags.as_deref()),
        query.tag_match,
        query.sort_by,
        query.sort_direction,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectScopedQuery>,
    Json(input): Json<TaskUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::create_task(
        context.app.clone(),
        context.app.state::<AppState>(),
        query.project_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn patch_task_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<TaskUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::update_task(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_task_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::delete_task(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_subtask_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<TaskUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::create_subtask(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_todos(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::list_task_todos(task_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_unfinished_task_todos(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Query(query): Query<LaneScopedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::list_unfinished_task_todos(task_id, query.lane_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_task_todo_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<TaskTodoInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::add_task_todo(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_todo_finish(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(todo_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::mark_task_todo_finished(
        context.app.clone(),
        context.app.state::<AppState>(),
        todo_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_todo_unfinish(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(todo_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::mark_task_todo_unfinished(
        context.app.clone(),
        context.app.state::<AppState>(),
        todo_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_task_todo_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(todo_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::delete_task_todo(
        context.app.clone(),
        context.app.state::<AppState>(),
        todo_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_comments(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::list_task_comments(task_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_task_comment_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<TaskCommentInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::comment_on_task(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_comments_read(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::mark_task_comments_read_for_user(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_comment_file_mentions(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Query(query): Query<CommentFileMentionQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::search_task_comment_file_mentions(task_id, query.query, query.limit)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_task_comment(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(comment_id): Path<String>,
    Json(input): Json<TaskCommentUpdateInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::update_task_comment(
        context.app.clone(),
        context.app.state::<AppState>(),
        comment_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_task_comment_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(comment_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::delete_task_comment(
        context.app.clone(),
        context.app.state::<AppState>(),
        comment_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_messages(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    message_commands::list_task_messages(task_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_task_dependency_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<TaskDependencyInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::add_task_dependency(
        context.app.clone(),
        context.app.state::<AppState>(),
        input.blocker_task_id,
        input.blocked_task_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_task_dependency_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(dependency_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::remove_task_dependency(
        context.app.clone(),
        context.app.state::<AppState>(),
        dependency_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_repositories(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::list_task_repositories(task_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn get_task_file_references(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::list_task_file_references(task_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_task_file_reference_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<TaskFileReferenceInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::add_task_file_reference(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_default_task_file_reference(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(reference_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::set_default_task_file_reference(reference_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn delete_task_file_reference_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(reference_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::remove_task_file_reference(
        context.app.clone(),
        context.app.state::<AppState>(),
        reference_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_file_content_route(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<FileContentQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::get_task_file_content(query.path).map_err(command_api_error)
}

async fn post_task_attachment_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<TaskAttachmentInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::add_task_attachment(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_task_attachment_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(attachment_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::remove_task_attachment(
        context.app.clone(),
        context.app.state::<AppState>(),
        attachment_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_schedules(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectScopedQuery>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_schedule_commands::list_task_schedules(query.project_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn post_task_schedule_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Query(query): Query<ProjectScopedQuery>,
    Json(input): Json<TaskScheduleUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    let connection = database::open_connection().map_err(internal_api_error)?;
    let project_id = projects::require_requested_or_default_project_id(
        &connection,
        query.project_id.as_deref(),
        "Create a project first before adding schedules.",
    )
    .map_err(command_api_error)?;
    task_schedule_commands::create_task_schedule(
        context.app.clone(),
        context.app.state::<AppState>(),
        project_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_task_schedule_detail(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_schedule_commands::get_task_schedule(schedule_id)
        .map(Json)
        .map_err(command_api_error)
}

async fn patch_task_schedule_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
    Json(input): Json<TaskScheduleUpsertInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_schedule_commands::update_task_schedule(
        context.app.clone(),
        context.app.state::<AppState>(),
        schedule_id,
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_task_schedule_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(schedule_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_schedule_commands::delete_task_schedule(
        context.app.clone(),
        context.app.state::<AppState>(),
        schedule_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_dispatch(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::dispatch_task_lane(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_complete_success(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    input: Option<Json<NotesInput>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::complete_lane_as_success(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input.and_then(|Json(notes)| notes.notes),
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_complete_failure(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    input: Option<Json<NotesInput>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::complete_lane_as_failure(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input.and_then(|Json(notes)| notes.notes),
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_request_user_intervention(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    input: Option<Json<NotesInput>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::request_user_intervention(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input.and_then(|Json(notes)| notes.notes),
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_approve_completion(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::approve_lane_completion(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_reassign(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    Json(input): Json<ReassignTaskInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::reassign_task_to_lane(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
        input.lane_id,
        input.notes,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_manual_whip(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::manual_task_whip(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_task_reset_runtime(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    task_commands::reset_task_runtime(task_id)
        .map(Json)
        .map_err(command_api_error)
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
        &format!("{} approved task {}", device.device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_needs_work(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    notes: Option<Json<NotesInput>>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::mark_task_needs_work(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        notes.and_then(|Json(input)| input.notes),
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.needs_work",
        &format!(
            "{} sent task {} back for work",
            device.device.label, task_id
        ),
    );
    Ok(Json(task))
}

async fn post_task_resume(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    notes: Option<Json<NotesInput>>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::resume_task_lane(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        notes.and_then(|Json(input)| input.notes),
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.resume",
        &format!("{} resumed task {}", device.device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_pause(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    notes: Option<Json<NotesInput>>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::pause_task_lane(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        notes.and_then(|Json(input)| input.notes),
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.pause",
        &format!("{} paused task {}", device.device.label, task_id),
    );
    Ok(Json(task))
}

async fn post_task_stop_activity(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(task_id): Path<String>,
    notes: Option<Json<NotesInput>>,
) -> Result<Json<TaskDetail>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let task = task_commands::stop_task_activity(
        context.app.clone(),
        context.app.state::<AppState>(),
        task_id.clone(),
        notes.and_then(|Json(input)| input.notes),
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.task.stop_activity",
        &format!(
            "{} stopped task activity for {}",
            device.device.label, task_id
        ),
    );
    Ok(Json(task))
}

async fn post_mark_inbox_messages_read(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<MarkMailboxMessagesReadInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    message_commands::mark_mailbox_messages_read(
        context.app.clone(),
        context.app.state::<AppState>(),
        input,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn post_archive_inbox_messages(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Json(input): Json<ArchiveMailboxMessagesInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    message_commands::archive_mailbox_messages(
        context.app.clone(),
        context.app.state::<AppState>(),
        input,
    )
    .map(Json)
    .map_err(command_api_error)
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
            sender_label: Some(device.device.label),
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
    let updated = remote_access::set_device_push_token(
        &connection,
        &device.device.id,
        input.push_token.as_deref(),
    )
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    Ok(Json(updated))
}

async fn post_session_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    input: Option<Json<SessionCreateInput>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    let input = input
        .map(|Json(value)| value)
        .unwrap_or(SessionCreateInput {
            title: None,
            project_slug: None,
        });
    session_commands::create_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        input.title,
        input.project_slug,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn delete_session_record(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::delete_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .await
    .map(|_| StatusCode::NO_CONTENT)
    .map_err(command_api_error)
}

async fn get_session_runtime_details(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::get_session_runtime_details(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .map(Json)
    .map_err(command_api_error)
}

async fn get_session_stats(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::get_session_stats(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_contextual_session_create(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    input: Option<Json<SessionCreateInput>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    let input = input
        .map(|Json(value)| value)
        .unwrap_or(SessionCreateInput {
            title: None,
            project_slug: None,
        });
    session_commands::create_contextual_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
        input.project_slug,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_session_resume(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::resume_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_session_subscribe(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::subscribe_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_session_unsubscribe(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::unsubscribe_session(context.app.state::<AppState>(), session_id)
        .await
        .map(Json)
        .map_err(command_api_error)
}

async fn get_session_model_state(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::get_session_model_state(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_session_model_update(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    Json(input): Json<SessionModelInput>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::set_session_model(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
        input.provider,
        input.model_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_session_compact(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    input: Option<Json<SessionCompactInput>>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::compact_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
        input.and_then(|Json(value)| value.custom_instructions),
    )
    .await
    .map(Json)
    .map_err(command_api_error)
}

async fn post_session_reload(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
) -> Result<impl IntoResponse, (StatusCode, Json<ApiError>)> {
    require_remote_auth_only(&context.app, &headers)?;
    session_commands::reload_session(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id,
    )
    .await
    .map(Json)
    .map_err(command_api_error)
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

async fn session_message_response_with_sender<R, Sender, Fut>(
    app: &AppHandle<R>,
    headers: HeaderMap,
    session_id: String,
    input: SessionMessageInput,
    sender: Sender,
) -> Result<Json<QueuedSessionMessage>, (StatusCode, Json<ApiError>)>
where
    R: Runtime,
    Sender: FnOnce(String, String, Option<String>) -> Fut,
    Fut: std::future::Future<Output = Result<QueuedSessionMessage, String>>,
{
    let (trimmed_message, run_id) = prepare_session_message_request(app, &headers, input)?;
    sender(session_id, trimmed_message, run_id)
        .await
        .map(Json)
        .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))
}

async fn post_stop_session_runtime(
    AxumState(context): AxumState<RemoteApiContext>,
    headers: HeaderMap,
    Path(session_id): Path<String>,
    notes: Option<Json<NotesInput>>,
) -> Result<Json<SessionRecord>, (StatusCode, Json<ApiError>)> {
    let device = resolve_remote_auth(&context.app, &headers, None)?;
    let record = session_commands::stop_session_runtime(
        context.app.clone(),
        context.app.state::<AppState>(),
        session_id.clone(),
        notes.and_then(|Json(input)| input.notes),
    )
    .await
    .map_err(|error| api_error(StatusCode::BAD_REQUEST, error))?;
    context.app.state::<AppState>().log(
        "info",
        "remote.api.session.stop",
        &format!("{} stopped session {}", device.device.label, session_id),
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
        input.run_id,
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
    let auth = match resolve_remote_auth(&context.app, &headers, query.token.as_deref()) {
        Ok(auth) => auth,
        Err((status, body)) => return (status, body).into_response(),
    };

    ws.on_upgrade(move |socket| handle_ws_socket(context.app, socket, auth))
}

fn normalize_ws_message_type(message_type: &str) -> &str {
    match message_type {
        "subscribe_session" | "session.subscribe" => "session.subscribe",
        "unsubscribe_session" | "session.unsubscribe" => "session.unsubscribe",
        "select_project" | "project.select" => "project.select",
        "ping" => "ping",
        other => other,
    }
}

fn remote_event_topic_for_client<'a>(client_kind: &str, topic: &'a str) -> &'a str {
    match client_kind {
        "hosted_web" => match topic {
            "task.updated" => "task.change",
            "session.updated" => "session.change",
            "inbox.updated" => "inbox.change",
            other => other,
        },
        _ => match topic {
            "task.change" => "task.updated",
            "session.change" => "session.updated",
            "inbox.change" => "inbox.updated",
            other => other,
        },
    }
}

fn translate_remote_event_for_client(
    client_kind: &str,
    event: &RemoteEventEnvelope,
) -> RemoteEventEnvelope {
    let mut translated = event.clone();
    translated.topic = remote_event_topic_for_client(client_kind, &event.topic).to_string();
    translated
}

async fn handle_ws_socket(app: AppHandle, socket: WebSocket, auth: ResolvedRemoteAuth) {
    let client_id = generate_id("remote-client");
    let device = auth.device;
    let token = auth.token;
    let client_kind = if auth.source == RemoteAuthSource::SameOriginCookie {
        "hosted_web"
    } else {
        "remote_driver"
    };
    let state = app.state::<AppState>();
    if let Err(error) = state.register_remote_client(
        &client_id,
        client_kind,
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
        "clientKind": client_kind,
        "contractVersion": ORCHESTRA_CLIENT_CONTRACT_VERSION,
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
                        if remote_device_token_still_valid(&token).is_err() {
                            break;
                        }
                        let _ = state.touch_remote_client(&client_id);
                        match serde_json::from_str::<ProjectSelectionMessage>(&payload) {
                            Ok(message) => match normalize_ws_message_type(&message.message_type) {
                                "session.subscribe" => {
                                    if let Some(session_id) = message.session_id.as_deref() {
                                        let _ = state.set_remote_session_subscription(&client_id, session_id, true);
                                        let _ = sender.send(Message::Text(json!({
                                            "type": "subscription.confirmed",
                                            "subscriptionType": "session",
                                            "sessionId": session_id,
                                            "subscribed": true,
                                        }).to_string())).await;
                                    } else {
                                        let _ = sender.send(Message::Text(json!({"type":"error","error":"sessionId is required for session.subscribe"}).to_string())).await;
                                    }
                                }
                                "session.unsubscribe" => {
                                    if let Some(session_id) = message.session_id.as_deref() {
                                        let _ = state.set_remote_session_subscription(&client_id, session_id, false);
                                        let _ = sender.send(Message::Text(json!({
                                            "type": "subscription.confirmed",
                                            "subscriptionType": "session",
                                            "sessionId": session_id,
                                            "subscribed": false,
                                        }).to_string())).await;
                                    } else {
                                        let _ = sender.send(Message::Text(json!({"type":"error","error":"sessionId is required for session.unsubscribe"}).to_string())).await;
                                    }
                                }
                                "project.select" => {
                                    let _ = state.set_remote_client_project(&client_id, message.project_id.clone());
                                    let _ = sender.send(Message::Text(json!({
                                        "type": "subscription.confirmed",
                                        "subscriptionType": "project",
                                        "projectId": message.project_id,
                                    }).to_string())).await;
                                }
                                "ping" => {
                                    let _ = sender.send(Message::Text(json!({"type":"pong"}).to_string())).await;
                                }
                                _ => {
                                    let _ = sender.send(Message::Text(json!({"type":"error","error":"Unsupported websocket message"}).to_string())).await;
                                }
                            },
                            Err(_) => {
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
                        if remote_device_token_still_valid(&token).is_err() {
                            break;
                        }
                        if should_deliver_event(state.inner(), &client_id, &event).unwrap_or(false) {
                            let translated = translate_remote_event_for_client(client_kind, &event);
                            if sender.send(Message::Text(json!({"type":"event","event":translated}).to_string())).await.is_err() {
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

fn remote_device_token_still_valid(token: &str) -> Result<(), String> {
    let connection = database::open_connection()?;
    let _ = remote_access::authenticate_token(&connection, token)?;
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
