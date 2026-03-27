use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use uuid::Uuid;

use crate::{
    models::{AuthorizationContext, SessionModel, SessionModelState, SessionStreamEnvelope},
    services::{database, pi_sessions::get_session_path, task_runtime},
};

const RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

fn resolve_orchestra_extension_path(app: &AppHandle) -> Result<PathBuf, String> {
    let path = app
        .path()
        .resolve("extensions/orchestra-tools.ts", BaseDirectory::Resource)
        .map_err(|error| format!("Unable to resolve packaged Orchestra extension path: {error}"))?;

    if path.exists() {
        Ok(path)
    } else {
        Err(format!(
            "Packaged Orchestra extension path does not exist: {}",
            path.display()
        ))
    }
}

pub struct SessionRuntime {
    session_id: String,
    session_dir: PathBuf,
    session_path: PathBuf,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    subscribed: Mutex<bool>,
    current_run_id: Mutex<Option<String>>,
    closed: Mutex<bool>,
    app: AppHandle,
}

impl SessionRuntime {
    pub fn spawn(
        app: AppHandle,
        project_root: PathBuf,
        session_dir: PathBuf,
        session_id: String,
        session_path: PathBuf,
    ) -> Result<Arc<Self>, String> {
        let bridge_config = app.state::<crate::state::AppState>().tool_bridge.clone();
        let authorization_context = runtime_authorization_context(&session_id)?;
        let allowed_tools = crate::services::tool_bridge::list_bridge_tools(
            &database::open_connection()?,
            authorization_context.as_ref(),
        )?;
        let bridge_client_id = format!("bridge-client-{}", Uuid::new_v4().simple());
        let extension_path = resolve_orchestra_extension_path(&app)?;

        let pi_executable =
            std::env::var("ORCHESTRA_PI_EXECUTABLE").unwrap_or_else(|_| "pi".to_string());
        let mut child = Command::new(&pi_executable)
            .arg("--offline")
            .arg("--mode")
            .arg("rpc")
            .arg("--session")
            .arg(&session_path)
            .arg("--session-dir")
            .arg(&session_dir)
            .arg("--no-extensions")
            .arg("--extension")
            .arg(&extension_path)
            .env("ORCHESTRA_BRIDGE_URL", &bridge_config.url)
            .env("ORCHESTRA_BRIDGE_TOKEN", &bridge_config.token)
            .env("ORCHESTRA_BRIDGE_INSTANCE_ID", &bridge_config.instance_id)
            .env("ORCHESTRA_BRIDGE_CLIENT_ID", &bridge_client_id)
            .env("ORCHESTRA_BRIDGE_SESSION_ID", &session_id)
            .env(
                "ORCHESTRA_ALLOWED_COMMANDS_JSON",
                serde_json::to_string(&allowed_tools)
                    .map_err(|error| format!("Unable to serialize allowed tools: {error}"))?,
            )
            .env(
                "ORCHESTRA_AUTH_CONTEXT_JSON",
                serde_json::to_string(&authorization_context).map_err(|error| {
                    format!("Unable to serialize authorization context: {error}")
                })?,
            )
            .current_dir(project_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| format!("Unable to start pi RPC process: {error}"))?;

        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| "Unable to open stdin for pi RPC process".to_string())?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| "Unable to open stdout for pi RPC process".to_string())?;
        let stderr = child
            .stderr
            .take()
            .ok_or_else(|| "Unable to open stderr for pi RPC process".to_string())?;

        app.state::<crate::state::AppState>().log(
            "info",
            "sessions.runtime.spawn",
            &format!(
                "Spawning live pi RPC runtime for session {} with extension {}",
                session_id,
                extension_path.display()
            ),
        );

        let runtime = Arc::new(Self {
            session_id,
            session_dir,
            session_path,
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            subscribed: Mutex::new(false),
            current_run_id: Mutex::new(None),
            closed: Mutex::new(false),
            app,
        });

        Self::spawn_stdout_thread(&runtime, stdout);
        Self::spawn_stderr_thread(&runtime, stderr);

        Ok(runtime)
    }

    fn spawn_stdout_thread(runtime: &Arc<Self>, stdout: ChildStdout) {
        let runtime = Arc::clone(runtime);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            let mut line = String::new();

            loop {
                line.clear();
                match reader.read_line(&mut line) {
                    Ok(0) => {
                        runtime.handle_process_end("pi RPC process exited");
                        break;
                    }
                    Ok(_) => {
                        let trimmed = line.trim_end_matches(['\r', '\n']);
                        if trimmed.is_empty() {
                            continue;
                        }

                        match serde_json::from_str::<Value>(trimmed) {
                            Ok(payload) => runtime.handle_payload(payload),
                            Err(error) => {
                                runtime.app.state::<crate::state::AppState>().log(
                                    "error",
                                    "sessions.rpc.parse",
                                    &format!(
                                        "Unable to parse pi RPC output for {}: {error}",
                                        runtime.session_id
                                    ),
                                );
                                runtime.emit_stream_event(json!({
                                    "type": "error",
                                    "message": format!("Unable to parse pi RPC output: {error}"),
                                    "source": "orchestra",
                                }));
                            }
                        }
                    }
                    Err(error) => {
                        runtime
                            .handle_process_end(format!("Unable to read pi RPC output: {error}"));
                        break;
                    }
                }
            }
        });
    }

    fn spawn_stderr_thread(runtime: &Arc<Self>, stderr: ChildStderr) {
        let runtime = Arc::clone(runtime);
        thread::spawn(move || {
            let mut reader = BufReader::new(stderr);
            let mut buffer = String::new();
            let _ = reader.read_to_string(&mut buffer);
            if !buffer.trim().is_empty() {
                runtime.app.state::<crate::state::AppState>().log(
                    "warn",
                    "sessions.rpc.stderr",
                    buffer.trim(),
                );
            }
        });
    }

    fn handle_payload(&self, payload: Value) {
        if payload.get("type").and_then(Value::as_str) == Some("response") {
            if let Some(id) = payload.get("id").and_then(Value::as_str) {
                if let Ok(mut pending) = self.pending.lock() {
                    if let Some(sender) = pending.remove(id) {
                        let success = payload.get("success").and_then(Value::as_bool) == Some(true);
                        self.app.state::<crate::state::AppState>().log(
                            "info",
                            "sessions.rpc.response",
                            &format!(
                                "Session {} received response {} success={}",
                                self.session_id, id, success
                            ),
                        );
                        let result = if success {
                            Ok(payload)
                        } else {
                            Err(extract_rpc_error(&payload))
                        };
                        let _ = sender.send(result);
                        return;
                    }
                }
            }
        }

        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        self.app.state::<crate::state::AppState>().log(
            "info",
            "sessions.rpc.event",
            &format!("Session {} received {}", self.session_id, event_type),
        );
        self.emit_stream_event(payload.clone());

        if event_type == "agent_end" {
            if let Some(run_id) = self.take_current_run_id() {
                let _ = self
                    .app
                    .state::<crate::state::AppState>()
                    .end_session_run(&self.session_id, &run_id);
                let _ = crate::services::agent_dispatch::complete_agent_run(
                    &self.session_id,
                    Some(&run_id),
                );
                let _ = crate::services::role_dispatch::complete_role_run(&self.session_id);
            }
            self.close_if_idle();
        }
    }

    fn handle_process_end(&self, message: impl Into<String>) {
        let error_message = message.into();
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(error_message.clone()));
            }
        }

        if let Some(run_id) = self.take_current_run_id() {
            let _ = self
                .app
                .state::<crate::state::AppState>()
                .end_session_run(&self.session_id, &run_id);
            let _ = crate::services::agent_dispatch::fail_agent_run(
                &self.session_id,
                Some(&run_id),
                &error_message,
            );
            let _ = crate::services::role_dispatch::fail_role_run(&self.session_id, &error_message);
            self.emit_stream_event(json!({
                "type": "error",
                "message": error_message,
                "source": "orchestra",
            }));
        }

        self.teardown_process();
    }

    fn emit_stream_event(&self, event: Value) {
        if !self.is_subscribed() {
            return;
        }

        let payload = SessionStreamEnvelope {
            session_id: self.session_id.clone(),
            run_id: self.current_run_id(),
            event,
            received_at: crate::state::now_iso(),
        };
        let serialized = match serde_json::to_string(&payload) {
            Ok(serialized) => serialized,
            Err(error) => {
                self.app.state::<crate::state::AppState>().log(
                    "error",
                    "sessions.rpc.emit_failed",
                    &format!(
                        "Unable to serialize session stream event for {}: {error}",
                        self.session_id
                    ),
                );
                return;
            }
        };

        let script = format!(
            "window.dispatchEvent(new CustomEvent('orchestra:session-stream', {{ detail: {serialized} }}));"
        );

        match self.app.get_webview_window("main") {
            Some(main_window) => {
                if let Err(error) = main_window.eval(&script) {
                    self.app.state::<crate::state::AppState>().log(
                        "error",
                        "sessions.rpc.emit_failed",
                        &format!(
                            "Unable to deliver session stream event for {}: {error}",
                            self.session_id
                        ),
                    );
                }
            }
            None => self.app.state::<crate::state::AppState>().log(
                "error",
                "sessions.rpc.emit_failed",
                &format!(
                    "Main webview window unavailable while emitting session stream for {}",
                    self.session_id
                ),
            ),
        }
    }

    fn send_command(&self, command: Value) -> Result<Value, String> {
        if self.is_closed() {
            return Err("Session runtime is no longer available".into());
        }

        let request_id = command
            .get("id")
            .and_then(Value::as_str)
            .ok_or_else(|| "RPC command is missing an id".to_string())?
            .to_string();
        let (sender, receiver) = mpsc::channel();
        self.pending
            .lock()
            .map_err(|_| "Unable to access pending session RPC state".to_string())?
            .insert(request_id.clone(), sender);

        let write_result = (|| -> Result<(), String> {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|_| "Unable to access pi RPC stdin".to_string())?;
            let stdin = stdin
                .as_mut()
                .ok_or_else(|| "Session runtime stdin is closed".to_string())?;
            writeln!(stdin, "{command}")
                .map_err(|error| format!("Unable to send command to pi RPC process: {error}"))?;
            stdin
                .flush()
                .map_err(|error| format!("Unable to flush pi RPC stdin: {error}"))?;
            Ok(())
        })();

        if let Err(error) = write_result {
            let _ = self
                .pending
                .lock()
                .map(|mut pending| pending.remove(&request_id));
            self.app.state::<crate::state::AppState>().log(
                "error",
                "sessions.rpc.send",
                &format!(
                    "Session {} failed to send command {}: {}",
                    self.session_id, request_id, error
                ),
            );
            return Err(error);
        }

        self.app.state::<crate::state::AppState>().log(
            "info",
            "sessions.rpc.send",
            &format!("Session {} sent command {}", self.session_id, request_id),
        );

        receiver
            .recv_timeout(RPC_RESPONSE_TIMEOUT)
            .map_err(|_| "Timed out waiting for pi RPC response".to_string())?
    }

    pub fn set_subscribed(&self, subscribed: bool) {
        if let Ok(mut current) = self.subscribed.lock() {
            *current = subscribed;
        }
        self.close_if_idle();
    }

    pub fn has_active_prompt(&self) -> bool {
        self.current_run_id
            .lock()
            .map(|current| current.is_some())
            .unwrap_or(false)
    }

    pub fn shutdown(&self) {
        self.teardown_process();
    }

    pub fn abort_active_run(&self) {
        let _ = self.take_current_run_id();
        self.mark_closed();
        if let Ok(mut stdin) = self.stdin.lock() {
            *stdin = None;
        }
        if let Ok(mut child) = self.child.lock() {
            if let Some(child) = child.as_mut() {
                let _ = child.kill();
            }
            *child = None;
        }
    }

    pub fn start_run(&self, run_id: &str, message: &str) -> Result<(), String> {
        self.start_delivery(run_id, "prompt", message)
    }

    pub fn start_delivery(
        &self,
        run_id: &str,
        delivery_type: &str,
        message: &str,
    ) -> Result<(), String> {
        self.app.state::<crate::state::AppState>().log(
            "info",
            "sessions.runtime.start_run",
            &format!(
                "Session {} starting {} delivery {} with {} chars",
                self.session_id,
                delivery_type,
                run_id,
                message.len()
            ),
        );

        let command_id = format!("{}-{}", delivery_type, run_id);
        let command = match delivery_type {
            "prompt" => {
                let mut current_run_id = self
                    .current_run_id
                    .lock()
                    .map_err(|_| "Unable to access current session run state".to_string())?;
                if current_run_id.is_some() {
                    return Err("This session is already processing a message".into());
                }
                *current_run_id = Some(run_id.to_string());
                json!({ "id": command_id, "type": "prompt", "message": message })
            }
            "steer" => json!({ "id": command_id, "type": "steer", "message": message }),
            "follow_up" => json!({ "id": command_id, "type": "follow_up", "message": message }),
            other => return Err(format!("Unsupported session delivery type: {other}")),
        };

        let result = self.send_command(command);
        if let Err(error) = result {
            if delivery_type == "prompt" {
                let _ = self.take_current_run_id();
            }
            return Err(error);
        }

        Ok(())
    }

    pub fn get_model_state(&self) -> Result<SessionModelState, String> {
        let state = self.send_command(
            json!({ "id": format!("state-{}", Uuid::new_v4()), "type": "get_state" }),
        )?;
        let models = self.send_command(json!({
            "id": format!("models-{}", Uuid::new_v4()),
            "type": "get_available_models"
        }))?;

        Ok(SessionModelState {
            session_id: self.session_id.clone(),
            current_model: state.pointer("/data/model").and_then(parse_model_summary),
            current_thinking_level: state
                .pointer("/data/thinkingLevel")
                .and_then(Value::as_str)
                .unwrap_or("off")
                .to_string(),
            available_models: models
                .pointer("/data/models")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(parse_model_summary)
                .collect(),
        })
    }

    pub fn set_model(&self, provider: &str, model_id: &str) -> Result<SessionModelState, String> {
        if self.current_run_id().is_some() {
            return Err("Wait for the current response to finish before changing models".into());
        }

        self.send_command(json!({
            "id": format!("set-model-{}", Uuid::new_v4()),
            "type": "set_model",
            "provider": provider,
            "modelId": model_id,
        }))?;

        self.get_model_state()
    }

    fn is_subscribed(&self) -> bool {
        self.subscribed.lock().map(|value| *value).unwrap_or(false)
    }

    fn current_run_id(&self) -> Option<String> {
        self.current_run_id
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    fn take_current_run_id(&self) -> Option<String> {
        self.current_run_id
            .lock()
            .ok()
            .and_then(|mut value| value.take())
    }

    fn close_if_idle(&self) {
        if self.is_subscribed() || self.current_run_id().is_some() || self.is_closed() {
            return;
        }

        self.teardown_process();
    }

    fn is_closed(&self) -> bool {
        self.closed.lock().map(|value| *value).unwrap_or(true)
    }

    fn mark_closed(&self) {
        if let Ok(mut closed) = self.closed.lock() {
            *closed = true;
        }
    }

    fn teardown_process(&self) {
        self.app.state::<crate::state::AppState>().log(
            "info",
            "sessions.runtime.teardown",
            &format!(
                "Tearing down live pi RPC runtime for session {}",
                self.session_id
            ),
        );
        self.mark_closed();
        if let Ok(mut stdin) = self.stdin.lock() {
            *stdin = None;
        }
        if let Ok(mut child_guard) = self.child.lock() {
            if let Some(mut child) = child_guard.take() {
                let _ = child.kill();
                let _ = child.wait();
            }
        }
        if let Ok(mut runtimes) = self
            .app
            .state::<crate::state::AppState>()
            .session_runtimes
            .lock()
        {
            runtimes.remove(&self.session_id);
        }
    }
}

pub fn ensure_runtime(
    runtimes: &Mutex<HashMap<String, Arc<SessionRuntime>>>,
    app: AppHandle,
    project_root: PathBuf,
    session_dir: PathBuf,
    session_id: &str,
) -> Result<Arc<SessionRuntime>, String> {
    if let Ok(mut runtimes) = runtimes.lock() {
        if let Some(existing) = runtimes.get(session_id) {
            if !existing.is_closed() {
                app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.runtime.reuse",
                    &format!("Reusing live pi RPC runtime for session {}", session_id),
                );
                return Ok(Arc::clone(existing));
            }
            runtimes.remove(session_id);
        }

        let session_path = get_session_path(&session_dir, session_id)?;
        let runtime = SessionRuntime::spawn(
            app,
            project_root,
            session_dir,
            session_id.to_string(),
            session_path,
        )?;
        runtimes.insert(session_id.to_string(), Arc::clone(&runtime));
        return Ok(runtime);
    }

    Err("Unable to access live session runtime state".into())
}

pub fn maybe_runtime(
    runtimes: &Mutex<HashMap<String, Arc<SessionRuntime>>>,
    session_id: &str,
) -> Option<Arc<SessionRuntime>> {
    runtimes
        .lock()
        .ok()
        .and_then(|runtimes| runtimes.get(session_id).map(Arc::clone))
        .filter(|runtime| !runtime.is_closed())
}

fn runtime_authorization_context(session_id: &str) -> Result<Option<AuthorizationContext>, String> {
    let connection = database::open_connection()?;
    runtime_authorization_context_for_connection(&connection, session_id)
}

fn runtime_authorization_context_for_connection(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<AuthorizationContext>, String> {
    if let Some(active_assignment) =
        task_runtime::get_active_assignment_for_session(connection, session_id)?
    {
        if active_assignment.worker_type == "role" {
            if let Some(role_instance_id) = active_assignment.role_instance_id {
                return Ok(Some(AuthorizationContext {
                    actor_type: "role_instance".into(),
                    actor_id: role_instance_id,
                }));
            }
        }

        if active_assignment.worker_type == "agent" {
            if let Some(agent_id) = active_assignment.worker_id {
                return Ok(Some(AuthorizationContext {
                    actor_type: "agent".into(),
                    actor_id: agent_id,
                }));
            }
        }
    }

    let agent_id = connection
        .query_row(
            "SELECT agent_id FROM agent_runtime_states WHERE main_session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to resolve agent runtime authorization context: {error}")
        })?;

    if let Some(agent_id) = agent_id {
        return Ok(Some(AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent_id,
        }));
    }

    let role_instance_id = connection
        .query_row(
            "SELECT id FROM role_instances WHERE session_id = ?1 AND status IN ('running', 'waiting', 'idle') LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve session authorization context: {error}"))?;

    if let Some(role_instance_id) = role_instance_id {
        return Ok(Some(AuthorizationContext {
            actor_type: "role_instance".into(),
            actor_id: role_instance_id,
        }));
    }

    let agent_id = connection
        .query_row(
            "SELECT worker_id FROM task_lane_assignments WHERE session_id = ?1 AND worker_type = 'agent' AND status IN ('queued', 'active') LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve agent session authorization context: {error}"))?;

    if let Some(agent_id) = agent_id {
        return Ok(Some(AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: agent_id,
        }));
    }

    Ok(Some(AuthorizationContext {
        actor_type: "user".into(),
        actor_id: "desktop-user".into(),
    }))
}

fn extract_message_text(message: &Value) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };

    if let Some(text) = content.as_str() {
        return text.trim().to_string();
    }

    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some("text") {
                block.get("text").and_then(Value::as_str).map(str::trim)
            } else {
                None
            }
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn parse_model_summary(value: &Value) -> Option<SessionModel> {
    Some(SessionModel {
        id: value.get("id")?.as_str()?.to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_else(|| value.get("id").and_then(Value::as_str).unwrap_or("Model"))
            .to_string(),
        provider: value.get("provider")?.as_str()?.to_string(),
        api: value
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        reasoning: value
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::{params, Connection};

    use crate::services::database;

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn seed_role(connection: &Connection, role_id: &str) {
        connection
            .execute(
                "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, direct_permissions, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, 'off', 1, '[]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                params![role_id, role_id, role_id],
            )
            .expect("role should seed");
    }

    fn seed_agent(connection: &Connection, agent_id: &str) {
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, NULL, 'off', '[]', 0, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                params![agent_id, agent_id, agent_id],
            )
            .expect("agent should seed");
    }

    #[test]
    fn runtime_authorization_prefers_active_role_assignment_over_stale_session_binding() {
        let connection = in_memory_connection();
        seed_role(&connection, "role-1");
        seed_role(&connection, "role-2");

        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-stale', 'role-1', 'Stale instance', 'failed', NULL, 'session-1', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("stale role instance should seed");
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-active', 'role-2', 'Active instance', 'running', NULL, 'session-1', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("active role instance should seed");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES ('task-1', 'orchestra', 1, 'ORC-1', 'Task 1', NULL, 'task', 'in_progress', 'P1', NULL, NULL, 'role', 'role-2', NULL, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("task should seed");
        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-1', 'task-1', 'workflow-1', 'lane-1', 'role', 'role-2', 'active',
                    'session-1', '/tmp/runtime', NULL, 'instance-active', NULL,
                    '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                )
                "#,
                [],
            )
            .expect("active assignment should seed");

        let authorization = runtime_authorization_context_for_connection(&connection, "session-1")
            .expect("authorization should resolve")
            .expect("authorization should exist");
        assert_eq!(authorization.actor_type, "role_instance");
        assert_eq!(authorization.actor_id, "instance-active");
    }

    #[test]
    fn runtime_authorization_prefers_active_agent_assignment_over_stale_role_binding() {
        let connection = in_memory_connection();
        seed_role(&connection, "role-1");

        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-stale', 'role-1', 'Stale instance', 'failed', NULL, 'session-2', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("stale role instance should seed");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES ('task-2', 'orchestra', 2, 'ORC-2', 'Task 2', NULL, 'task', 'in_progress', 'P1', NULL, NULL, 'agent', 'agent-1', NULL, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("task should seed");
        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'assignment-2', 'task-2', 'workflow-1', 'lane-2', 'agent', 'agent-1', 'active',
                    'session-2', '/tmp/runtime', NULL, NULL, NULL,
                    '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                )
                "#,
                [],
            )
            .expect("agent assignment should seed");

        let authorization = runtime_authorization_context_for_connection(&connection, "session-2")
            .expect("authorization should resolve")
            .expect("authorization should exist");
        assert_eq!(authorization.actor_type, "agent");
        assert_eq!(authorization.actor_id, "agent-1");
    }

    #[test]
    fn runtime_authorization_uses_agent_main_session_when_idle() {
        let connection = in_memory_connection();
        seed_agent(&connection, "agent-7");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', 'agent-7', 'idle', 'session-idle-agent', '/tmp/runtime', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("agent runtime state should seed");

        let authorization =
            runtime_authorization_context_for_connection(&connection, "session-idle-agent")
                .expect("authorization should resolve")
                .expect("authorization should exist");
        assert_eq!(authorization.actor_type, "agent");
        assert_eq!(authorization.actor_id, "agent-7");
    }
}

fn extract_rpc_error(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            payload
                .pointer("/assistantMessageEvent/error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            payload
                .pointer("/message/errorMessage")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "pi reported an RPC error".into())
}
