use std::{
    collections::{HashMap, VecDeque},
    fs,
    io::{Read, Write},
    net::TcpStream,
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use rusqlite::Connection;
use serde::{Deserialize, Serialize};
#[cfg(test)]
use serde_json::json;
use serde_json::Value;
use tauri::{AppHandle, Manager};
use tiny_http::{Method, Response, Server, StatusCode};
use uuid::Uuid;

use crate::{
    models::{
        AuthorizationContext, BridgeCleanupEvent, BridgeClientDiagnostics, BridgeDiagnostics,
        BridgeInstanceDiagnostics, BridgeRequestDiagnostics, MarkMailboxMessagesReadInput,
        MarkTaskCommentsReadInput, OrchestraToolDefinition, RoleQueueEntryInput,
        SendMailboxMessageInput, TaskAttachmentInput, TaskCommentInput, TaskLaneAssignment,
        TaskUpsertInput,
    },
    services::{
        agents, authorization, command_authorization, database, messages, pi_sessions,
        policies, project_settings, projects, role_runtime, roles, task_attachments,
        task_file_references, task_runtime, tasks, workflows,
    },
};

#[derive(Debug)]
pub struct ToolBridgeConfig {
    pub url: String,
    pub token: String,
    pub instance_id: String,
    started_at: String,
    metadata_path: PathBuf,
    owner_pid: u32,
    app_handle: Mutex<Option<AppHandle>>,
    clients: Mutex<HashMap<String, BridgeClientDiagnostics>>,
    recent_requests: Mutex<VecDeque<BridgeRequestDiagnostics>>,
    recent_cleanup_events: Mutex<VecDeque<BridgeCleanupEvent>>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BridgeInstanceRecord {
    service: String,
    instance_id: String,
    url: String,
    owner_pid: u32,
    executable_path: Option<String>,
    schema_version: u32,
    app_version: String,
    started_at: String,
    heartbeat_at: String,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ToolBridgeRequest {
    token: String,
    command: String,
    #[serde(default)]
    authorization: Option<AuthorizationContext>,
    #[serde(default)]
    payload: Value,
    #[serde(default)]
    request_id: Option<String>,
    #[serde(default)]
    client_id: Option<String>,
    #[serde(default)]
    session_id: Option<String>,
    #[serde(default)]
    bridge_instance_id: Option<String>,
    #[serde(default)]
    sent_at: Option<String>,
}

fn session_context_for_task_id(task_id: &str) -> Result<pi_sessions::SessionContext, String> {
    let connection = database::open_connection()?;
    let task = tasks::get_task_context(&connection, task_id)?;
    pi_sessions::session_context_for_project_id(&task.project_id)
}

const BRIDGE_SUPPORTED_COMMANDS: &[&str] = &[
    "list_orchestra_tools",
    "list_agents",
    "get_agent",
    "get_agent_memory_info",
    "create_agent",
    "update_agent",
    "archive_agent",
    "list_roles",
    "get_role",
    "create_role",
    "update_role",
    "archive_role",
    "list_role_operations",
    "get_role_operations",
    "enqueue_role_work",
    "list_projects",
    "get_project",
    "list_repositories",
    "get_repository",
    "list_tasks",
    "get_task",
    "get_task_context",
    "list_task_comments",
    "get_unread_task_comments",
    "mark_task_comments_read",
    "get_unread_mail",
    "mark_mail_read",
    "send_mail",
    "list_task_repositories",
    "list_task_file_references",
    "add_task_file_reference",
    "remove_task_file_reference",
    "create_task",
    "create_subtask",
    "update_task",
    "comment_on_task",
    "dispatch_task_lane",
    "complete_lane_as_success",
    "complete_lane_as_failure",
    "request_user_intervention",
    "add_task_dependency",
    "remove_task_dependency",
    "add_task_attachment",
    "remove_task_attachment",
    "list_workflows",
    "get_workflow",
    "create_workflow",
    "update_workflow",
    "duplicate_workflow",
    "archive_workflow",
    "list_policies",
    "get_policy",
    "get_agent_permissions",
    "get_role_permissions",
    "get_role_instance_permissions",
    "get_worker_overlay",
    "update_worker_overlay",
];

const BRIDGE_SERVICE_NAME: &str = "orchestra-tool-bridge";
const BRIDGE_SCHEMA_VERSION: u32 = 1;
const BRIDGE_HEARTBEAT_INTERVAL: Duration = Duration::from_secs(5);
const BRIDGE_STALE_AFTER: Duration = Duration::from_secs(30);
const BRIDGE_RECENT_REQUEST_LIMIT: usize = 50;
const BRIDGE_RECENT_CLEANUP_LIMIT: usize = 50;

impl ToolBridgeConfig {
    pub fn attach_app_handle(&self, app: AppHandle) {
        if let Ok(mut current) = self.app_handle.lock() {
            *current = Some(app);
        }
    }

    pub fn diagnostics(&self) -> BridgeDiagnostics {
        let clients = self
            .clients
            .lock()
            .map(|entries| {
                let mut values = entries.values().cloned().collect::<Vec<_>>();
                values.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
                values
            })
            .unwrap_or_default();
        let recent_requests = self
            .recent_requests
            .lock()
            .map(|entries| entries.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();
        let recent_cleanup_events = self
            .recent_cleanup_events
            .lock()
            .map(|entries| entries.iter().cloned().collect::<Vec<_>>())
            .unwrap_or_default();

        BridgeDiagnostics {
            instance: BridgeInstanceDiagnostics {
                instance_id: self.instance_id.clone(),
                url: self.url.clone(),
                owner_pid: self.owner_pid,
                started_at: self.started_at.clone(),
                heartbeat_at: read_bridge_instance_record(&self.metadata_path)
                    .map(|record| record.heartbeat_at)
                    .unwrap_or_else(|_| self.started_at.clone()),
                metadata_path: self.metadata_path.display().to_string(),
                active_client_count: clients.iter().filter(|client| client.active).count() as i64,
                in_flight_request_count: clients
                    .iter()
                    .map(|client| client.in_flight_request_count)
                    .sum(),
            },
            clients,
            recent_requests,
            recent_cleanup_events,
        }
    }

    pub fn cleanup_stale_instances(&self) -> Result<Vec<BridgeCleanupEvent>, String> {
        let events = cleanup_stale_bridge_instances(&self.instance_id, Some(&self.metadata_path))?;
        for event in &events {
            self.push_cleanup_event(event.clone());
            self.log_bridge_event(
                if event.success { "info" } else { "warn" },
                "tool.bridge.cleanup",
                &format!(
                    "action={} reason={} instance={:?} pid={:?}",
                    event.action, event.reason, event.instance_id, event.pid
                ),
            );
        }
        Ok(events)
    }

    fn log_bridge_event(&self, level: &str, target: &str, message: &str) {
        if let Ok(app_handle) = self.app_handle.lock() {
            if let Some(app) = app_handle.as_ref() {
                app.state::<crate::state::AppState>()
                    .log(level, target, message);
            }
        }
    }

    fn push_cleanup_event(&self, event: BridgeCleanupEvent) {
        if let Ok(mut events) = self.recent_cleanup_events.lock() {
            events.push_front(event);
            while events.len() > BRIDGE_RECENT_CLEANUP_LIMIT {
                events.pop_back();
            }
        }
    }

    fn record_request_start(&self, request: &ToolBridgeRequest) -> BridgeRequestDiagnostics {
        let started_at = crate::state::now_iso();
        let request_id = request
            .request_id
            .clone()
            .unwrap_or_else(|| format!("bridge-request-{}", Uuid::new_v4().simple()));
        if let Some(client_id) = request.client_id.as_deref() {
            if let Ok(mut clients) = self.clients.lock() {
                let client =
                    clients
                        .entry(client_id.to_string())
                        .or_insert(BridgeClientDiagnostics {
                            client_id: client_id.to_string(),
                            session_id: request.session_id.clone(),
                            actor_type: request
                                .authorization
                                .as_ref()
                                .map(|entry| entry.actor_type.clone()),
                            actor_id: request
                                .authorization
                                .as_ref()
                                .map(|entry| entry.actor_id.clone()),
                            request_count: 0,
                            in_flight_request_count: 0,
                            last_seen_at: started_at.clone(),
                            last_command: None,
                            last_error: None,
                            active: true,
                            bridge_instance_id: request.bridge_instance_id.clone(),
                        });
                client.session_id = request
                    .session_id
                    .clone()
                    .or_else(|| client.session_id.clone());
                client.actor_type = request
                    .authorization
                    .as_ref()
                    .map(|entry| entry.actor_type.clone())
                    .or_else(|| client.actor_type.clone());
                client.actor_id = request
                    .authorization
                    .as_ref()
                    .map(|entry| entry.actor_id.clone())
                    .or_else(|| client.actor_id.clone());
                client.request_count += 1;
                client.in_flight_request_count += 1;
                client.last_seen_at = started_at.clone();
                client.last_command = Some(request.command.clone());
                client.active = true;
                client.bridge_instance_id = request
                    .bridge_instance_id
                    .clone()
                    .or_else(|| client.bridge_instance_id.clone());
            }
        }

        let diagnostic = BridgeRequestDiagnostics {
            request_id,
            client_id: request.client_id.clone(),
            session_id: request.session_id.clone(),
            command: request.command.clone(),
            started_at,
            finished_at: None,
            duration_ms: None,
            success: false,
            error: None,
        };
        self.log_bridge_event(
            "info",
            "tool.bridge.request.start",
            &format!(
                "command={} client={:?} session={:?}",
                diagnostic.command, diagnostic.client_id, diagnostic.session_id
            ),
        );
        diagnostic
    }

    fn record_request_finish(&self, diagnostic: &BridgeRequestDiagnostics) {
        if let Some(client_id) = diagnostic.client_id.as_deref() {
            if let Ok(mut clients) = self.clients.lock() {
                if let Some(client) = clients.get_mut(client_id) {
                    client.in_flight_request_count = (client.in_flight_request_count - 1).max(0);
                    client.last_seen_at = diagnostic
                        .finished_at
                        .clone()
                        .unwrap_or_else(crate::state::now_iso);
                    client.last_error = diagnostic.error.clone();
                    client.active = client.in_flight_request_count > 0 || diagnostic.success;
                }
            }
        }
        if let Ok(mut requests) = self.recent_requests.lock() {
            requests.push_front(diagnostic.clone());
            while requests.len() > BRIDGE_RECENT_REQUEST_LIMIT {
                requests.pop_back();
            }
        }
        self.log_bridge_event(
            if diagnostic.success { "info" } else { "error" },
            "tool.bridge.request.finish",
            &format!(
                "command={} client={:?} session={:?} success={} durationMs={:?} error={:?}",
                diagnostic.command,
                diagnostic.client_id,
                diagnostic.session_id,
                diagnostic.success,
                diagnostic.duration_ms,
                diagnostic.error
            ),
        );
    }

    fn clone_app_handle(&self) -> Option<AppHandle> {
        self.app_handle
            .lock()
            .ok()
            .and_then(|current| current.clone())
    }

    fn start_assignment_async(
        &self,
        session_dir: PathBuf,
        assignment: &TaskLaneAssignment,
    ) -> Result<(), String> {
        let app = self
            .app_handle
            .lock()
            .map_err(|_| "Unable to access bridge app handle".to_string())?
            .clone()
            .ok_or_else(|| "Bridge app handle is not attached".to_string())?;
        let assignment = assignment.clone();
        thread::spawn(move || {
            let state = app.state::<crate::state::AppState>();
            if let Err(error) = crate::services::task_runtime::start_assignment_run(
                app.clone(),
                &state,
                session_dir,
                &assignment,
            ) {
                state.log(
                    "error",
                    "tool.bridge.assignment_start",
                    &format!(
                        "Unable to start assignment {} for task {}: {error}",
                        assignment.id, assignment.task_id
                    ),
                );
            }
        });
        Ok(())
    }
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
struct ToolBridgeResponse {
    success: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    data: Option<Value>,
    #[serde(skip_serializing_if = "Option::is_none")]
    error: Option<String>,
    #[serde(skip)]
    request: Option<tiny_http::Request>,
}

pub fn start_tool_bridge() -> Result<Arc<ToolBridgeConfig>, String> {
    let instance_id = format!("bridge-instance-{}", Uuid::new_v4().simple());
    let bridge_dir = bridge_runtime_dir()?;
    fs::create_dir_all(&bridge_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra bridge runtime dir {}: {error}",
            bridge_dir.display()
        )
    })?;

    let server = Server::http("127.0.0.1:0")
        .map_err(|error| format!("Unable to start Orchestra tool bridge server: {error}"))?;
    let address = server
        .server_addr()
        .to_ip()
        .ok_or_else(|| "Unable to resolve Orchestra tool bridge address".to_string())?;
    let url = format!("http://{}", address);
    let token = format!("bridge-{}", Uuid::new_v4().simple());
    let started_at = crate::state::now_iso();
    let metadata_path = bridge_dir.join(format!("{}.json", instance_id));
    let config = Arc::new(ToolBridgeConfig {
        url,
        token,
        instance_id: instance_id.clone(),
        started_at: started_at.clone(),
        metadata_path: metadata_path.clone(),
        owner_pid: std::process::id(),
        app_handle: Mutex::new(None),
        clients: Mutex::new(HashMap::new()),
        recent_requests: Mutex::new(VecDeque::new()),
        recent_cleanup_events: Mutex::new(VecDeque::new()),
    });

    for event in cleanup_stale_bridge_instances(&instance_id, Some(&metadata_path))? {
        config.push_cleanup_event(event);
    }

    write_bridge_instance_record(
        &metadata_path,
        &BridgeInstanceRecord {
            service: BRIDGE_SERVICE_NAME.into(),
            instance_id: instance_id.clone(),
            url: config.url.clone(),
            owner_pid: config.owner_pid,
            executable_path: std::env::current_exe()
                .ok()
                .map(|path| path.display().to_string()),
            schema_version: BRIDGE_SCHEMA_VERSION,
            app_version: env!("CARGO_PKG_VERSION").into(),
            started_at: started_at.clone(),
            heartbeat_at: started_at,
        },
    )?;

    let heartbeat_config = Arc::clone(&config);
    thread::spawn(move || loop {
        thread::sleep(BRIDGE_HEARTBEAT_INTERVAL);
        let existing = read_bridge_instance_record(&heartbeat_config.metadata_path).unwrap_or(
            BridgeInstanceRecord {
                service: BRIDGE_SERVICE_NAME.into(),
                instance_id: heartbeat_config.instance_id.clone(),
                url: heartbeat_config.url.clone(),
                owner_pid: heartbeat_config.owner_pid,
                executable_path: std::env::current_exe()
                    .ok()
                    .map(|path| path.display().to_string()),
                schema_version: BRIDGE_SCHEMA_VERSION,
                app_version: env!("CARGO_PKG_VERSION").into(),
                started_at: heartbeat_config.started_at.clone(),
                heartbeat_at: heartbeat_config.started_at.clone(),
            },
        );
        let mut updated = existing;
        updated.heartbeat_at = crate::state::now_iso();
        let _ = write_bridge_instance_record(&heartbeat_config.metadata_path, &updated);
    });

    let thread_config = Arc::clone(&config);
    thread::spawn(move || {
        for request in server.incoming_requests() {
            let request_config = Arc::clone(&thread_config);
            thread::spawn(move || {
                let response = handle_request(&request_config, request).unwrap_or_else(|error| {
                    ToolBridgeResponse {
                        success: false,
                        data: None,
                        error: Some(error),
                        request: None,
                    }
                });
                let status = if response.success {
                    StatusCode(200)
                } else {
                    StatusCode(400)
                };
                let body = serde_json::to_string(&response).unwrap_or_else(|_| {
                    "{\"success\":false,\"error\":\"serialization failed\"}".into()
                });
                let _ = response_request(response, status, body);
            });
        }
    });

    Ok(config)
}

fn response_request(
    mut response: ToolBridgeResponse,
    status: StatusCode,
    body: String,
) -> Result<(), String> {
    let request = response
        .request
        .take()
        .ok_or_else(|| "Missing bridge request responder".to_string())?;
    request
        .respond(Response::from_string(body).with_status_code(status))
        .map_err(|error| format!("Unable to respond to bridge request: {error}"))
}

fn handle_request(
    config: &ToolBridgeConfig,
    mut request: tiny_http::Request,
) -> Result<ToolBridgeResponse, String> {
    if request.method() == &Method::Get && request.url() == "/status" {
        let data = serde_json::to_value(config.diagnostics())
            .map_err(|error| format!("Unable to serialize bridge diagnostics: {error}"))?;
        return Ok(ToolBridgeResponse {
            success: true,
            data: Some(data),
            error: None,
            request: Some(request),
        });
    }

    if request.method() != &Method::Post || request.url() != "/invoke" {
        return Ok(ToolBridgeResponse {
            success: false,
            data: None,
            error: Some("Unsupported route".into()),
            request: Some(request),
        });
    }

    let mut body = String::new();
    request
        .as_reader()
        .read_to_string(&mut body)
        .map_err(|error| format!("Unable to read tool bridge request: {error}"))?;
    let request_body = serde_json::from_str::<ToolBridgeRequest>(&body)
        .map_err(|error| format!("Unable to parse tool bridge request: {error}"))?;

    if request_body.token != config.token {
        return Ok(ToolBridgeResponse {
            success: false,
            data: None,
            error: Some("Invalid Orchestra bridge token".into()),
            request: Some(request),
        });
    }

    if request_body
        .bridge_instance_id
        .as_deref()
        .is_some_and(|value| value != config.instance_id)
    {
        config.log_bridge_event(
            "warn",
            "tool.bridge.instance_mismatch",
            &format!(
                "Client {:?} reported bridge instance {:?} but current instance is {}",
                request_body.client_id, request_body.bridge_instance_id, config.instance_id,
            ),
        );
    }

    let mut diagnostic = config.record_request_start(&request_body);
    let connection = database::open_connection()?;
    let result = invoke_bridge_command(
        config,
        &connection,
        &request_body.command,
        request_body.authorization.as_ref(),
        request_body.session_id.as_deref(),
        request_body.payload,
    );
    let finished_at = crate::state::now_iso();
    diagnostic.finished_at = Some(finished_at.clone());
    diagnostic.duration_ms = Some(duration_ms(&diagnostic.started_at, &finished_at));
    match result {
        Ok(data) => {
            diagnostic.success = true;
            config.record_request_finish(&diagnostic);
            Ok(ToolBridgeResponse {
                success: true,
                data: Some(data),
                error: None,
                request: Some(request),
            })
        }
        Err(error) => {
            diagnostic.success = false;
            diagnostic.error = Some(error.clone());
            config.record_request_finish(&diagnostic);
            Ok(ToolBridgeResponse {
                success: false,
                data: None,
                error: Some(error),
                request: Some(request),
            })
        }
    }
}

fn duration_ms(started_at: &str, finished_at: &str) -> i64 {
    let started = chrono::DateTime::parse_from_rfc3339(started_at)
        .map(|value| value.timestamp_millis())
        .unwrap_or_default();
    let finished = chrono::DateTime::parse_from_rfc3339(finished_at)
        .map(|value| value.timestamp_millis())
        .unwrap_or(started);
    finished.saturating_sub(started)
}

fn bridge_runtime_dir() -> Result<PathBuf, String> {
    Ok(crate::services::orchestra_paths::default_orchestra_root()?.join("bridge"))
}

fn write_bridge_instance_record(path: &Path, record: &BridgeInstanceRecord) -> Result<(), String> {
    let content = serde_json::to_string_pretty(record)
        .map_err(|error| format!("Unable to serialize bridge instance record: {error}"))?;
    fs::write(path, content).map_err(|error| {
        format!(
            "Unable to write bridge instance record {}: {error}",
            path.display()
        )
    })
}

fn read_bridge_instance_record(path: &Path) -> Result<BridgeInstanceRecord, String> {
    let content = fs::read_to_string(path).map_err(|error| {
        format!(
            "Unable to read bridge instance record {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Unable to parse bridge instance record {}: {error}",
            path.display()
        )
    })
}

fn cleanup_stale_bridge_instances(
    current_instance_id: &str,
    current_metadata_path: Option<&Path>,
) -> Result<Vec<BridgeCleanupEvent>, String> {
    let bridge_dir = bridge_runtime_dir()?;
    if !bridge_dir.exists() {
        return Ok(Vec::new());
    }

    let current_exe = std::env::current_exe()
        .ok()
        .map(|path| path.display().to_string());
    let now = crate::state::now_iso();
    let mut events = Vec::new();

    for entry in fs::read_dir(&bridge_dir).map_err(|error| {
        format!(
            "Unable to read bridge runtime dir {}: {error}",
            bridge_dir.display()
        )
    })? {
        let entry =
            entry.map_err(|error| format!("Unable to read bridge runtime entry: {error}"))?;
        let path = entry.path();
        if current_metadata_path.is_some_and(|current| current == path.as_path()) {
            continue;
        }
        if path.extension().and_then(|value| value.to_str()) != Some("json") {
            continue;
        }

        let action_id = format!("bridge-cleanup-{}", Uuid::new_v4().simple());
        match read_bridge_instance_record(&path) {
            Ok(record) => {
                if record.instance_id == current_instance_id {
                    continue;
                }
                let pid_alive = Path::new("/proc")
                    .join(record.owner_pid.to_string())
                    .exists();
                if !pid_alive {
                    let _ = fs::remove_file(&path);
                    events.push(BridgeCleanupEvent {
                        id: action_id,
                        instance_id: Some(record.instance_id),
                        pid: Some(record.owner_pid),
                        action: "remove_metadata".into(),
                        reason: "owner_process_missing".into(),
                        success: true,
                        timestamp: now.clone(),
                    });
                    continue;
                }

                if bridge_instance_is_healthy(&record) {
                    events.push(BridgeCleanupEvent {
                        id: action_id,
                        instance_id: Some(record.instance_id),
                        pid: Some(record.owner_pid),
                        action: "skip_cleanup".into(),
                        reason: "bridge_status_healthy".into(),
                        success: true,
                        timestamp: now.clone(),
                    });
                    continue;
                }

                let heartbeat_age_ms = chrono::DateTime::parse_from_rfc3339(&record.heartbeat_at)
                    .map(|value| {
                        chrono::Utc::now()
                            .timestamp_millis()
                            .saturating_sub(value.timestamp_millis())
                    })
                    .unwrap_or(i64::MAX);
                let exe_matches = current_exe
                    .as_deref()
                    .is_some_and(|exe| record.executable_path.as_deref() == Some(exe));
                if heartbeat_age_ms >= BRIDGE_STALE_AFTER.as_millis() as i64 && exe_matches {
                    let status = std::process::Command::new("kill")
                        .arg("-TERM")
                        .arg(record.owner_pid.to_string())
                        .status();
                    thread::sleep(Duration::from_millis(500));
                    let removed = !Path::new("/proc")
                        .join(record.owner_pid.to_string())
                        .exists();
                    if removed {
                        let _ = fs::remove_file(&path);
                    }
                    events.push(BridgeCleanupEvent {
                        id: action_id,
                        instance_id: Some(record.instance_id),
                        pid: Some(record.owner_pid),
                        action: "terminate_owner".into(),
                        reason: if removed {
                            "stale_unhealthy_bridge_reaped".into()
                        } else {
                            format!(
                                "kill_attempt_failed:{:?}",
                                status.ok().map(|entry| entry.code())
                            )
                        },
                        success: removed,
                        timestamp: now.clone(),
                    });
                } else {
                    events.push(BridgeCleanupEvent {
                        id: action_id,
                        instance_id: Some(record.instance_id),
                        pid: Some(record.owner_pid),
                        action: "skip_cleanup".into(),
                        reason: "not_stale_or_not_verified".into(),
                        success: true,
                        timestamp: now.clone(),
                    });
                }
            }
            Err(error) => {
                let _ = fs::remove_file(&path);
                events.push(BridgeCleanupEvent {
                    id: action_id,
                    instance_id: None,
                    pid: None,
                    action: "remove_metadata".into(),
                    reason: format!("invalid_metadata:{error}"),
                    success: true,
                    timestamp: now.clone(),
                });
            }
        }
    }

    Ok(events)
}

fn bridge_instance_is_healthy(record: &BridgeInstanceRecord) -> bool {
    let url = record.url.strip_prefix("http://").unwrap_or(&record.url);
    let mut parts = url.split(':');
    let host = parts.next().unwrap_or("127.0.0.1");
    let port = parts
        .next()
        .and_then(|value| value.parse::<u16>().ok())
        .unwrap_or(0);
    if port == 0 {
        return false;
    }
    let address = format!("{}:{}", host, port);
    let mut stream = match TcpStream::connect(&address) {
        Ok(stream) => stream,
        Err(_) => return false,
    };
    let _ = stream.set_read_timeout(Some(Duration::from_millis(500)));
    let _ = stream.set_write_timeout(Some(Duration::from_millis(500)));
    if stream
        .write_all(b"GET /status HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n")
        .is_err()
    {
        return false;
    }
    let mut response = String::new();
    if stream.read_to_string(&mut response).is_err() {
        return false;
    }
    response.contains(BRIDGE_SERVICE_NAME) && response.contains(&record.instance_id)
}

pub fn list_bridge_tools(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
) -> Result<Vec<OrchestraToolDefinition>, String> {
    Ok(
        command_authorization::list_allowed_tools(connection, authorization)?
            .into_iter()
            .filter(|tool| BRIDGE_SUPPORTED_COMMANDS.contains(&tool.name.as_str()))
            .collect(),
    )
}

fn invoke_bridge_command(
    config: &ToolBridgeConfig,
    connection: &Connection,
    command: &str,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
    payload: Value,
) -> Result<Value, String> {
    #[cfg(test)]
    if command == "__test_sleep" {
        let sleep_ms = payload.get("sleepMs").and_then(Value::as_u64).unwrap_or(0);
        std::thread::sleep(Duration::from_millis(sleep_ms));
        return Ok(json!({ "sleptMs": sleep_ms, "bridgeInstanceId": config.instance_id }));
    }

    match command {
        "list_orchestra_tools" => {
            let tools = list_bridge_tools(connection, authorization)?;
            serde_json::to_value(tools)
                .map_err(|error| format!("Unable to serialize tools: {error}"))
        }
        "list_agents" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::list_agents(connection, include_archived)?)
                .map_err(|error| format!("Unable to serialize agents: {error}"))
        }
        "get_agent" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::get_agent(connection, &agent_id)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "get_agent_memory_info" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::get_agent_memory_info(connection, &agent_id)?)
                .map_err(|error| format!("Unable to serialize agent memory info: {error}"))
        }
        "create_agent" => {
            command_authorization::require_permission(connection, authorization, "agents.create")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse agent input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(agents::create_agent(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "update_agent" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.update")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse agent input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(agents::update_agent(&mut writable, &agent_id, input)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "archive_agent" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "agents.archive")?;
            let writable = database::open_connection()?;
            serde_json::to_value(agents::archive_agent(&writable, &agent_id)?)
                .map_err(|error| format!("Unable to serialize agent: {error}"))
        }
        "list_roles" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(roles::list_roles(connection, include_archived)?)
                .map_err(|error| format!("Unable to serialize roles: {error}"))
        }
        "get_role" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(roles::get_role(connection, &role_id)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "create_role" => {
            command_authorization::require_permission(connection, authorization, "roles.create")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse role input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(roles::create_role(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "update_role" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.update")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse role input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(roles::update_role(&mut writable, &role_id, input)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "archive_role" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.archive")?;
            let writable = database::open_connection()?;
            serde_json::to_value(roles::archive_role(&writable, &role_id)?)
                .map_err(|error| format!("Unable to serialize role: {error}"))
        }
        "list_role_operations" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(role_runtime::list_role_operations(
                connection,
                include_archived,
            )?)
            .map_err(|error| format!("Unable to serialize role operations: {error}"))
        }
        "get_role_operations" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "roles.read")?;
            serde_json::to_value(role_runtime::get_role_operations(connection, &role_id)?)
                .map_err(|error| format!("Unable to serialize role operations: {error}"))
        }
        "enqueue_role_work" => {
            command_authorization::require_permission(connection, authorization, "roles.enqueue")?;
            let input: RoleQueueEntryInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse role queue input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(role_runtime::enqueue_role_work(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize role queue entry: {error}"))
        }
        "list_projects" => {
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(projects::list_projects(connection)?)
                .map_err(|error| format!("Unable to serialize projects: {error}"))
        }
        "get_project" => {
            let project_id = require_string(&payload, "projectId")?;
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(projects::get_project(connection, &project_id)?)
                .map_err(|error| format!("Unable to serialize project: {error}"))
        }
        "list_repositories" => {
            let project_id = payload
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty());
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(projects::list_repositories(connection, project_id)?)
                .map_err(|error| format!("Unable to serialize repositories: {error}"))
        }
        "get_repository" => {
            let repository_id = require_string(&payload, "repositoryId")?;
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(projects::get_repository(connection, &repository_id)?)
                .map_err(|error| format!("Unable to serialize repository: {error}"))
        }
        "list_tasks" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let project_id = payload
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .unwrap_or("orchestra");
            serde_json::to_value(tasks::list_tasks(connection, project_id, include_archived)?)
                .map_err(|error| format!("Unable to serialize tasks: {error}"))
        }
        "get_task" | "get_task_context" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            serde_json::to_value(tasks::get_task_context(connection, &task_id)?)
                .map_err(|error| format!("Unable to serialize task context: {error}"))
        }
        "list_task_comments" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            serde_json::to_value(tasks::list_task_comments(connection, &task_id)?)
                .map_err(|error| format!("Unable to serialize task comments: {error}"))
        }
        "get_unread_task_comments" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let assignment =
                crate::services::task_runtime::get_active_lane_assignment(connection, &task_id)?
                    .ok_or_else(|| format!("Task {} has no active lane assignment", task_id))?;
            crate::services::task_runtime::validate_assignment_authorization(
                &assignment,
                authorization,
            )?;
            serde_json::to_value(tasks::list_unread_task_comments(
                connection,
                &task_id,
                &assignment,
            )?)
            .map_err(|error| format!("Unable to serialize unread task comments: {error}"))
        }
        "mark_task_comments_read" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.comment")?;
            let assignment =
                crate::services::task_runtime::get_active_lane_assignment(connection, &task_id)?
                    .ok_or_else(|| format!("Task {} has no active lane assignment", task_id))?;
            crate::services::task_runtime::validate_assignment_authorization(
                &assignment,
                authorization,
            )?;
            let input: MarkTaskCommentsReadInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or_else(|| {
                    serde_json::json!({
                        "commentIds": payload.get("commentIds").cloned().unwrap_or(Value::Null)
                    })
                }))
                .map_err(|error| format!("Unable to parse task comment receipt input: {error}"))?;
            serde_json::to_value(tasks::mark_task_comments_read(
                connection,
                &task_id,
                &assignment,
                input.comment_ids.as_deref(),
            )?)
            .map_err(|error| format!("Unable to serialize task comment receipts: {error}"))
        }
        "get_unread_mail" => {
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let task_id = payload.get("taskId").and_then(Value::as_str);
            serde_json::to_value(messages::list_unread_mail_for_authorization(
                connection,
                authorization,
                session_id,
                task_id,
            )?)
            .map_err(|error| format!("Unable to serialize unread mail: {error}"))
        }
        "mark_mail_read" => {
            command_authorization::require_permission(connection, authorization, "tasks.comment")?;
            let task_id = payload.get("taskId").and_then(Value::as_str);
            let input: MarkMailboxMessagesReadInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or_else(|| {
                    serde_json::json!({
                        "deliveryIds": payload.get("deliveryIds").cloned().unwrap_or(Value::Null)
                    })
                }))
                .map_err(|error| format!("Unable to parse mailbox receipt input: {error}"))?;
            serde_json::to_value(messages::mark_mail_read_for_authorization(
                connection,
                authorization,
                session_id,
                task_id,
                input.delivery_ids.as_deref(),
            )?)
            .map_err(|error| format!("Unable to serialize mailbox read receipts: {error}"))
        }
        "send_mail" => {
            command_authorization::require_permission(connection, authorization, "tasks.comment")?;
            let input: SendMailboxMessageInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or_else(|| payload.clone()))
                    .map_err(|error| format!("Unable to parse mailbox send input: {error}"))?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "Orchestra app handle unavailable for mailbox send".to_string())?;
            let state = app.state::<crate::state::AppState>();
            let message = messages::send_mailbox_message_from_authorization(
                app.clone(),
                &state,
                connection,
                authorization,
                session_id,
                input,
            )?;
            let _ = crate::services::app_events::emit_inbox_change(&app, "mailbox.sent", [message.delivery_id.clone()]);
            if let Some(task_id) = message.task_id.clone() {
                let _ = crate::services::app_events::emit_task_change(&app, "mailbox.sent", [task_id]);
            }
            serde_json::to_value(message)
                .map_err(|error| format!("Unable to serialize mailbox message: {error}"))
        }
        "list_task_repositories" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let task = tasks::get_task_context(connection, &task_id)?;
            serde_json::to_value(task.task_repositories)
                .map_err(|error| format!("Unable to serialize task repositories: {error}"))
        }
        "list_task_file_references" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let task = tasks::get_task_context(connection, &task_id)?;
            let task_workspace_cwd = task.active_lane_assignment
                .as_ref()
                .map(|assignment| task_runtime::resolve_assignment_workspace_cwd(connection, assignment, &task_id, &task.project_id))
                .transpose()?
                .flatten();
            serde_json::to_value(task_file_references::load_task_file_references(
                connection,
                &task_id,
                task_workspace_cwd.as_deref(),
            )?)
            .map_err(|error| format!("Unable to serialize task file references: {error}"))
        }
        "add_task_file_reference" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| {
                        format!("Unable to parse task file reference input: {error}")
                    })?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(task_file_references::add_task_file_reference(
                &mut writable,
                &task_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize task file reference: {error}"))
        }
        "remove_task_file_reference" => {
            let reference_id = require_string(&payload, "referenceId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            let writable = database::open_connection()?;
            serde_json::to_value(task_file_references::remove_task_file_reference(
                &writable,
                &reference_id,
            )?)
            .map_err(|error| format!("Unable to serialize removed task file reference: {error}"))
        }
        "create_task" => {
            command_authorization::require_permission(connection, authorization, "tasks.create")?;
            let input_payload = payload.get("input").cloned().unwrap_or_else(|| {
                let mut legacy = payload.clone();
                if let Some(object) = legacy.as_object_mut() {
                    object.remove("projectId");
                }
                legacy
            });
            let input: TaskUpsertInput = serde_json::from_value(input_payload)
                .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let project_id = payload
                .get("projectId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string);
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::create_task(
                &mut writable,
                project_id.as_deref(),
                input,
            )?)
            .map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "create_subtask" => {
            let parent_task_id = require_string(&payload, "parentTaskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.create")?;
            let input: TaskUpsertInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::create_subtask(
                &mut writable,
                &parent_task_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "update_task" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            let input: TaskUpsertInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::update_task(&mut writable, &task_id, input)?)
                .map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "comment_on_task" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.comment")?;
            let input: TaskCommentInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task comment input: {error}"))?;
            let mut writable = database::open_connection()?;
            let comment = tasks::add_task_comment(&mut writable, &task_id, input)?;
            if let Some(active_assignment) =
                crate::services::task_runtime::get_active_lane_assignment(&writable, &task_id)?
            {
                if crate::services::task_runtime::assignment_owned_by_worker_authorization(
                    &active_assignment,
                    authorization,
                ) {
                    let comment_ids = vec![comment.id.clone()];
                    let _ = tasks::mark_task_comments_read(
                        &writable,
                        &task_id,
                        &active_assignment,
                        Some(&comment_ids),
                    )?;
                } else if let Some(app) = config.clone_app_handle() {
                    let context = session_context_for_task_id(&task_id)?;
                    let state = app.state::<crate::state::AppState>();
                    crate::services::task_runtime::notify_active_assignment_of_unread_comments(
                        app.clone(),
                        &state,
                        context.session_dir,
                        &active_assignment,
                        &comment,
                    )?;
                }
            }
            serde_json::to_value(comment)
                .map_err(|error| format!("Unable to serialize task comment: {error}"))
        }
        "dispatch_task_lane" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.transition",
            )?;
            let context = session_context_for_task_id(&task_id)?;
            let mut writable = database::open_connection()?;
            let assignment = crate::services::task_runtime::dispatch_task_lane(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
            )?;
            config.start_assignment_async(context.session_dir.clone(), &assignment)?;
            serde_json::to_value(assignment)
                .map_err(|error| format!("Unable to serialize task dispatch assignment: {error}"))
        }
        "complete_lane_as_success" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.transition",
            )?;
            let context = session_context_for_task_id(&task_id)?;
            let mut writable = database::open_connection()?;
            let task = crate::services::task_runtime::complete_lane_as_success(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                notes,
                authorization,
            )?;
            if let Some(next_assignment) = crate::services::task_runtime::maybe_auto_dispatch_task(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
            )? {
                config.start_assignment_async(context.session_dir.clone(), &next_assignment)?;
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize completed task lane: {error}"))
        }
        "complete_lane_as_failure" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.transition",
            )?;
            let context = session_context_for_task_id(&task_id)?;
            let mut writable = database::open_connection()?;
            let task = crate::services::task_runtime::complete_lane_as_failure(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                notes,
                authorization,
            )?;
            if let Some(next_assignment) = crate::services::task_runtime::maybe_auto_dispatch_task(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
            )? {
                config.start_assignment_async(context.session_dir.clone(), &next_assignment)?;
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize failed task lane: {error}"))
        }
        "request_user_intervention" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.transition",
            )?;
            let context = session_context_for_task_id(&task_id)?;
            let mut writable = database::open_connection()?;
            let task = crate::services::task_runtime::request_user_intervention(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                notes,
                authorization,
            )?;
            serde_json::to_value(task).map_err(|error| {
                format!("Unable to serialize user-intervention task lane: {error}")
            })
        }
        "add_task_dependency" => {
            let blocker_task_id = require_string(&payload, "blockerTaskId")?;
            let blocked_task_id = require_string(&payload, "blockedTaskId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.dependencies.write",
            )?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(tasks::add_task_dependency(
                &mut writable,
                &blocker_task_id,
                &blocked_task_id,
            )?)
            .map_err(|error| format!("Unable to serialize task dependency: {error}"))
        }
        "remove_task_dependency" => {
            let dependency_id = require_string(&payload, "dependencyId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.dependencies.write",
            )?;
            let writable = database::open_connection()?;
            serde_json::to_value(tasks::remove_task_dependency(&writable, &dependency_id)?)
                .map_err(|error| format!("Unable to serialize removed task dependency: {error}"))
        }
        "add_task_attachment" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.attachments.write",
            )?;
            let input: TaskAttachmentInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task attachment input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(task_attachments::add_task_attachment(
                &mut writable,
                &task_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize task attachment: {error}"))
        }
        "remove_task_attachment" => {
            let attachment_id = require_string(&payload, "attachmentId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.attachments.write",
            )?;
            let writable = database::open_connection()?;
            serde_json::to_value(task_attachments::remove_task_attachment(
                &writable,
                &attachment_id,
            )?)
            .map_err(|error| format!("Unable to serialize removed task attachment: {error}"))
        }
        "list_workflows" => {
            let include_archived = payload
                .get("includeArchived")
                .and_then(Value::as_bool)
                .unwrap_or(false);
            command_authorization::require_permission(connection, authorization, "workflows.read")?;
            serde_json::to_value(workflows::list_workflows(connection, include_archived)?)
                .map_err(|error| format!("Unable to serialize workflows: {error}"))
        }
        "get_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(connection, authorization, "workflows.read")?;
            serde_json::to_value(workflows::get_workflow(connection, &workflow_id)?)
                .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "create_workflow" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.create",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse workflow input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::create_workflow(&mut writable, input)?)
                .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "update_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.update",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse workflow input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::update_workflow(
                &mut writable,
                &workflow_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "duplicate_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.create",
            )?;
            let new_name = payload
                .get("newName")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::duplicate_workflow(
                &mut writable,
                &workflow_id,
                new_name,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "archive_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.archive",
            )?;
            let writable = database::open_connection()?;
            serde_json::to_value(workflows::archive_workflow(&writable, &workflow_id)?)
                .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "list_policies" => {
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(policies::list_policies(connection)?)
                .map_err(|error| format!("Unable to serialize policies: {error}"))
        }
        "get_policy" => {
            let policy_id = require_string(&payload, "policyId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(policies::get_policy(connection, &policy_id)?)
                .map_err(|error| format!("Unable to serialize policy: {error}"))
        }
        "get_agent_permissions" => {
            let agent_id = require_string(&payload, "agentId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(authorization::resolve_agent_permissions(
                connection, &agent_id,
            )?)
            .map_err(|error| format!("Unable to serialize permissions: {error}"))
        }
        "get_role_permissions" => {
            let role_id = require_string(&payload, "roleId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(authorization::resolve_role_permissions(
                connection, &role_id,
            )?)
            .map_err(|error| format!("Unable to serialize permissions: {error}"))
        }
        "get_role_instance_permissions" => {
            let instance_id = require_string(&payload, "instanceId")?;
            command_authorization::require_permission(connection, authorization, "policies.read")?;
            serde_json::to_value(authorization::resolve_role_instance_permissions(
                connection,
                &instance_id,
            )?)
            .map_err(|error| format!("Unable to serialize permissions: {error}"))
        }
        "get_worker_overlay" => {
            let worker_type = require_string(&payload, "workerType")?;
            let worker_slug = require_string(&payload, "workerSlug")?;
            let project_slug = payload
                .get("projectSlug")
                .and_then(Value::as_str)
                .unwrap_or("orchestra");
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(project_settings::get_worker_overlay(
                project_slug,
                &worker_type,
                &worker_slug,
            )?)
            .map_err(|error| format!("Unable to serialize worker overlay: {error}"))
        }
        "update_worker_overlay" => {
            let worker_type = require_string(&payload, "workerType")?;
            let worker_slug = require_string(&payload, "workerSlug")?;
            let project_slug = payload
                .get("projectSlug")
                .and_then(Value::as_str)
                .unwrap_or("orchestra");
            let prompt = payload
                .get("prompt")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned);
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.update",
            )?;
            serde_json::to_value(project_settings::update_worker_overlay(
                project_slug,
                &worker_type,
                &worker_slug,
                prompt,
            )?)
            .map_err(|error| format!("Unable to serialize worker overlay: {error}"))
        }
        _ => Err(format!("Unsupported Orchestra bridge command: {command}")),
    }
}

fn require_string(payload: &Value, key: &str) -> Result<String, String> {
    payload
        .get(key)
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Missing required string field: {key}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{AgentUpsertInput, TaskUpsertInput},
        services::{agents, database::initialize_database_at, policies, tasks},
    };
    use rusqlite::params;
    use std::{
        env,
        path::PathBuf,
        sync::Mutex,
        time::{SystemTime, UNIX_EPOCH},
    };

    static TEST_ENV_LOCK: Mutex<()> = Mutex::new(());

    fn unique_temp_db(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix).join("orchestra.db")
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    fn dummy_bridge_config(label: &str) -> ToolBridgeConfig {
        let metadata_path = env::temp_dir().join(format!("{}-bridge.json", label));
        ToolBridgeConfig {
            url: "http://127.0.0.1:0".into(),
            token: "token".into(),
            instance_id: format!("instance-{label}"),
            started_at: crate::state::now_iso(),
            metadata_path,
            owner_pid: std::process::id(),
            app_handle: Mutex::new(None),
            clients: Mutex::new(HashMap::new()),
            recent_requests: Mutex::new(VecDeque::new()),
            recent_cleanup_events: Mutex::new(VecDeque::new()),
        }
    }

    fn with_temp_home<T>(label: &str, action: impl FnOnce() -> T) -> T {
        let _guard = TEST_ENV_LOCK.lock().expect("test env lock should acquire");
        let previous_home = env::var_os("HOME");
        let root = env::temp_dir().join(format!("{}-{}", label, Uuid::new_v4().simple()));
        fs::create_dir_all(&root).expect("temp home should create");
        unsafe {
            env::set_var("HOME", &root);
        }
        let result = action();
        match previous_home {
            Some(value) => unsafe {
                env::set_var("HOME", value);
            },
            None => unsafe {
                env::remove_var("HOME");
            },
        }
        result
    }

    fn bridge_http_request(
        url: &str,
        method: &str,
        path: &str,
        body: Option<String>,
    ) -> serde_json::Value {
        let address = url
            .strip_prefix("http://")
            .expect("bridge url should use http");
        let mut stream = TcpStream::connect(address).expect("bridge should accept connections");
        let payload = body.unwrap_or_default();
        let request = format!(
            "{method} {path} HTTP/1.1\r\nHost: localhost\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{}",
            payload.len(),
            payload,
        );
        stream
            .write_all(request.as_bytes())
            .expect("bridge request should write");
        let mut response = String::new();
        stream
            .read_to_string(&mut response)
            .expect("bridge response should read");
        let body = response.split("\r\n\r\n").nth(1).unwrap_or("{}");
        serde_json::from_str(body).expect("bridge response body should parse")
    }

    #[test]
    fn task_file_reference_commands_round_trip_through_bridge() {
        let mut connection = open_test_connection("tool-bridge-task-files");
        let now = "2026-03-22T00:00:00Z";
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'repo-1', ?1, ?1)",
                [now],
            )
            .expect("project should seed");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-1', 'project-1', 'repo', 'Repo', '/tmp/repo', NULL, 'main', ?1, ?1)",
                [now],
            )
            .expect("repository should seed");
        let task = tasks::create_task(
            &mut connection,
            Some("project-1"),
            TaskUpsertInput {
                title: "Task".into(),
                description: None,
                task_type: "task".into(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: Some("repo-1".into()),
                repository_ids: vec!["repo-1".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should seed");
        crate::services::task_file_references::add_task_file_reference(
            &mut connection,
            &task.id,
            crate::models::TaskFileReferenceInput {
                repository_id: "repo-1".into(),
                relative_path: "docs/design.md".into(),
            },
        )
        .expect("file reference should seed");

        let config = dummy_bridge_config("file-references");
        let listed = invoke_bridge_command(
            &config,
            &connection,
            "list_task_file_references",
            Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            }),
            None,
            json!({ "taskId": task.id }),
        )
        .expect("list_task_file_references should succeed");
        assert_eq!(listed.as_array().map(|items| items.len()), Some(1));
        assert_eq!(
            listed.pointer("/0/relativePath").and_then(Value::as_str),
            Some("docs/design.md")
        );
    }

    #[test]
    fn create_task_bridge_respects_explicit_project_id_and_flat_payloads() {
        with_temp_home("tool-bridge-project-scope", || {
            let connection = crate::services::database::open_connection()
                .expect("database should open in the temp Orchestra home");
            let now = "2026-03-22T00:00:00Z";
            connection
                .execute(
                    "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('project-2', 'project-2', 'Project 2', NULL, NULL, ?1, ?1)",
                    [now],
                )
                .expect("project should seed");

            let config = dummy_bridge_config("project-scope");
            let created = invoke_bridge_command(
                &config,
                &connection,
                "create_task",
                Some(&AuthorizationContext {
                    actor_type: "user".into(),
                    actor_id: "tester".into(),
                }),
                None,
                json!({
                    "projectId": "project-2",
                    "title": "Scoped bridge task",
                    "description": "Should not fall back to orchestra",
                    "type": "task",
                    "status": "ready",
                    "priority": "P2",
                    "assigneeType": "unassigned"
                }),
            )
            .expect("create_task should honor the provided project id");

            assert_eq!(created.get("projectId").and_then(Value::as_str), Some("project-2"));

            let scoped_tasks = invoke_bridge_command(
                &config,
                &connection,
                "list_tasks",
                Some(&AuthorizationContext {
                    actor_type: "user".into(),
                    actor_id: "tester".into(),
                }),
                None,
                json!({ "projectId": "project-2", "includeArchived": false }),
            )
            .expect("list_tasks should respect the provided project id")
            .as_array()
            .cloned()
            .expect("task list should serialize as an array");
            assert_eq!(scoped_tasks.len(), 1);
            assert_eq!(scoped_tasks[0].get("projectId").and_then(Value::as_str), Some("project-2"));

            let orchestra_tasks = invoke_bridge_command(
                &config,
                &connection,
                "list_tasks",
                Some(&AuthorizationContext {
                    actor_type: "user".into(),
                    actor_id: "tester".into(),
                }),
                None,
                json!({ "projectId": "orchestra", "includeArchived": false }),
            )
            .expect("orchestra task list should still load")
            .as_array()
            .cloned()
            .expect("task list should serialize as an array");
            assert!(orchestra_tasks.is_empty());
        });
    }

    #[test]
    fn project_and_repository_commands_round_trip_through_bridge() {
        let mut connection = open_test_connection("tool-bridge-projects");
        let project = projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "Bridge Project".into(),
                description: Some("Project bridge test".into()),
            },
        )
        .expect("project should create");
        let repository = projects::create_repository(
            &connection,
            &project.id,
            crate::models::RepositoryUpsertInput {
                name: "Bridge Repo".into(),
                mode: Some("existing".into()),
                repository_path: Some("/tmp/bridge-repo".into()),
                default_branch: Some("main".into()),
            },
        )
        .expect("repository should create");

        let config = dummy_bridge_config("projects");
        let projects_result = invoke_bridge_command(
            &config,
            &connection,
            "list_projects",
            Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            }),
            None,
            json!({}),
        )
        .expect("list_projects should succeed");
        assert!(projects_result
            .as_array()
            .expect("projects should serialize as an array")
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(project.id.as_str())));

        let project_detail = invoke_bridge_command(
            &config,
            &connection,
            "get_project",
            Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            }),
            None,
            json!({ "projectId": project.id }),
        )
        .expect("get_project should succeed");
        assert_eq!(project_detail.get("id").and_then(Value::as_str), Some(project.id.as_str()));
        assert!(project_detail
            .get("repositories")
            .and_then(Value::as_array)
            .expect("project repositories should serialize as an array")
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(repository.id.as_str())));

        let repositories = invoke_bridge_command(
            &config,
            &connection,
            "list_repositories",
            Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            }),
            None,
            json!({ "projectId": project.id }),
        )
        .expect("list_repositories should succeed");
        assert!(repositories
            .as_array()
            .expect("repositories should serialize as an array")
            .iter()
            .any(|entry| entry.get("id").and_then(Value::as_str) == Some(repository.id.as_str())));

        let repository_detail = invoke_bridge_command(
            &config,
            &connection,
            "get_repository",
            Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            }),
            None,
            json!({ "repositoryId": repository.id }),
        )
        .expect("get_repository should succeed");
        assert_eq!(repository_detail.get("id").and_then(Value::as_str), Some(repository.id.as_str()));
        assert_eq!(repository_detail.get("projectId").and_then(Value::as_str), Some(project.id.as_str()));
    }

    #[test]
    fn invokes_bridge_commands_with_authorization() {
        let mut connection = open_test_connection("tool-bridge");
        let policy = policies::create_policy(
            &mut connection,
            "policy-reader",
            "Policy Reader",
            None,
            &["policies.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', NULL, NULL, NULL, NULL, NULL, 'off', '[]', 0, 0, 0, '2026-03-19T00:00:00Z', '2026-03-19T00:00:00Z')",
                [],
            )
            .expect("agent should seed");
        policies::sync_agent_policy_ids(
            &connection,
            "agent-1",
            std::slice::from_ref(&policy.id),
            "2026-03-19T00:00:00Z",
        )
        .expect("agent policies should sync");

        let config = dummy_bridge_config("auth");

        let result = invoke_bridge_command(
            &config,
            &connection,
            "list_policies",
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
            None,
            json!({}),
        )
        .expect("bridge call should succeed");
        let array = result.as_array().expect("result should be an array");
        assert_eq!(array.len(), 1);

        let error = invoke_bridge_command(
            &config,
            &connection,
            "list_roles",
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
            None,
            json!({}),
        )
        .expect_err("bridge call should be denied");
        assert!(error.contains("roles.read"));
    }

    #[test]
    fn unread_comment_commands_round_trip_through_bridge() {
        let mut connection = open_test_connection("bridge-unread-comments");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Bridge Reader".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                thinking_level: Some("medium".into()),
                policy_ids: Vec::new(),
                direct_permissions: vec!["tasks.read".into(), "tasks.comment".into()],
            },
        )
        .expect("agent should create");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Bridge unread comments".into(),
                description: None,
                task_type: "task".into(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "agent".into(),
                assignee_id: Some(agent.slug.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-bridge', ?1, 'workflow-bridge', 'lane-bridge', 'agent', ?2, 'active', 'session-bridge', '/tmp/bridge', NULL, NULL, 'Prompt', 0, NULL, ?3, NULL, ?3, ?3)",
                params![task.id.as_str(), agent.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");
        let _comment = tasks::add_task_comment(
            &mut connection,
            &task.id,
            crate::models::TaskCommentInput {
                author: "Reviewer".into(),
                message: "Please read this through the bridge.".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
            },
        )
        .expect("comment should add");

        let config = dummy_bridge_config("bridge-unread-comments");
        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent.id.clone(),
        };

        let unread = invoke_bridge_command(
            &config,
            &connection,
            "get_unread_task_comments",
            Some(&authorization),
            Some("session-bridge"),
            json!({ "taskId": task.id }),
        )
        .expect("unread comments should load through bridge");
        let unread_comments = unread
            .as_array()
            .expect("unread comments should be an array");
        assert_eq!(unread_comments.len(), 1);

        let receipts = invoke_bridge_command(
            &config,
            &connection,
            "mark_task_comments_read",
            Some(&authorization),
            Some("session-bridge"),
            json!({ "taskId": task.id }),
        )
        .expect("comment receipts should record through bridge");
        let receipt_entries = receipts.as_array().expect("receipts should be an array");
        assert_eq!(receipt_entries.len(), 1);

        let unread_after = invoke_bridge_command(
            &config,
            &connection,
            "get_unread_task_comments",
            Some(&authorization),
            Some("session-bridge"),
            json!({ "taskId": task.id }),
        )
        .expect("unread comments should reload through bridge");
        assert_eq!(unread_after.as_array().map(Vec::len), Some(0));
    }

    #[test]
    fn serves_concurrent_requests_without_global_serialization() {
        with_temp_home("bridge-concurrency", || {
            let bridge = start_tool_bridge().expect("bridge should start");
            let body_left = serde_json::to_string(&json!({
                "token": bridge.token,
                "command": "__test_sleep",
                "payload": { "sleepMs": 350 },
                "requestId": "left",
                "clientId": "client-left",
                "sessionId": "session-left",
                "bridgeInstanceId": bridge.instance_id,
            }))
            .expect("left request should serialize");
            let body_right = serde_json::to_string(&json!({
                "token": bridge.token,
                "command": "__test_sleep",
                "payload": { "sleepMs": 350 },
                "requestId": "right",
                "clientId": "client-right",
                "sessionId": "session-right",
                "bridgeInstanceId": bridge.instance_id,
            }))
            .expect("right request should serialize");

            let started = std::time::Instant::now();
            let left_url = bridge.url.clone();
            let right_url = bridge.url.clone();
            let left = thread::spawn(move || {
                bridge_http_request(&left_url, "POST", "/invoke", Some(body_left))
            });
            let right = thread::spawn(move || {
                bridge_http_request(&right_url, "POST", "/invoke", Some(body_right))
            });
            let left_response = left.join().expect("left request should join");
            let right_response = right.join().expect("right request should join");
            let elapsed = started.elapsed();

            assert_eq!(
                left_response.get("success").and_then(Value::as_bool),
                Some(true)
            );
            assert_eq!(
                right_response.get("success").and_then(Value::as_bool),
                Some(true)
            );
            assert!(
                elapsed < Duration::from_millis(650),
                "elapsed was {:?}",
                elapsed
            );

            let diagnostics = bridge.diagnostics();
            assert!(diagnostics.recent_requests.len() >= 2);
        });
    }

    #[test]
    fn records_request_diagnostics_per_client() {
        let config = dummy_bridge_config("diagnostics");
        let request = ToolBridgeRequest {
            token: config.token.clone(),
            command: "get_task_context".into(),
            authorization: Some(AuthorizationContext {
                actor_type: "role".into(),
                actor_id: "role-1".into(),
            }),
            payload: json!({ "taskId": "task-1" }),
            request_id: Some("request-1".into()),
            client_id: Some("client-1".into()),
            session_id: Some("session-1".into()),
            bridge_instance_id: Some(config.instance_id.clone()),
            sent_at: Some(crate::state::now_iso()),
        };

        let mut diagnostic = config.record_request_start(&request);
        diagnostic.success = true;
        diagnostic.finished_at = Some(crate::state::now_iso());
        diagnostic.duration_ms = Some(12);
        config.record_request_finish(&diagnostic);

        let snapshot = config.diagnostics();
        assert_eq!(snapshot.instance.active_client_count, 1);
        assert_eq!(snapshot.clients.len(), 1);
        assert_eq!(snapshot.clients[0].client_id, "client-1");
        assert_eq!(snapshot.recent_requests.len(), 1);
        assert_eq!(snapshot.recent_requests[0].request_id, "request-1");
    }

    #[test]
    fn cleans_up_stale_dead_bridge_metadata() {
        with_temp_home("bridge-cleanup", || {
            let bridge_dir = bridge_runtime_dir().expect("bridge runtime dir should resolve");
            fs::create_dir_all(&bridge_dir).expect("bridge dir should create");
            let stale_path = bridge_dir.join("stale.json");
            write_bridge_instance_record(
                &stale_path,
                &BridgeInstanceRecord {
                    service: BRIDGE_SERVICE_NAME.into(),
                    instance_id: "stale-instance".into(),
                    url: "http://127.0.0.1:9".into(),
                    owner_pid: 999_999,
                    executable_path: None,
                    schema_version: BRIDGE_SCHEMA_VERSION,
                    app_version: env!("CARGO_PKG_VERSION").into(),
                    started_at: crate::state::now_iso(),
                    heartbeat_at: crate::state::now_iso(),
                },
            )
            .expect("stale record should write");

            let events = cleanup_stale_bridge_instances("current-instance", None)
                .expect("cleanup should succeed");
            assert!(events
                .iter()
                .any(|event| event.reason == "owner_process_missing"));
            assert!(!stale_path.exists());
        });
    }
}
