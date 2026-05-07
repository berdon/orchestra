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
        MarkTaskCommentsReadInput, NoteLocation, OrchestraToolDefinition, RoleQueueEntryInput,
        SendMailboxMessageInput, TaskAttachmentInput, TaskCommentDomAnchor, TaskCommentInput,
        TaskLaneAssignment, TaskTodoInput, TaskUpsertInput,
    },
    services::{
        agents, authorization, command_authorization, database, live_sessions, messages,
        pi_sessions, policies, project_notes, project_secrets, project_settings, projects,
        reminders, role_runtime, roles, session_management, session_ownership, task_attachments,
        task_browser, task_file_references, task_runtime, tasks, workflows,
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

fn delete_project_via_bridge(
    config: &ToolBridgeConfig,
    connection: &Connection,
    project_id: &str,
) -> Result<crate::models::ProjectDetail, String> {
    let project = projects::get_project(connection, project_id)?;
    let context = pi_sessions::detect_session_context(Some(&project.slug))?;
    let session_ids =
        pi_sessions::list_sessions(&context.session_dir, &std::collections::HashSet::new())?
            .into_iter()
            .map(|session| session.id)
            .collect::<Vec<_>>();

    if let Ok(app_handle) = config.app_handle.lock() {
        if let Some(app) = app_handle.as_ref() {
            let state = app.state::<crate::state::AppState>();
            for session_id in &session_ids {
                if let Some(runtime) = state.remove_session_runtime(session_id)? {
                    runtime.shutdown();
                }
                state.clear_session_tracking(session_id)?;
            }
        }
    }

    projects::delete_project(connection, project_id)
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
    "create_project",
    "update_project",
    "delete_project",
    "list_repositories",
    "get_repository",
    "create_repository",
    "update_repository",
    "delete_repository",
    "attach_repository_remote",
    "set_project_default_repository",
    "list_project_secrets",
    "search_project_secrets",
    "get_project_secret",
    "add_project_secret",
    "update_project_secret",
    "delete_project_secret",
    "list_tasks",
    "get_task",
    "get_task_context",
    "show_task_browser",
    "get_task_browser_state",
    "navigate_task_browser",
    "set_task_browser_inspect_mode",
    "reveal_task_browser_dom_anchor",
    "list_task_comments",
    "list_task_todos",
    "list_unfinished_task_todos",
    "get_unread_task_comments",
    "mark_task_comments_read",
    "get_unread_mail",
    "mark_mail_read",
    "send_mail",
    "remind_me",
    "list_task_repositories",
    "list_task_file_references",
    "add_task_file_reference",
    "remove_task_file_reference",
    "create_task",
    "create_subtask",
    "add_task_todo",
    "mark_task_todo_finished",
    "mark_task_todo_unfinished",
    "delete_task_todo",
    "update_task",
    "comment_on_task",
    "get_task_comment_delete_impact",
    "delete_task_comment",
    "dispatch_task_lane",
    "complete_lane_as_success",
    "complete_lane_as_failure",
    "request_user_intervention",
    "approve_task_review",
    "mark_task_needs_work",
    "resume_task_lane",
    "pause_task_lane",
    "stop_task_activity",
    "list_sessions",
    "get_session_diagnostics",
    "hide_sessions",
    "restore_sessions",
    "delete_sessions",
    "reconcile_sessions",
    "stop_session_runtime",
    "reassign_task_to_lane",
    "add_task_dependency",
    "remove_task_dependency",
    "add_task_attachment",
    "remove_task_attachment",
    "list_workflows",
    "get_workflow",
    "validate_workflow",
    "create_workflow",
    "update_workflow",
    "add_workflow_lane",
    "update_workflow_lane",
    "delete_workflow_lane",
    "reorder_workflow_lanes",
    "duplicate_workflow",
    "archive_workflow",
    "get_workflow_delete_impact",
    "delete_workflow",
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
    #[cfg(test)]
    pub fn test_config() -> Self {
        Self {
            url: "http://127.0.0.1:1".into(),
            token: "token".into(),
            instance_id: "bridge-test".into(),
            started_at: crate::state::now_iso(),
            metadata_path: PathBuf::from("/tmp/orchestra-bridge-test.json"),
            owner_pid: 1,
            app_handle: Mutex::new(None),
            clients: Mutex::new(HashMap::new()),
            recent_requests: Mutex::new(VecDeque::new()),
            recent_cleanup_events: Mutex::new(VecDeque::new()),
        }
    }

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

pub(crate) fn dummy_tool_bridge_config(label: &str) -> Arc<ToolBridgeConfig> {
    let metadata_path = std::env::temp_dir().join(format!("{}-bridge.json", label));
    Arc::new(ToolBridgeConfig {
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
    })
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
            let project_id = payload.get("projectId").and_then(Value::as_str);
            command_authorization::require_permission(connection, authorization, "agents.read")?;
            serde_json::to_value(agents::list_agents_for_project(
                connection,
                include_archived,
                project_id,
            )?)
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
        "create_project" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.create",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse project input: {error}"))?;
            serde_json::to_value(projects::create_project(connection, input)?)
                .map_err(|error| format!("Unable to serialize project: {error}"))
        }
        "update_project" => {
            let project_id = require_string(&payload, "projectId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.update",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse project input: {error}"))?;
            serde_json::to_value(projects::update_project(connection, &project_id, input)?)
                .map_err(|error| format!("Unable to serialize project: {error}"))
        }
        "delete_project" => {
            let project_id = require_string(&payload, "projectId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.delete",
            )?;
            serde_json::to_value(delete_project_via_bridge(config, connection, &project_id)?)
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
        "create_repository" => {
            let project_id = require_string(&payload, "projectId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "repositories.write",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse repository input: {error}"))?;
            serde_json::to_value(projects::create_repository(connection, &project_id, input)?)
                .map_err(|error| format!("Unable to serialize repository: {error}"))
        }
        "update_repository" => {
            let repository_id = require_string(&payload, "repositoryId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "repositories.write",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse repository input: {error}"))?;
            serde_json::to_value(projects::update_repository(
                connection,
                &repository_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize repository: {error}"))
        }
        "delete_repository" => {
            let repository_id = require_string(&payload, "repositoryId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "repositories.write",
            )?;
            serde_json::to_value(projects::delete_repository(connection, &repository_id)?)
                .map_err(|error| format!("Unable to serialize repository: {error}"))
        }
        "attach_repository_remote" => {
            let repository_id = require_string(&payload, "repositoryId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "repositories.write",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse repository remote input: {error}"))?;
            serde_json::to_value(projects::attach_repository_remote(
                connection,
                &repository_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize repository: {error}"))
        }
        "set_project_default_repository" => {
            let project_id = require_string(&payload, "projectId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.update",
            )?;
            let repository_id = payload
                .get("repositoryId")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            serde_json::to_value(projects::set_project_default_repository(
                connection,
                &project_id,
                repository_id,
            )?)
            .map_err(|error| format!("Unable to serialize project: {error}"))
        }
        "list_project_secrets" => {
            let project_slug = resolve_secret_project_slug(
                connection,
                &payload,
                authorization,
                session_id,
                "Create a project first before listing project secrets.",
            )?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.secrets.read",
            )?;
            let filters = project_secret_filter_from_payload(&payload)?;
            let orchestra_root = crate::services::orchestra_paths::default_orchestra_root()?;
            serde_json::to_value(project_secrets::search_project_secrets_with_connection(
                connection,
                Some(&orchestra_root),
                &project_slug,
                &filters,
            )?)
            .map_err(|error| format!("Unable to serialize project secrets: {error}"))
        }
        "search_project_secrets" => {
            let project_slug = resolve_secret_project_slug(
                connection,
                &payload,
                authorization,
                session_id,
                "Create a project first before searching project secrets.",
            )?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.secrets.read",
            )?;
            let filters = project_secret_filter_from_payload(&payload)?;
            let orchestra_root = crate::services::orchestra_paths::default_orchestra_root()?;
            serde_json::to_value(project_secrets::search_project_secrets_with_connection(
                connection,
                Some(&orchestra_root),
                &project_slug,
                &filters,
            )?)
            .map_err(|error| format!("Unable to serialize project secret search results: {error}"))
        }
        "get_project_secret" => {
            let project_slug = resolve_secret_project_slug(
                connection,
                &payload,
                authorization,
                session_id,
                "Create a project first before loading a project secret.",
            )?;
            let secret_key = require_string(&payload, "secretKey")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.secrets.use",
            )?;
            serde_json::to_value(project_secrets::get_project_secret_value(
                &project_slug,
                &secret_key,
            )?)
            .map_err(|error| format!("Unable to serialize project secret value: {error}"))
        }
        "add_project_secret" => {
            let project_slug = resolve_secret_project_slug(
                connection,
                &payload,
                authorization,
                session_id,
                "Create a project first before creating a project secret.",
            )?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.secrets.write",
            )?;
            let input = serde_json::from_value(payload.clone())
                .map_err(|error| format!("Unable to parse project secret input: {error}"))?;
            serde_json::to_value(project_secrets::create_project_secret(
                &project_slug,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize project secrets: {error}"))
        }
        "update_project_secret" => {
            let project_slug = resolve_secret_project_slug(
                connection,
                &payload,
                authorization,
                session_id,
                "Create a project first before updating a project secret.",
            )?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.secrets.write",
            )?;
            let input = serde_json::from_value(payload.clone())
                .map_err(|error| format!("Unable to parse project secret input: {error}"))?;
            serde_json::to_value(project_secrets::update_project_secret(
                &project_slug,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize project secrets: {error}"))
        }
        "delete_project_secret" => {
            let project_slug = resolve_secret_project_slug(
                connection,
                &payload,
                authorization,
                session_id,
                "Create a project first before deleting a project secret.",
            )?;
            let secret_key = require_string(&payload, "secretKey")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "projects.secrets.write",
            )?;
            serde_json::to_value(project_secrets::delete_project_secret(
                &project_slug,
                &secret_key,
            )?)
            .map_err(|error| format!("Unable to serialize project secrets: {error}"))
        }
        "list_notes" => {
            command_authorization::require_permission(connection, authorization, "notes.read")?;
            let project_id = projects::require_requested_or_default_project_id(
                connection,
                payload.get("projectId").and_then(Value::as_str),
                "projectId: A project id is required when no default project exists.",
            )?;
            serde_json::to_value(project_notes::list_project_notes(connection, &project_id)?)
                .map_err(|error| format!("Unable to serialize project notes: {error}"))
        }
        "get_note" => {
            command_authorization::require_permission(connection, authorization, "notes.read")?;
            let project_id = projects::require_requested_or_default_project_id(
                connection,
                payload.get("projectId").and_then(Value::as_str),
                "projectId: A project id is required when no default project exists.",
            )?;
            let location: NoteLocation =
                serde_json::from_value(payload.get("location").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse note location: {error}"))?;
            serde_json::to_value(project_notes::get_project_note(
                connection,
                &project_id,
                location,
            )?)
            .map_err(|error| format!("Unable to serialize project note: {error}"))
        }
        "update_note" => {
            command_authorization::require_permission(connection, authorization, "notes.write")?;
            let project_id = projects::require_requested_or_default_project_id(
                connection,
                payload.get("projectId").and_then(Value::as_str),
                "projectId: A project id is required when no default project exists.",
            )?;
            let location: NoteLocation =
                serde_json::from_value(payload.get("location").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse note location: {error}"))?;
            let markdown = require_string(&payload, "markdown")?;
            serde_json::to_value(project_notes::update_project_note(
                connection,
                &project_id,
                location,
                markdown,
            )?)
            .map_err(|error| format!("Unable to serialize project note: {error}"))
        }
        "delete_note" => {
            command_authorization::require_permission(connection, authorization, "notes.write")?;
            let project_id = projects::require_requested_or_default_project_id(
                connection,
                payload.get("projectId").and_then(Value::as_str),
                "projectId: A project id is required when no default project exists.",
            )?;
            let location: NoteLocation =
                serde_json::from_value(payload.get("location").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse note location: {error}"))?;
            serde_json::to_value(project_notes::delete_project_note(
                connection,
                &project_id,
                location,
            )?)
            .map_err(|error| format!("Unable to serialize deleted project note: {error}"))
        }
        "copy_note" => {
            command_authorization::require_permission(connection, authorization, "notes.write")?;
            let project_id = projects::require_requested_or_default_project_id(
                connection,
                payload.get("projectId").and_then(Value::as_str),
                "projectId: A project id is required when no default project exists.",
            )?;
            let source: NoteLocation =
                serde_json::from_value(payload.get("source").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse source note location: {error}"))?;
            let destination: NoteLocation =
                serde_json::from_value(payload.get("destination").cloned().unwrap_or(Value::Null))
                    .map_err(|error| {
                        format!("Unable to parse destination note location: {error}")
                    })?;
            serde_json::to_value(project_notes::copy_project_note(
                connection,
                &project_id,
                source,
                destination,
            )?)
            .map_err(|error| format!("Unable to serialize copied project note: {error}"))
        }
        "move_note" => {
            command_authorization::require_permission(connection, authorization, "notes.write")?;
            let project_id = projects::require_requested_or_default_project_id(
                connection,
                payload.get("projectId").and_then(Value::as_str),
                "projectId: A project id is required when no default project exists.",
            )?;
            let source: NoteLocation =
                serde_json::from_value(payload.get("source").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse source note location: {error}"))?;
            let destination: NoteLocation =
                serde_json::from_value(payload.get("destination").cloned().unwrap_or(Value::Null))
                    .map_err(|error| {
                        format!("Unable to parse destination note location: {error}")
                    })?;
            serde_json::to_value(project_notes::move_project_note(
                connection,
                &project_id,
                source,
                destination,
            )?)
            .map_err(|error| format!("Unable to serialize moved project note: {error}"))
        }
        "list_sessions" => {
            command_authorization::require_permission(connection, authorization, "sessions.read")?;
            let query =
                serde_json::from_value::<session_management::SessionManagementQuery>(payload)
                    .map_err(|error| format!("Unable to parse list_sessions input: {error}"))?;
            let app = config.clone_app_handle();
            let state = app
                .as_ref()
                .map(|app| app.state::<crate::state::AppState>());
            serde_json::to_value(session_management::list_sessions(
                connection,
                state.as_deref(),
                query,
            )?)
            .map_err(|error| format!("Unable to serialize sessions: {error}"))
        }
        "get_session_diagnostics" => {
            let session_id = require_string(&payload, "sessionId")?;
            command_authorization::require_permission(connection, authorization, "sessions.read")?;
            let app = config.clone_app_handle();
            let state = app
                .as_ref()
                .map(|app| app.state::<crate::state::AppState>());
            serde_json::to_value(session_management::get_session_diagnostics(
                connection,
                app.as_ref(),
                state.as_deref(),
                &session_id,
            )?)
            .map_err(|error| format!("Unable to serialize session diagnostics: {error}"))
        }
        "hide_sessions" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "sessions.delete",
            )?;
            let input = serde_json::from_value::<session_management::SessionMutationInput>(payload)
                .map_err(|error| format!("Unable to parse hide_sessions input: {error}"))?;
            let result = session_management::hide_sessions(connection, input)?;
            if !result.dry_run {
                if let Some(app) = config.clone_app_handle() {
                    if !result.changed_session_ids.is_empty() {
                        let _ = crate::services::app_events::emit_session_change(
                            &app,
                            "sessions.hide",
                            result.changed_session_ids.clone(),
                        );
                    }
                }
            }
            serde_json::to_value(result)
                .map_err(|error| format!("Unable to serialize session hide result: {error}"))
        }
        "restore_sessions" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "sessions.delete",
            )?;
            let input = serde_json::from_value::<session_management::SessionMutationInput>(payload)
                .map_err(|error| format!("Unable to parse restore_sessions input: {error}"))?;
            let result = session_management::restore_sessions(connection, input)?;
            if !result.dry_run {
                if let Some(app) = config.clone_app_handle() {
                    if !result.changed_session_ids.is_empty() {
                        let _ = crate::services::app_events::emit_session_change(
                            &app,
                            "sessions.restore",
                            result.changed_session_ids.clone(),
                        );
                    }
                }
            }
            serde_json::to_value(result)
                .map_err(|error| format!("Unable to serialize session restore result: {error}"))
        }
        "delete_sessions" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "sessions.delete",
            )?;
            let input = serde_json::from_value::<session_management::SessionMutationInput>(payload)
                .map_err(|error| format!("Unable to parse delete_sessions input: {error}"))?;
            if input.stop_active_runtimes {
                command_authorization::require_permission(
                    connection,
                    authorization,
                    "sessions.stop",
                )?;
            }
            let app = config.clone_app_handle();
            let state = app
                .as_ref()
                .map(|app| app.state::<crate::state::AppState>());
            serde_json::to_value(session_management::delete_sessions(
                connection,
                app.as_ref(),
                state.as_deref(),
                input,
                session_id,
            )?)
            .map_err(|error| format!("Unable to serialize session delete result: {error}"))
        }
        "reconcile_sessions" => {
            command_authorization::require_permission(
                connection,
                authorization,
                "sessions.delete",
            )?;
            let input =
                serde_json::from_value::<session_management::SessionReconcileInput>(payload)
                    .map_err(|error| {
                        format!("Unable to parse reconcile_sessions input: {error}")
                    })?;
            let result = session_management::reconcile_sessions(connection, input)?;
            if !result.dry_run {
                if let Some(app) = config.clone_app_handle() {
                    if !result.changed_session_ids.is_empty() {
                        let _ = crate::services::app_events::emit_session_change(
                            &app,
                            "sessions.reconcile",
                            result.changed_session_ids.clone(),
                        );
                    }
                }
            }
            serde_json::to_value(result)
                .map_err(|error| format!("Unable to serialize session reconcile result: {error}"))
        }
        "stop_session_runtime" => {
            let session_id = require_string(&payload, "sessionId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(connection, authorization, "sessions.stop")?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "No app handle available for stop_session_runtime".to_string())?;
            let app_for_state = app.clone();
            let state = app_for_state.state::<crate::state::AppState>();
            serde_json::to_value(tauri::async_runtime::block_on(
                crate::commands::sessions::stop_session_runtime(app, state, session_id, notes),
            )?)
            .map_err(|error| format!("Unable to serialize stopped session runtime: {error}"))
        }
        "list_tasks" => {
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let Some(project_id) = projects::resolve_requested_or_default_project_id(
                connection,
                payload
                    .get("projectId")
                    .and_then(Value::as_str)
                    .filter(|value| !value.trim().is_empty()),
            )?
            else {
                return serde_json::to_value(Vec::<crate::models::TaskSummary>::new())
                    .map_err(|error| format!("Unable to serialize tasks: {error}"));
            };
            let tags = match payload.get("tags") {
                Some(value) if !value.is_null() => Some(
                    serde_json::from_value::<Vec<String>>(value.clone())
                        .map_err(|error| format!("Unable to parse list_tasks tags: {error}"))?,
                ),
                _ => None,
            };
            let query = tasks::TaskListQuery::from_raw(
                payload.get("includeArchived").and_then(Value::as_bool),
                tags,
                payload.get("tagMatch").and_then(Value::as_str),
                payload.get("sortBy").and_then(Value::as_str),
                payload.get("sortDirection").and_then(Value::as_str),
            )?;
            serde_json::to_value(tasks::list_tasks_with_query(
                connection,
                &project_id,
                query,
            )?)
            .map_err(|error| format!("Unable to serialize tasks: {error}"))
        }
        "get_task" | "get_task_context" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            serde_json::to_value(tasks::get_task_context(connection, &task_id)?)
                .map_err(|error| format!("Unable to serialize task context: {error}"))
        }
        "show_task_browser" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.browser.control",
            )?;
            let app = config.clone_app_handle().ok_or_else(|| {
                "Orchestra app handle unavailable for task browser show".to_string()
            })?;
            serde_json::to_value(task_browser::show_task_browser(&app, &task_id)?)
                .map_err(|error| format!("Unable to serialize task browser session: {error}"))
        }
        "get_task_browser_state" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.browser.read",
            )?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(task_browser::ensure_task_browser_session(
                &mut writable,
                &task_id,
            )?)
            .map_err(|error| format!("Unable to serialize task browser session: {error}"))
        }
        "navigate_task_browser" => {
            let task_id = require_string(&payload, "taskId")?;
            let url = require_string(&payload, "url")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.browser.control",
            )?;
            let app = config.clone_app_handle().ok_or_else(|| {
                "Orchestra app handle unavailable for task browser navigation".to_string()
            })?;
            serde_json::to_value(task_browser::navigate_task_browser(&app, &task_id, &url)?)
                .map_err(|error| format!("Unable to serialize task browser session: {error}"))
        }
        "set_task_browser_inspect_mode" => {
            let task_id = require_string(&payload, "taskId")?;
            let enabled = payload
                .get("enabled")
                .and_then(Value::as_bool)
                .ok_or_else(|| "enabled: Boolean inspect-mode flag is required.".to_string())?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.browser.control",
            )?;
            let app = config.clone_app_handle().ok_or_else(|| {
                "Orchestra app handle unavailable for task browser inspect mode".to_string()
            })?;
            serde_json::to_value(task_browser::set_task_browser_inspect_mode(
                &app, &task_id, enabled,
            )?)
            .map_err(|error| format!("Unable to serialize task browser session: {error}"))
        }
        "reveal_task_browser_dom_anchor" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.browser.control",
            )?;
            let anchor: TaskCommentDomAnchor =
                serde_json::from_value(payload.get("anchor").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task browser DOM anchor: {error}"))?;
            let app = config.clone_app_handle().ok_or_else(|| {
                "Orchestra app handle unavailable for task browser anchor reveal".to_string()
            })?;
            serde_json::to_value(task_browser::reveal_task_browser_dom_anchor(
                &app, &task_id, &anchor,
            )?)
            .map_err(|error| format!("Unable to serialize task browser session: {error}"))
        }
        "list_task_comments" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            serde_json::to_value(tasks::list_task_comments(connection, &task_id)?)
                .map_err(|error| format!("Unable to serialize task comments: {error}"))
        }
        "list_task_todos" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            serde_json::to_value(tasks::list_task_todos(connection, &task_id)?)
                .map_err(|error| format!("Unable to serialize task todos: {error}"))
        }
        "list_unfinished_task_todos" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let lane_id = payload.get("laneId").and_then(Value::as_str);
            serde_json::to_value(tasks::list_unfinished_task_todos(
                connection, &task_id, lane_id,
            )?)
            .map_err(|error| format!("Unable to serialize unfinished task todos: {error}"))
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
            let input: SendMailboxMessageInput = serde_json::from_value(
                payload
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| payload.clone()),
            )
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
            let _ = crate::services::app_events::emit_inbox_change(
                &app,
                "mailbox.sent",
                [message.delivery_id.clone()],
            );
            if let Some(task_id) = message.task_id.clone() {
                let _ =
                    crate::services::app_events::emit_task_change(&app, "mailbox.sent", [task_id]);
            }
            let _ = crate::services::notifications::publish_mailbox_notification(
                Some(&app),
                connection,
                &message,
            );
            serde_json::to_value(message)
                .map_err(|error| format!("Unable to serialize mailbox message: {error}"))
        }
        "remind_me" => {
            command_authorization::require_permission(connection, authorization, "tasks.read")?;
            let input: reminders::RemindMeInput = serde_json::from_value(
                payload
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| payload.clone()),
            )
            .map_err(|error| format!("Unable to parse remind_me input: {error}"))?;
            serde_json::to_value(reminders::schedule_reminder_for_authorization(
                connection,
                authorization,
                session_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize reminder: {error}"))
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
            let task_workspace_cwd = task
                .active_lane_assignment
                .as_ref()
                .map(|assignment| {
                    task_runtime::resolve_assignment_workspace_cwd(
                        connection,
                        assignment,
                        &task_id,
                        &task.project_id,
                    )
                })
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
            let task = if let Some(app) = config.clone_app_handle() {
                crate::commands::tasks::create_task(
                    app.clone(),
                    app.state::<crate::state::AppState>(),
                    project_id,
                    input,
                )?
            } else {
                let mut writable = database::open_connection()?;
                tasks::create_task(&mut writable, project_id.as_deref(), input)?
            };
            serde_json::to_value(task).map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "create_subtask" => {
            let parent_task_id = require_string(&payload, "parentTaskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.create")?;
            let input: TaskUpsertInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task input: {error}"))?;
            let task = if let Some(app) = config.clone_app_handle() {
                crate::commands::tasks::create_subtask(
                    app.clone(),
                    app.state::<crate::state::AppState>(),
                    parent_task_id,
                    input,
                )?
            } else {
                let mut writable = database::open_connection()?;
                tasks::create_subtask(&mut writable, &parent_task_id, input)?
            };
            serde_json::to_value(task).map_err(|error| format!("Unable to serialize task: {error}"))
        }
        "add_task_todo" => {
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            let input: TaskTodoInput = serde_json::from_value(
                payload
                    .get("input")
                    .cloned()
                    .unwrap_or_else(|| payload.clone()),
            )
            .map_err(|error| format!("Unable to parse task todo input: {error}"))?;
            let payload_task_id = payload
                .get("taskId")
                .and_then(Value::as_str)
                .filter(|value| !value.trim().is_empty())
                .map(str::to_string);
            let inferred_context = if payload_task_id.is_none() {
                Some(resolve_active_worker_task_context(
                    connection,
                    authorization,
                    session_id,
                )?)
            } else {
                None
            };
            let task_id = payload_task_id
                .or_else(|| {
                    inferred_context
                        .as_ref()
                        .map(|(task_id, _)| task_id.clone())
                })
                .ok_or_else(|| {
                    "taskId: Task id is required when there is no active worker assignment."
                        .to_string()
                })?;
            serde_json::to_value(tasks::add_task_todo_with_authorization(
                connection,
                &task_id,
                input,
                authorization,
            )?)
            .map_err(|error| format!("Unable to serialize task todo: {error}"))
        }
        "mark_task_todo_finished" => {
            let todo_id = require_string(&payload, "todoId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            serde_json::to_value(tasks::mark_task_todo_finished(connection, &todo_id)?)
                .map_err(|error| format!("Unable to serialize task todo: {error}"))
        }
        "mark_task_todo_unfinished" => {
            let todo_id = require_string(&payload, "todoId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            serde_json::to_value(tasks::mark_task_todo_unfinished(connection, &todo_id)?)
                .map_err(|error| format!("Unable to serialize task todo: {error}"))
        }
        "delete_task_todo" => {
            let todo_id = require_string(&payload, "todoId")?;
            command_authorization::require_permission(connection, authorization, "tasks.update")?;
            serde_json::to_value(tasks::delete_task_todo(connection, &todo_id)?)
                .map_err(|error| format!("Unable to serialize task todo: {error}"))
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
            let mut input: TaskCommentInput =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse task comment input: {error}"))?;
            if input.origin_type.is_none() {
                if let Some(context) = authorization {
                    input.origin_type = Some(match context.actor_type.as_str() {
                        "agent" => "agent".into(),
                        "role" | "role_instance" => "role".into(),
                        "user" => "user".into(),
                        _ => "system".into(),
                    });
                    input.origin_id = input.origin_id.or_else(|| Some(context.actor_id.clone()));
                }
            }
            let mut writable = database::open_connection()?;
            let comment = tasks::add_task_comment(&mut writable, &task_id, input)?;
            let task = tasks::get_task(&writable, &task_id)?;
            if let Some(target) =
                crate::services::task_runtime::resolve_task_comment_notification_target(
                    &writable, &task, &comment,
                )?
            {
                let is_self_active_worker_comment = matches!(
                    &target,
                    crate::services::task_runtime::TaskCommentNotificationTarget::ActiveWorker(assignment)
                        if crate::services::task_runtime::assignment_owned_by_worker_authorization(
                            assignment,
                            authorization,
                        )
                );
                if is_self_active_worker_comment {
                    if let crate::services::task_runtime::TaskCommentNotificationTarget::ActiveWorker(
                        assignment,
                    ) = &target
                    {
                        let comment_ids = vec![comment.id.clone()];
                        let _ = tasks::mark_task_comments_read(
                            &writable,
                            &task_id,
                            assignment,
                            Some(&comment_ids),
                        )?;
                    }
                } else {
                    let warning = if let Some(app) = config.clone_app_handle() {
                        let state = app.state::<crate::state::AppState>();
                        crate::services::task_runtime::dispatch_task_comment_notification_target(
                            Some(&app),
                            Some(&state),
                            &writable,
                            &task,
                            &comment,
                            &target,
                        )
                    } else {
                        crate::services::task_runtime::dispatch_task_comment_notification_target(
                            None, None, &writable, &task, &comment, &target,
                        )
                    };
                    if let Some(warning) = warning {
                        config.log_bridge_event(
                            "warn",
                            "task.comment.notification_failed",
                            &format!(
                                "Comment {} on task {} was saved, but unread notification delivery degraded: {}",
                                comment.id, task_id, warning
                            ),
                        );
                    }
                }
            }
            serde_json::to_value(comment)
                .map_err(|error| format!("Unable to serialize task comment: {error}"))
        }
        "get_task_comment_delete_impact" => {
            let comment_id = require_string(&payload, "commentId")?;
            command_authorization::require_permission(connection, authorization, "tasks.comment")?;
            let impact = tasks::get_task_comment_delete_impact(connection, &comment_id)?;
            serde_json::to_value(impact)
                .map_err(|error| format!("Unable to serialize comment delete impact: {error}"))
        }
        "delete_task_comment" => {
            let comment_id = require_string(&payload, "commentId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "tasks.comment.delete",
            )?;
            let mut writable = database::open_connection()?;
            let comment = tasks::delete_task_comment(&mut writable, &comment_id)?;
            serde_json::to_value(comment)
                .map_err(|error| format!("Unable to serialize deleted comment: {error}"))
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
            let summary = require_string(&payload, "summary")?;
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
            let previous_assignment =
                crate::services::task_runtime::get_current_lane_assignment(&writable, &task_id)?;
            let task = crate::services::task_runtime::complete_lane_as_success_with_app(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                Some(summary),
                notes,
                None,
                authorization,
            )?;
            let auto_dispatches =
                crate::services::task_runtime::collect_post_completion_auto_dispatches(
                    &mut writable,
                    &task_id,
                )?;
            for outcome in &auto_dispatches {
                config.start_assignment_async(outcome.session_dir.clone(), &outcome.assignment)?;
            }
            if let Some(session_id) =
                crate::services::task_runtime::transitioned_assignment_session_to_retire(
                    previous_assignment.as_ref(),
                    &task,
                )
            {
                if let Some(app) = config.clone_app_handle() {
                    live_sessions::schedule_session_retirement(
                        app,
                        session_id,
                        Duration::from_millis(250),
                        "tool.complete_lane_as_success",
                    );
                }
            }
            if let Some(app) = config.clone_app_handle() {
                let mut changed_task_ids = vec![task.id.clone()];
                changed_task_ids.extend(
                    auto_dispatches
                        .iter()
                        .map(|outcome| outcome.task_id.clone()),
                );
                let _ = crate::services::app_events::emit_task_change(
                    &app,
                    crate::services::task_runtime::task_transition_event_reason("success", &task),
                    changed_task_ids,
                );
                let session_ids = auto_dispatches
                    .iter()
                    .filter_map(|outcome| outcome.assignment.session_id.clone())
                    .collect::<Vec<_>>();
                if !session_ids.is_empty() {
                    let _ = crate::services::app_events::emit_session_change(
                        &app,
                        "task.transition.next_assignment",
                        session_ids,
                    );
                }
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize completed task lane: {error}"))
        }
        "complete_lane_as_failure" => {
            let task_id = require_string(&payload, "taskId")?;
            let summary = require_string(&payload, "summary")?;
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
            let previous_assignment =
                crate::services::task_runtime::get_current_lane_assignment(&writable, &task_id)?;
            let task = crate::services::task_runtime::complete_lane_as_failure_with_app(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                Some(summary),
                notes,
                None,
                authorization,
            )?;
            let auto_dispatches =
                crate::services::task_runtime::collect_post_completion_auto_dispatches(
                    &mut writable,
                    &task_id,
                )?;
            for outcome in &auto_dispatches {
                config.start_assignment_async(outcome.session_dir.clone(), &outcome.assignment)?;
            }
            if let Some(session_id) =
                crate::services::task_runtime::transitioned_assignment_session_to_retire(
                    previous_assignment.as_ref(),
                    &task,
                )
            {
                if let Some(app) = config.clone_app_handle() {
                    live_sessions::schedule_session_retirement(
                        app,
                        session_id,
                        Duration::from_millis(250),
                        "tool.complete_lane_as_failure",
                    );
                }
            }
            if let Some(app) = config.clone_app_handle() {
                let mut changed_task_ids = vec![task.id.clone()];
                changed_task_ids.extend(
                    auto_dispatches
                        .iter()
                        .map(|outcome| outcome.task_id.clone()),
                );
                let _ = crate::services::app_events::emit_task_change(
                    &app,
                    crate::services::task_runtime::task_transition_event_reason("failure", &task),
                    changed_task_ids,
                );
                let session_ids = auto_dispatches
                    .iter()
                    .filter_map(|outcome| outcome.assignment.session_id.clone())
                    .collect::<Vec<_>>();
                if !session_ids.is_empty() {
                    let _ = crate::services::app_events::emit_session_change(
                        &app,
                        "task.transition.next_assignment",
                        session_ids,
                    );
                }
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize failed task lane: {error}"))
        }
        "request_user_intervention" => {
            let task_id = require_string(&payload, "taskId")?;
            let summary = require_string(&payload, "summary")?;
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
            let previous_assignment =
                crate::services::task_runtime::get_current_lane_assignment(&writable, &task_id)?;
            let task = crate::services::task_runtime::request_user_intervention_with_app(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                Some(summary),
                notes,
                None,
                authorization,
            )?;
            if let Some(session_id) =
                crate::services::task_runtime::transitioned_assignment_session_to_retire(
                    previous_assignment.as_ref(),
                    &task,
                )
            {
                if let Some(app) = config.clone_app_handle() {
                    live_sessions::schedule_session_retirement(
                        app,
                        session_id,
                        Duration::from_millis(250),
                        "tool.request_user_intervention",
                    );
                }
            }
            if let Some(app) = config.clone_app_handle() {
                let _ = crate::services::app_events::emit_task_change(
                    &app,
                    crate::services::task_runtime::task_transition_event_reason(
                        "needs_user",
                        &task,
                    ),
                    [task.id.clone()],
                );
            }
            serde_json::to_value(task).map_err(|error| {
                format!("Unable to serialize user-intervention task lane: {error}")
            })
        }
        "approve_task_review" => {
            let task_id = require_string(&payload, "taskId")?;
            command_authorization::require_permission(connection, authorization, "tasks.review")?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "No app handle available for approve_task_review".to_string())?;
            let app_for_state = app.clone();
            let state = app_for_state.state::<crate::state::AppState>();
            serde_json::to_value(tauri::async_runtime::block_on(
                crate::commands::tasks::approve_task_review(app, state, task_id),
            )?)
            .map_err(|error| format!("Unable to serialize approved task review: {error}"))
        }
        "mark_task_needs_work" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.review")?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "No app handle available for mark_task_needs_work".to_string())?;
            let app_for_state = app.clone();
            let state = app_for_state.state::<crate::state::AppState>();
            serde_json::to_value(tauri::async_runtime::block_on(
                crate::commands::tasks::mark_task_needs_work(app, state, task_id, notes),
            )?)
            .map_err(|error| format!("Unable to serialize review rework task: {error}"))
        }
        "resume_task_lane" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.control")?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "No app handle available for resume_task_lane".to_string())?;
            let app_for_state = app.clone();
            let state = app_for_state.state::<crate::state::AppState>();
            serde_json::to_value(tauri::async_runtime::block_on(
                crate::commands::tasks::resume_task_lane(app, state, task_id, notes),
            )?)
            .map_err(|error| format!("Unable to serialize resumed task lane: {error}"))
        }
        "pause_task_lane" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.control")?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "No app handle available for pause_task_lane".to_string())?;
            let app_for_state = app.clone();
            let state = app_for_state.state::<crate::state::AppState>();
            serde_json::to_value(tauri::async_runtime::block_on(
                crate::commands::tasks::pause_task_lane(app, state, task_id, notes),
            )?)
            .map_err(|error| format!("Unable to serialize paused task lane: {error}"))
        }
        "stop_task_activity" => {
            let task_id = require_string(&payload, "taskId")?;
            let notes = payload
                .get("notes")
                .and_then(Value::as_str)
                .map(str::to_string);
            command_authorization::require_permission(connection, authorization, "tasks.control")?;
            let app = config
                .clone_app_handle()
                .ok_or_else(|| "No app handle available for stop_task_activity".to_string())?;
            let app_for_state = app.clone();
            let state = app_for_state.state::<crate::state::AppState>();
            serde_json::to_value(tauri::async_runtime::block_on(
                crate::commands::tasks::stop_task_activity(app, state, task_id, notes),
            )?)
            .map_err(|error| format!("Unable to serialize stopped task activity: {error}"))
        }
        "reassign_task_to_lane" => {
            let task_id = require_string(&payload, "taskId")?;
            let lane_id = require_string(&payload, "laneId")?;
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
            let previous_assignment =
                crate::services::task_runtime::get_current_lane_assignment(&writable, &task_id)?;
            let app = config.clone_app_handle();
            let task = crate::services::task_runtime::reassign_task_to_lane_with_app(
                &mut writable,
                &context.project_root,
                &context.session_dir,
                &task_id,
                &lane_id,
                notes,
                app.as_ref(),
                authorization,
            )?;
            for outcome in crate::services::task_runtime::collect_post_completion_auto_dispatches(
                &mut writable,
                &task_id,
            )? {
                config.start_assignment_async(outcome.session_dir, &outcome.assignment)?;
            }
            if let Some(session_id) =
                crate::services::task_runtime::transitioned_assignment_session_to_retire(
                    previous_assignment.as_ref(),
                    &task,
                )
            {
                if let Some(app) = config.clone_app_handle() {
                    live_sessions::schedule_session_retirement(
                        app,
                        session_id,
                        Duration::from_millis(250),
                        "tool.reassign_task_to_lane",
                    );
                }
            }
            serde_json::to_value(task)
                .map_err(|error| format!("Unable to serialize re-laned task: {error}"))
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
        "validate_workflow" => {
            command_authorization::require_permission(connection, authorization, "workflows.read")?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse workflow input: {error}"))?;
            serde_json::to_value(workflows::validate_workflow(connection, &input)?)
                .map_err(|error| format!("Unable to serialize workflow validation: {error}"))
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
        "add_workflow_lane" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.update",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| format!("Unable to parse workflow lane input: {error}"))?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::add_workflow_lane(
                &mut writable,
                &workflow_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "update_workflow_lane" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            let lane_id = require_string(&payload, "laneId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.update",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| {
                        format!("Unable to parse workflow lane patch input: {error}")
                    })?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::update_workflow_lane(
                &mut writable,
                &workflow_id,
                &lane_id,
                input,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "delete_workflow_lane" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            let lane_id = require_string(&payload, "laneId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.update",
            )?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::delete_workflow_lane(
                &mut writable,
                &workflow_id,
                &lane_id,
            )?)
            .map_err(|error| format!("Unable to serialize workflow: {error}"))
        }
        "reorder_workflow_lanes" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.update",
            )?;
            let input =
                serde_json::from_value(payload.get("input").cloned().unwrap_or(Value::Null))
                    .map_err(|error| {
                        format!("Unable to parse workflow lane reorder input: {error}")
                    })?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::reorder_workflow_lanes(
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
        "get_workflow_delete_impact" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(connection, authorization, "workflows.read")?;
            serde_json::to_value(workflows::get_workflow_delete_impact(
                connection,
                &workflow_id,
            )?)
            .map_err(|error| format!("Unable to serialize workflow delete impact: {error}"))
        }
        "delete_workflow" => {
            let workflow_id = require_string(&payload, "workflowId")?;
            command_authorization::require_permission(
                connection,
                authorization,
                "workflows.delete",
            )?;
            let mut writable = database::open_connection()?;
            serde_json::to_value(workflows::delete_workflow(&mut writable, &workflow_id)?)
                .map_err(|error| format!("Unable to serialize workflow delete result: {error}"))
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
            let project_slug = projects::require_requested_or_default_project_slug(
                connection,
                payload.get("projectSlug").and_then(Value::as_str),
                "Create a project first before reading worker overlays.",
            )?;
            command_authorization::require_permission(connection, authorization, "projects.read")?;
            serde_json::to_value(project_settings::get_worker_overlay(
                &project_slug,
                &worker_type,
                &worker_slug,
            )?)
            .map_err(|error| format!("Unable to serialize worker overlay: {error}"))
        }
        "update_worker_overlay" => {
            let worker_type = require_string(&payload, "workerType")?;
            let worker_slug = require_string(&payload, "workerSlug")?;
            let project_slug = projects::require_requested_or_default_project_slug(
                connection,
                payload.get("projectSlug").and_then(Value::as_str),
                "Create a project first before updating worker overlays.",
            )?;
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
                &project_slug,
                &worker_type,
                &worker_slug,
                prompt,
            )?)
            .map_err(|error| format!("Unable to serialize worker overlay: {error}"))
        }
        _ => Err(format!("Unsupported Orchestra bridge command: {command}")),
    }
}

fn project_secret_filter_from_payload(
    payload: &Value,
) -> Result<project_secrets::ProjectSecretMetadataFilter, String> {
    Ok(project_secrets::ProjectSecretMetadataFilter {
        query: payload
            .get("query")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        secret_key: payload
            .get("secretKey")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        value_state: payload
            .get("valueState")
            .and_then(Value::as_str)
            .map(ToOwned::to_owned),
        has_description: payload.get("hasDescription").and_then(Value::as_bool),
    })
}

fn resolve_secret_project_slug(
    connection: &Connection,
    payload: &Value,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
    missing_message: &str,
) -> Result<String, String> {
    if let Some(project_id) = payload.get("projectId").and_then(Value::as_str) {
        return Ok(projects::get_project(connection, project_id)?.slug);
    }
    if let Some(project_slug) = payload.get("projectSlug").and_then(Value::as_str) {
        return projects::require_requested_or_default_project_slug(
            connection,
            Some(project_slug),
            missing_message,
        );
    }
    if let Some(task_id) = payload.get("taskId").and_then(Value::as_str) {
        let task = tasks::get_task_context(connection, task_id)?;
        return Ok(projects::get_project(connection, &task.project_id)?.slug);
    }
    if let Ok((task_id, _lane_id)) =
        resolve_active_worker_task_context(connection, authorization, session_id)
    {
        let task = tasks::get_task_context(connection, &task_id)?;
        return Ok(projects::get_project(connection, &task.project_id)?.slug);
    }
    projects::require_requested_or_default_project_slug(connection, None, missing_message)
}

fn resolve_active_worker_task_context(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
) -> Result<(String, String), String> {
    if let Some(session_id) = session_id {
        if let Some(assignment) =
            session_ownership::load_session_open_assignment(connection, session_id)?
        {
            if task_runtime::assignment_owned_by_worker_authorization(&assignment, authorization) {
                return Ok((assignment.task_id, assignment.lane_id));
            }
        }
    }

    let authorization = authorization.ok_or_else(|| {
        "This command requires an active worker authorization context when taskId is omitted."
            .to_string()
    })?;

    if let Some(worker_session_id) =
        session_ownership::load_worker_session_from_authorization(connection, authorization)?
    {
        if let Some(assignment) =
            session_ownership::load_session_open_assignment(connection, &worker_session_id)?
        {
            if task_runtime::assignment_owned_by_worker_authorization(
                &assignment,
                Some(authorization),
            ) {
                return Ok((assignment.task_id, assignment.lane_id));
            }
        }
    }

    match authorization.actor_type.as_str() {
        "agent" => Err("This agent does not have an active task assignment.".to_string()),
        "role_instance" => {
            Err("This role instance does not have an active task assignment.".to_string())
        }
        _ => Err(
            "Only active agent and role sessions can infer the current task todo context.".into(),
        ),
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
        models::{AgentUpsertInput, RoleUpsertInput, TaskUpsertInput},
        services::{
            agents, database, database::initialize_database_at, policies, project_secrets, tasks,
        },
    };
    use rusqlite::params;
    use std::{
        env,
        path::PathBuf,
        sync::{Arc, Mutex},
        time::{SystemTime, UNIX_EPOCH},
    };

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
        let connection = Connection::open(path).expect("database should open");
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("default project should seed");
        connection
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

    fn seed_bridge_task_todo_context(
        connection: &mut Connection,
        task_title: &str,
    ) -> (crate::models::AgentDefinition, crate::models::TaskDetail) {
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES ('workflow-dev', 'workflow-dev', 'Workflow Dev', NULL, 0, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("workflow should insert");
        let agent = agents::create_agent(
            connection,
            AgentUpsertInput {
                name: "Todo Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: vec!["tasks.read".into(), "tasks.update".into()],
            },
        )
        .expect("agent should create");
        for lane_sql in [
            "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, assigned_entity_id, success_transition_type, success_target_lane_id, failure_transition_type, failure_target_lane_id, created_at, updated_at) VALUES ('lane-plan', 'workflow-dev', 'plan', 'Plan', 0, 'agent', ?1, 'lane', 'lane-review', 'lane', 'lane-rework', ?2, ?2)",
            "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, assigned_entity_id, success_transition_type, failure_transition_type, created_at, updated_at) VALUES ('lane-review', 'workflow-dev', 'review', 'Review', 1, 'agent', ?1, 'end', 'end', ?2, ?2)",
            "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, assigned_entity_id, success_transition_type, failure_transition_type, created_at, updated_at) VALUES ('lane-rework', 'workflow-dev', 'rework', 'Rework', 2, 'agent', ?1, 'end', 'end', ?2, ?2)",
            "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, assigned_entity_id, success_transition_type, failure_transition_type, created_at, updated_at) VALUES ('lane-done', 'workflow-dev', 'done', 'Done', 3, 'agent', ?1, 'end', 'end', ?2, ?2)",
        ] {
            connection
                .execute(lane_sql, params![agent.slug.as_str(), now.as_str()])
                .expect("lane should insert");
        }
        let task = tasks::create_task(
            connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: task_title.into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
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
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-task-todo', ?1, 'workflow-dev', 'lane-plan', 'agent', ?2, 'active', 'session-task-todo', '/tmp/task-todo', NULL, NULL, 'Prompt', 0, NULL, ?3, NULL, ?3, ?3)",
                params![task.id.as_str(), agent.id.as_str(), now.as_str()],
            )
            .expect("assignment should insert");

        (agent, task)
    }

    fn with_temp_home<T>(label: &str, action: impl FnOnce() -> T) -> T {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
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
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'P1', 'repo-1', ?1, ?1)",
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
                tags: Vec::new(),
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
            let default_prefix = format!("T{}", &Uuid::new_v4().simple().to_string()[..7]);
            connection
                .execute(
                    "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, ?1, NULL, ?2, ?2)",
                    rusqlite::params![default_prefix, now],
                )
                .expect("default project should seed");
            let project_id = format!("project-{}", Uuid::new_v4().simple());
            let project_slug = project_id.clone();
            let project_prefix = format!("P{}", &Uuid::new_v4().simple().to_string()[..7]);
            connection
                .execute(
                    "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, 'Project 2', NULL, ?3, NULL, ?4, ?4)",
                    rusqlite::params![project_id, project_slug, project_prefix, now],
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
                    "projectId": project_id,
                    "title": "Scoped bridge task",
                    "description": "Should not fall back to orchestra",
                    "type": "task",
                    "status": "ready",
                    "priority": "P2",
                    "assigneeType": "unassigned",
                    "tags": ["urgent", "backend"]
                }),
            )
            .expect("create_task should honor the provided project id");

            assert_eq!(
                created.get("projectId").and_then(Value::as_str),
                Some(project_id.as_str())
            );
            assert_eq!(
                created.get("tags").and_then(Value::as_array).cloned(),
                Some(vec![json!("backend"), json!("urgent")])
            );

            let second = invoke_bridge_command(
                &config,
                &connection,
                "create_task",
                Some(&AuthorizationContext {
                    actor_type: "user".into(),
                    actor_id: "tester".into(),
                }),
                None,
                json!({
                    "projectId": project_id,
                    "title": "API bridge task",
                    "type": "task",
                    "status": "ready",
                    "priority": "P2",
                    "assigneeType": "unassigned",
                    "tags": ["api"]
                }),
            )
            .expect("second create_task should succeed");
            assert_eq!(
                second.get("tags").and_then(Value::as_array).cloned(),
                Some(vec![json!("api")])
            );

            let scoped_tasks = invoke_bridge_command(
                &config,
                &connection,
                "list_tasks",
                Some(&AuthorizationContext {
                    actor_type: "user".into(),
                    actor_id: "tester".into(),
                }),
                None,
                json!({
                    "projectId": project_id,
                    "includeArchived": false,
                    "tags": ["backend", "urgent"],
                    "tagMatch": "all",
                    "sortBy": "tags",
                    "sortDirection": "asc"
                }),
            )
            .expect("list_tasks should respect the provided project id")
            .as_array()
            .cloned()
            .expect("task list should serialize as an array");
            assert_eq!(scoped_tasks.len(), 1);
            assert_eq!(
                scoped_tasks[0].get("projectId").and_then(Value::as_str),
                Some(project_id.as_str())
            );
            assert_eq!(
                scoped_tasks[0]
                    .get("tags")
                    .and_then(Value::as_array)
                    .cloned(),
                Some(vec![json!("backend"), json!("urgent")])
            );

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
    fn update_task_bridge_round_trips_tags() {
        with_temp_home("tool-bridge-update-tags", || {
            let connection = crate::services::database::open_connection()
                .expect("database should open in the temp Orchestra home");
            let now = "2026-03-22T00:00:00Z";
            let project_id = format!("project-{}", Uuid::new_v4().simple());
            let project_prefix = format!("U{}", &Uuid::new_v4().simple().to_string()[..7]);
            connection
                .execute(
                    "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?1, 'Project 1', NULL, ?2, NULL, ?3, ?3)",
                    rusqlite::params![project_id, project_prefix, now],
                )
                .expect("project should seed");
            let config = dummy_bridge_config("update-tags");
            let authorization = Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            });
            let created = invoke_bridge_command(
                &config,
                &connection,
                "create_task",
                authorization,
                None,
                json!({
                    "projectId": project_id,
                    "title": "Mutable bridge task",
                    "type": "task",
                    "status": "ready",
                    "priority": "P2",
                    "assigneeType": "unassigned",
                    "tags": ["alpha"]
                }),
            )
            .expect("create_task should succeed");
            let task_id = created
                .get("id")
                .and_then(Value::as_str)
                .expect("task id should serialize")
                .to_string();

            let updated = invoke_bridge_command(
                &config,
                &connection,
                "update_task",
                authorization,
                None,
                json!({
                    "taskId": task_id,
                    "input": {
                        "title": "Mutable bridge task",
                        "type": "task",
                        "status": "ready",
                        "priority": "P2",
                        "assigneeType": "unassigned",
                        "tags": ["beta", " alpha ", "BETA"]
                    }
                }),
            )
            .expect("update_task should succeed");

            assert_eq!(
                updated.get("tags").and_then(Value::as_array).cloned(),
                Some(vec![json!("alpha"), json!("beta")])
            );
        });
    }

    #[test]
    fn project_and_repository_commands_round_trip_through_bridge() {
        with_temp_home("tool-bridge-projects", || {
            let connection = database::open_connection().expect("database should open");
            let config = dummy_bridge_config("projects");
            let authorization = Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            });

            let project_prefix = format!("B{}", &Uuid::new_v4().simple().to_string()[..7]);
            let created_project = invoke_bridge_command(
                &config,
                &connection,
                "create_project",
                authorization,
                None,
                json!({
                    "input": {
                        "name": "Bridge Project",
                        "description": "Project bridge test",
                        "taskPrefix": project_prefix
                    }
                }),
            )
            .expect("create_project should succeed");
            let project_id = created_project
                .get("id")
                .and_then(Value::as_str)
                .expect("project id should serialize")
                .to_string();

            let projects_result = invoke_bridge_command(
                &config,
                &connection,
                "list_projects",
                authorization,
                None,
                json!({}),
            )
            .expect("list_projects should succeed");
            assert!(projects_result
                .as_array()
                .expect("projects should serialize as an array")
                .iter()
                .any(|entry| entry.get("id").and_then(Value::as_str) == Some(project_id.as_str())));

            let updated_project = invoke_bridge_command(
                &config,
                &connection,
                "update_project",
                authorization,
                None,
                json!({
                    "projectId": project_id,
                    "input": {
                        "name": "Bridge Project Updated",
                        "description": "Updated over the bridge",
                        "taskPrefix": project_prefix
                    }
                }),
            )
            .expect("update_project should succeed");
            assert_eq!(
                updated_project.get("name").and_then(Value::as_str),
                Some("Bridge Project Updated")
            );

            let created_repository = invoke_bridge_command(
                &config,
                &connection,
                "create_repository",
                authorization,
                None,
                json!({
                    "projectId": project_id,
                    "input": {
                        "name": "Bridge Repo",
                        "mode": "existing",
                        "repositoryPath": "/tmp/bridge-repo",
                        "defaultBranch": "main"
                    }
                }),
            )
            .expect("create_repository should succeed");
            let repository_id = created_repository
                .get("id")
                .and_then(Value::as_str)
                .expect("repository id should serialize")
                .to_string();

            let project_detail = invoke_bridge_command(
                &config,
                &connection,
                "get_project",
                authorization,
                None,
                json!({ "projectId": project_id }),
            )
            .expect("get_project should succeed");
            assert!(project_detail
                .get("repositories")
                .and_then(Value::as_array)
                .expect("project repositories should serialize as an array")
                .iter()
                .any(
                    |entry| entry.get("id").and_then(Value::as_str) == Some(repository_id.as_str())
                ));

            let repositories = invoke_bridge_command(
                &config,
                &connection,
                "list_repositories",
                authorization,
                None,
                json!({ "projectId": project_id }),
            )
            .expect("list_repositories should succeed");
            assert!(repositories
                .as_array()
                .expect("repositories should serialize as an array")
                .iter()
                .any(
                    |entry| entry.get("id").and_then(Value::as_str) == Some(repository_id.as_str())
                ));

            let updated_repository = invoke_bridge_command(
                &config,
                &connection,
                "update_repository",
                authorization,
                None,
                json!({
                    "repositoryId": repository_id,
                    "input": {
                        "name": "Bridge Repo Updated",
                        "mode": "existing",
                        "repositoryPath": "/tmp/bridge-repo-updated",
                        "defaultBranch": "develop"
                    }
                }),
            )
            .expect("update_repository should succeed");
            assert_eq!(
                updated_repository.get("name").and_then(Value::as_str),
                Some("Bridge Repo Updated")
            );

            let attached_remote = invoke_bridge_command(
                &config,
                &connection,
                "attach_repository_remote",
                authorization,
                None,
                json!({
                    "repositoryId": repository_id,
                    "input": {
                        "remoteUrl": "git@example.com:org/repo.git",
                        "remoteName": "origin"
                    }
                }),
            )
            .expect("attach_repository_remote should succeed");
            assert_eq!(
                attached_remote.get("sourcePath").and_then(Value::as_str),
                Some("git@example.com:org/repo.git")
            );

            let project_with_default_repository = invoke_bridge_command(
                &config,
                &connection,
                "set_project_default_repository",
                authorization,
                None,
                json!({ "projectId": project_id, "repositoryId": repository_id }),
            )
            .expect("set_project_default_repository should succeed");
            assert_eq!(
                project_with_default_repository
                    .get("defaultRepositoryId")
                    .and_then(Value::as_str),
                Some(repository_id.as_str())
            );

            let repository_detail = invoke_bridge_command(
                &config,
                &connection,
                "get_repository",
                authorization,
                None,
                json!({ "repositoryId": repository_id }),
            )
            .expect("get_repository should succeed");
            assert_eq!(
                repository_detail.get("projectId").and_then(Value::as_str),
                Some(project_id.as_str())
            );

            let deleted_repository = invoke_bridge_command(
                &config,
                &connection,
                "delete_repository",
                authorization,
                None,
                json!({ "repositoryId": repository_id }),
            )
            .expect("delete_repository should succeed");
            assert_eq!(
                deleted_repository.get("id").and_then(Value::as_str),
                Some(repository_id.as_str())
            );

            let deleted_project = invoke_bridge_command(
                &config,
                &connection,
                "delete_project",
                authorization,
                None,
                json!({ "projectId": project_id }),
            )
            .expect("delete_project should succeed");
            assert_eq!(
                deleted_project.get("id").and_then(Value::as_str),
                Some(project_id.as_str())
            );
        });
    }

    #[test]
    fn workflow_lane_commands_round_trip_through_bridge() {
        with_temp_home("tool-bridge-workflows", || {
            let connection = database::open_connection().expect("database should open");
            let config = dummy_bridge_config("workflows");
            let authorization = Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            });

            let validation = invoke_bridge_command(
                &config,
                &connection,
                "validate_workflow",
                authorization,
                None,
                json!({
                    "input": {
                        "name": "Validation workflow",
                        "description": "Workflow validation through bridge",
                        "lanes": [
                            {
                                "key": "plan",
                                "name": "Plan",
                                "assignedEntityType": "user",
                                "successTransitionType": "end",
                                "failureTransitionType": "end"
                            }
                        ]
                    }
                }),
            )
            .expect("validate_workflow should succeed");
            assert_eq!(validation.get("valid").and_then(Value::as_bool), Some(true));

            let created_workflow = invoke_bridge_command(
                &config,
                &connection,
                "create_workflow",
                authorization,
                None,
                json!({
                    "input": {
                        "name": "Bridge workflow",
                        "description": "Workflow created through bridge",
                        "lanes": [
                            {
                                "id": "lane-plan",
                                "key": "plan",
                                "name": "Plan",
                                "assignedEntityType": "user",
                                "successTransitionType": "end",
                                "failureTransitionType": "end"
                            }
                        ]
                    }
                }),
            )
            .expect("create_workflow should succeed");
            let workflow_id = created_workflow
                .get("id")
                .and_then(Value::as_str)
                .expect("workflow id should serialize")
                .to_string();

            let workflow_list = invoke_bridge_command(
                &config,
                &connection,
                "list_workflows",
                authorization,
                None,
                json!({}),
            )
            .expect("list_workflows should succeed");
            assert!(
                workflow_list
                    .as_array()
                    .expect("workflows should serialize as an array")
                    .iter()
                    .any(|entry| entry.get("id").and_then(Value::as_str)
                        == Some(workflow_id.as_str()))
            );

            let added_lane = invoke_bridge_command(
                &config,
                &connection,
                "add_workflow_lane",
                authorization,
                None,
                json!({
                    "workflowId": workflow_id,
                    "input": {
                        "id": "lane-review",
                        "key": "review",
                        "name": "Review",
                        "assignedEntityType": "user",
                        "successTransitionType": "end",
                        "failureTransitionType": "lane",
                        "failureTargetLaneId": "lane-plan"
                    }
                }),
            )
            .expect("add_workflow_lane should succeed");
            assert_eq!(
                added_lane
                    .get("lanes")
                    .and_then(Value::as_array)
                    .map(|lanes| lanes.len()),
                Some(2)
            );

            let updated_lane = invoke_bridge_command(
                &config,
                &connection,
                "update_workflow_lane",
                authorization,
                None,
                json!({
                    "workflowId": workflow_id,
                    "laneId": "lane-review",
                    "input": {
                        "name": "Code review"
                    }
                }),
            )
            .expect("update_workflow_lane should succeed");
            assert!(updated_lane
                .get("lanes")
                .and_then(Value::as_array)
                .expect("workflow lanes should serialize")
                .iter()
                .any(|entry| {
                    entry.get("id").and_then(Value::as_str) == Some("lane-review")
                        && entry.get("name").and_then(Value::as_str) == Some("Code review")
                }));

            let reordered = invoke_bridge_command(
                &config,
                &connection,
                "reorder_workflow_lanes",
                authorization,
                None,
                json!({
                    "workflowId": workflow_id,
                    "input": {
                        "laneIds": ["lane-review", "lane-plan"]
                    }
                }),
            )
            .expect("reorder_workflow_lanes should succeed");
            let reordered_lanes = reordered
                .get("lanes")
                .and_then(Value::as_array)
                .expect("workflow lanes should serialize");
            assert_eq!(
                reordered_lanes[0].get("id").and_then(Value::as_str),
                Some("lane-review")
            );
            assert_eq!(
                reordered_lanes[1].get("id").and_then(Value::as_str),
                Some("lane-plan")
            );

            let duplicated = invoke_bridge_command(
                &config,
                &connection,
                "duplicate_workflow",
                authorization,
                None,
                json!({
                    "workflowId": workflow_id,
                    "newName": "Bridge workflow copy"
                }),
            )
            .expect("duplicate_workflow should succeed");
            assert_eq!(
                duplicated.get("name").and_then(Value::as_str),
                Some("Bridge workflow copy")
            );

            let workflow_detail = invoke_bridge_command(
                &config,
                &connection,
                "get_workflow",
                authorization,
                None,
                json!({ "workflowId": workflow_id }),
            )
            .expect("get_workflow should succeed");
            assert!(workflow_detail
                .get("lanes")
                .and_then(Value::as_array)
                .is_some());

            let deleted_lane = invoke_bridge_command(
                &config,
                &connection,
                "delete_workflow_lane",
                authorization,
                None,
                json!({
                    "workflowId": workflow_id,
                    "laneId": "lane-review"
                }),
            )
            .expect("delete_workflow_lane should succeed");
            assert_eq!(
                deleted_lane
                    .get("lanes")
                    .and_then(Value::as_array)
                    .map(|lanes| lanes.len()),
                Some(1)
            );

            let archived = invoke_bridge_command(
                &config,
                &connection,
                "archive_workflow",
                authorization,
                None,
                json!({ "workflowId": workflow_id }),
            )
            .expect("archive_workflow should succeed");
            assert_eq!(
                archived.get("archived").and_then(Value::as_bool),
                Some(true)
            );

            let delete_impact = invoke_bridge_command(
                &config,
                &connection,
                "get_workflow_delete_impact",
                authorization,
                None,
                json!({ "workflowId": workflow_id }),
            )
            .expect("get_workflow_delete_impact should succeed");
            assert_eq!(
                delete_impact.get("canDelete").and_then(Value::as_bool),
                Some(true)
            );

            let deleted = invoke_bridge_command(
                &config,
                &connection,
                "delete_workflow",
                authorization,
                None,
                json!({ "workflowId": workflow_id }),
            )
            .expect("delete_workflow should succeed");
            assert_eq!(
                deleted.get("workflowId").and_then(Value::as_str),
                Some(workflow_id.as_str())
            );
        });
    }

    #[test]
    fn project_secret_commands_round_trip_through_bridge() {
        with_temp_home("tool-bridge-project-secrets", || {
            let orchestra_root = crate::services::orchestra_paths::default_orchestra_root()
                .expect("orchestra root should resolve in the temp HOME");
            let connection = crate::services::database::open_connection_at(
                &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
            )
            .expect("database should open in the temp Orchestra home");
            let now = "2026-05-01T00:00:00Z";
            connection
                .execute(
                    "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-secret-1', 'secret-project', 'Secret Project', NULL, 'SEC', NULL, ?1, ?1)",
                    [now],
                )
                .expect("project should seed");
            let _store = project_secrets::ScopedTestProjectSecretStore::install(Arc::new(
                project_secrets::TestProjectSecretStore::new("available"),
            ));
            let config = dummy_bridge_config("project-secrets");
            let authorization = Some(&AuthorizationContext {
                actor_type: "user".into(),
                actor_id: "tester".into(),
            });

            let created = invoke_bridge_command(
                &config,
                &connection,
                "add_project_secret",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "secretKey": "OPENAI_API_KEY",
                    "description": "Primary provider key",
                    "value": "sk-test-1"
                }),
            )
            .expect("create project secret should succeed");
            assert_eq!(
                created
                    .pointer("/secrets/0/secretKey")
                    .and_then(Value::as_str),
                Some("OPENAI_API_KEY")
            );
            assert_eq!(
                created
                    .pointer("/secrets/0/valueState")
                    .and_then(Value::as_str),
                Some("ready")
            );

            invoke_bridge_command(
                &config,
                &connection,
                "add_project_secret",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "secretKey": "ANTHROPIC_API_KEY",
                    "description": "Secondary provider key",
                    "value": "sk-test-2"
                }),
            )
            .expect("second project secret should succeed");

            let listed = invoke_bridge_command(
                &config,
                &connection,
                "list_project_secrets",
                authorization,
                None,
                json!({ "projectSlug": "secret-project" }),
            )
            .expect("list project secrets should succeed");
            assert_eq!(
                listed
                    .as_object()
                    .and_then(|value| value.get("projectSlug"))
                    .and_then(Value::as_str),
                Some("secret-project")
            );
            assert_eq!(
                listed
                    .pointer("/secrets/0/description")
                    .and_then(Value::as_str),
                Some("Secondary provider key")
            );

            let searched = invoke_bridge_command(
                &config,
                &connection,
                "search_project_secrets",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "query": "primary",
                    "valueState": "ready",
                    "hasDescription": true
                }),
            )
            .expect("search project secrets should succeed");
            assert_eq!(
                searched
                    .pointer("/secrets/0/secretKey")
                    .and_then(Value::as_str),
                Some("OPENAI_API_KEY")
            );
            assert_eq!(
                searched
                    .pointer("/secrets")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );

            let filtered_list = invoke_bridge_command(
                &config,
                &connection,
                "list_project_secrets",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "secretKey": "ANTHROPIC_API_KEY"
                }),
            )
            .expect("filtered list project secrets should succeed");
            assert_eq!(
                filtered_list
                    .pointer("/secrets/0/secretKey")
                    .and_then(Value::as_str),
                Some("ANTHROPIC_API_KEY")
            );
            assert_eq!(
                filtered_list
                    .pointer("/secrets")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );

            let loaded = invoke_bridge_command(
                &config,
                &connection,
                "get_project_secret",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "secretKey": "OPENAI_API_KEY"
                }),
            )
            .expect("get project secret should succeed");
            assert_eq!(
                loaded.get("value").and_then(Value::as_str),
                Some("sk-test-1")
            );

            let updated = invoke_bridge_command(
                &config,
                &connection,
                "update_project_secret",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "secretKey": "OPENAI_API_KEY",
                    "description": "Rotated provider key",
                    "value": "sk-test-3"
                }),
            )
            .expect("update project secret should succeed");
            assert_eq!(
                updated
                    .pointer("/secrets/1/description")
                    .and_then(Value::as_str),
                Some("Rotated provider key")
            );

            let deleted = invoke_bridge_command(
                &config,
                &connection,
                "delete_project_secret",
                authorization,
                None,
                json!({
                    "projectSlug": "secret-project",
                    "secretKey": "OPENAI_API_KEY"
                }),
            )
            .expect("delete project secret should succeed");
            assert_eq!(
                deleted
                    .pointer("/secrets")
                    .and_then(Value::as_array)
                    .map(Vec::len),
                Some(1)
            );
        });
    }

    #[test]
    fn project_secret_bridge_commands_enforce_read_use_and_write_permissions() {
        with_temp_home("tool-bridge-project-secrets-auth", || {
            let orchestra_root = crate::services::orchestra_paths::default_orchestra_root()
                .expect("orchestra root should resolve in the temp HOME");
            let mut connection = crate::services::database::open_connection_at(
                &crate::services::orchestra_paths::orchestra_database_path(&orchestra_root),
            )
            .expect("database should open in the temp Orchestra home");
            let now = "2026-05-01T00:00:00Z";
            connection
                .execute(
                    "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-secret-auth', 'secret-auth-project', 'Secret Auth Project', NULL, 'SAP', NULL, ?1, ?1)",
                    [now],
                )
                .expect("project should seed");
            let _store = project_secrets::ScopedTestProjectSecretStore::install(Arc::new(
                project_secrets::TestProjectSecretStore::new("available"),
            ));
            let read_agent = agents::create_agent(
                &mut connection,
                AgentUpsertInput {
                    name: "Secret Reader".into(),
                    description: None,
                    system_prompt: None,
                    provider: None,
                    model: None,
                    role_id: None,
                    scope: Some("global".into()),
                    project_id: None,
                    thinking_level: Some("off".into()),
                    compaction_window: None,
                    policy_ids: Vec::new(),
                    direct_permissions: vec!["projects.secrets.read".into()],
                },
            )
            .expect("read agent should create");
            let use_agent = agents::create_agent(
                &mut connection,
                AgentUpsertInput {
                    name: "Secret User".into(),
                    description: None,
                    system_prompt: None,
                    provider: None,
                    model: None,
                    role_id: None,
                    scope: Some("global".into()),
                    project_id: None,
                    thinking_level: Some("off".into()),
                    compaction_window: None,
                    policy_ids: Vec::new(),
                    direct_permissions: vec!["projects.secrets.use".into()],
                },
            )
            .expect("use agent should create");
            let write_agent = agents::create_agent(
                &mut connection,
                AgentUpsertInput {
                    name: "Secret Writer".into(),
                    description: None,
                    system_prompt: None,
                    provider: None,
                    model: None,
                    role_id: None,
                    scope: Some("global".into()),
                    project_id: None,
                    thinking_level: Some("off".into()),
                    compaction_window: None,
                    policy_ids: Vec::new(),
                    direct_permissions: vec!["projects.secrets.write".into()],
                },
            )
            .expect("write agent should create");
            let config = dummy_bridge_config("project-secrets-auth");

            invoke_bridge_command(
                &config,
                &connection,
                "add_project_secret",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: write_agent.id.clone(),
                }),
                None,
                json!({
                    "projectSlug": "secret-auth-project",
                    "secretKey": "OPENAI_API_KEY",
                    "description": "Primary key",
                    "value": "sk-test-1"
                }),
            )
            .expect("writer should seed the secret");

            let listed = invoke_bridge_command(
                &config,
                &connection,
                "list_project_secrets",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: read_agent.id.clone(),
                }),
                None,
                json!({ "projectSlug": "secret-auth-project" }),
            )
            .expect("reader should list project secrets");
            assert_eq!(
                listed
                    .pointer("/secrets/0/secretKey")
                    .and_then(Value::as_str),
                Some("OPENAI_API_KEY")
            );

            let searched = invoke_bridge_command(
                &config,
                &connection,
                "search_project_secrets",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: read_agent.id.clone(),
                }),
                None,
                json!({
                    "projectSlug": "secret-auth-project",
                    "query": "openai"
                }),
            )
            .expect("reader should search project secrets");
            assert_eq!(
                searched
                    .pointer("/secrets/0/secretKey")
                    .and_then(Value::as_str),
                Some("OPENAI_API_KEY")
            );

            let read_denied = invoke_bridge_command(
                &config,
                &connection,
                "get_project_secret",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: read_agent.id.clone(),
                }),
                None,
                json!({
                    "projectSlug": "secret-auth-project",
                    "secretKey": "OPENAI_API_KEY"
                }),
            )
            .expect_err("metadata-only reader should not load secret values");
            assert!(read_denied.contains("projects.secrets.use"));

            let use_denied = invoke_bridge_command(
                &config,
                &connection,
                "list_project_secrets",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: use_agent.id.clone(),
                }),
                None,
                json!({ "projectSlug": "secret-auth-project" }),
            )
            .expect_err("use-only agent should not list secret metadata");
            assert!(use_denied.contains("projects.secrets.read"));

            let search_denied = invoke_bridge_command(
                &config,
                &connection,
                "search_project_secrets",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: use_agent.id.clone(),
                }),
                None,
                json!({
                    "projectSlug": "secret-auth-project",
                    "query": "openai"
                }),
            )
            .expect_err("use-only agent should not search secret metadata");
            assert!(search_denied.contains("projects.secrets.read"));

            let write_denied = invoke_bridge_command(
                &config,
                &connection,
                "update_project_secret",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: read_agent.id,
                }),
                None,
                json!({
                    "projectSlug": "secret-auth-project",
                    "secretKey": "OPENAI_API_KEY",
                    "description": "Rotated",
                    "value": "sk-test-2"
                }),
            )
            .expect_err("reader should not rotate secrets");
            assert!(write_denied.contains("projects.secrets.write"));

            let delete_denied = invoke_bridge_command(
                &config,
                &connection,
                "delete_project_secret",
                Some(&AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: use_agent.id,
                }),
                None,
                json!({
                    "projectSlug": "secret-auth-project",
                    "secretKey": "OPENAI_API_KEY"
                }),
            )
            .expect_err("use-only agent should not delete secrets");
            assert!(delete_denied.contains("projects.secrets.write"));
        });
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
    fn remind_me_schedules_a_worker_reminder_through_bridge() {
        let mut connection = open_test_connection("bridge-remind-me");
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reminder Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: vec!["tasks.read".into()],
            },
        )
        .expect("agent should create");
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'idle', 'session-remind', '/tmp/remind', NULL, NULL, NULL, ?2, ?2)",
                params![agent.id.as_str(), now.as_str()],
            )
            .expect("runtime state should insert");

        let config = dummy_bridge_config("bridge-remind-me");
        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent.id.clone(),
        };

        let reminder = invoke_bridge_command(
            &config,
            &connection,
            "remind_me",
            Some(&authorization),
            Some("session-remind"),
            json!({ "message": "check status", "delaySeconds": 5 }),
        )
        .expect("reminder should schedule through bridge");

        assert_eq!(
            reminder.get("actorType").and_then(Value::as_str),
            Some("agent")
        );
        assert_eq!(
            reminder.get("sessionId").and_then(Value::as_str),
            Some("session-remind")
        );
        assert_eq!(
            reminder.get("message").and_then(Value::as_str),
            Some("check status")
        );
        let stored_count = connection
            .query_row("SELECT COUNT(*) FROM worker_reminders", [], |row| {
                row.get::<_, i64>(0)
            })
            .expect("reminder count should query");
        assert_eq!(stored_count, 1);
    }

    #[test]
    fn add_task_todo_defaults_to_the_active_worker_task_when_lane_is_explicit() {
        let mut connection = open_test_connection("bridge-task-todos");
        let (agent, task) =
            seed_bridge_task_todo_context(&mut connection, "Bridge task todo target");

        let config = dummy_bridge_config("bridge-task-todo");
        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent.id.clone(),
        };

        let todo = invoke_bridge_command(
            &config,
            &connection,
            "add_task_todo",
            Some(&authorization),
            Some("session-task-todo"),
            json!({
                "laneId": "lane-plan",
                "description": "Follow up on the active lane"
            }),
        )
        .expect("task todo should add through bridge");

        assert_eq!(
            todo.get("taskId").and_then(Value::as_str),
            Some(task.id.as_str())
        );
        assert_eq!(
            todo.get("laneId").and_then(Value::as_str),
            Some("lane-plan")
        );
        assert_eq!(todo.get("completed").and_then(Value::as_bool), Some(false));

        let unfinished = invoke_bridge_command(
            &config,
            &connection,
            "list_unfinished_task_todos",
            Some(&authorization),
            Some("session-task-todo"),
            json!({ "taskId": task.id, "laneId": "lane-plan" }),
        )
        .expect("unfinished task todos should list");
        assert_eq!(unfinished.as_array().map(Vec::len), Some(1));
    }

    #[test]
    fn add_task_todo_rejects_missing_lane_even_with_an_active_worker_assignment() {
        let mut connection = open_test_connection("bridge-task-todos-missing-lane");
        let (agent, _task) =
            seed_bridge_task_todo_context(&mut connection, "Bridge task todo missing lane");

        let config = dummy_bridge_config("bridge-task-todo-missing-lane");
        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent.id.clone(),
        };

        let error = invoke_bridge_command(
            &config,
            &connection,
            "add_task_todo",
            Some(&authorization),
            Some("session-task-todo"),
            json!({ "description": "Missing lane target" }),
        )
        .expect_err("missing lane should be rejected");

        assert_eq!(error, "laneId: A workflow lane is required for task todos.");
    }

    #[test]
    fn add_task_todo_allows_direct_handoff_lanes_and_rejects_other_cross_lane_targets() {
        let mut connection = open_test_connection("bridge-task-todos-cross-lane");
        let (agent, task) =
            seed_bridge_task_todo_context(&mut connection, "Bridge cross-lane todo");

        let config = dummy_bridge_config("bridge-task-todo-cross-lane");
        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent.id.clone(),
        };

        let handoff_todo = invoke_bridge_command(
            &config,
            &connection,
            "add_task_todo",
            Some(&authorization),
            Some("session-task-todo"),
            json!({
                "taskId": task.id,
                "laneId": "lane-review",
                "description": "Prepare review handoff"
            }),
        )
        .expect("direct handoff lane should be allowed");
        assert_eq!(
            handoff_todo.get("laneId").and_then(Value::as_str),
            Some("lane-review")
        );

        let error = invoke_bridge_command(
            &config,
            &connection,
            "add_task_todo",
            Some(&authorization),
            Some("session-task-todo"),
            json!({
                "taskId": task.id,
                "laneId": "lane-done",
                "description": "Skip ahead"
            }),
        )
        .expect_err("non-handoff lane should be rejected");

        assert_eq!(
            error,
            "laneId: Workers on lane lane-plan can only create todos for lane-plan, lane-review, lane-rework. Requested lane lane-done is not permitted.",
        );
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
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
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
                tags: Vec::new(),
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
                origin_type: None,
                origin_id: None,
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
                anchor: None,
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
    fn bridge_session_management_commands_route_typed_payloads() {
        with_temp_home("bridge-session-management", || {
            let connection = open_test_connection("bridge-session-management");
            let context = crate::services::pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let session_id = "66666666-6666-6666-6666-666666666666";
            let session_path = context
                .session_dir
                .join(format!("20260101_{session_id}.jsonl"));
            std::fs::write(
                &session_path,
                format!(
                    concat!(
                        "{{\"type\":\"session\",\"id\":\"{session_id}\",\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n",
                        "{{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"Larry main session\"}}]}}}}\n"
                    ),
                    session_id = session_id,
                ),
            )
            .expect("session file should write");
            let metadata =
                std::fs::metadata(&session_path).expect("session file metadata should load");
            let modified_ms = metadata
                .modified()
                .expect("modified time should load")
                .duration_since(std::time::UNIX_EPOCH)
                .expect("modified time should normalize")
                .as_millis() as i64;
            let now = crate::state::now_iso();
            connection
                .execute(
                    r#"
                    INSERT INTO session_catalog (
                        session_id, project_slug, session_path, created_at, updated_at,
                        title, status, file_size, file_mtime_ms, last_indexed_at
                    )
                    VALUES (?1, 'orchestra', ?2, ?3, ?3, 'Larry main session', 'idle', ?4, ?5, ?3)
                    "#,
                    params![
                        session_id,
                        session_path.display().to_string(),
                        now,
                        metadata.len() as i64,
                        modified_ms,
                    ],
                )
                .expect("catalog row should insert");

            let config = dummy_bridge_config("session-management");
            let listed = invoke_bridge_command(
                &config,
                &connection,
                "list_sessions",
                None,
                Some("worker-session"),
                json!({ "query": "Larry main", "limit": 5 }),
            )
            .expect("sessions should list through bridge");
            let listed_sessions = listed
                .as_array()
                .expect("listed sessions should be an array");
            assert_eq!(listed_sessions.len(), 1);
            assert_eq!(
                listed_sessions[0].get("sessionId").and_then(Value::as_str),
                Some(session_id)
            );

            let deleted = invoke_bridge_command(
                &config,
                &connection,
                "delete_sessions",
                None,
                Some("worker-session"),
                json!({ "query": "Larry main", "dryRun": true, "confirm": false }),
            )
            .expect("sessions should dry-run delete through bridge");
            assert_eq!(deleted.get("dryRun").and_then(Value::as_bool), Some(true));
            assert_eq!(deleted.get("matchedCount").and_then(Value::as_u64), Some(1));
        });
    }

    #[test]
    fn delete_sessions_requires_sessions_stop_permission_when_stop_is_requested() {
        let mut connection = open_test_connection("bridge-session-delete-stop-auth");
        let role = roles::create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Session Cleaner".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: vec!["sessions.delete".into()],
            },
        )
        .expect("role should create");

        let config = dummy_bridge_config("session-delete-stop-auth");
        let error = invoke_bridge_command(
            &config,
            &connection,
            "delete_sessions",
            Some(&AuthorizationContext {
                actor_type: "role".into(),
                actor_id: role.id,
            }),
            Some("worker-session"),
            json!({
                "query": "Larry main session",
                "dryRun": true,
                "confirm": false,
                "stopActiveRuntimes": true,
            }),
        )
        .expect_err("delete_sessions should require sessions.stop when stopActiveRuntimes=true");
        assert!(error.contains("sessions.stop"));
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
