use std::{
    collections::HashMap,
    env,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use rusqlite::OptionalExtension;
use serde_json::{json, Value};
use tauri::{path::BaseDirectory, AppHandle, Manager};
use uuid::Uuid;

use crate::{
    models::{
        AuthorizationContext, SessionModel, SessionModelState, SessionRuntimeDetails, SessionStats,
        SessionStreamEnvelope,
    },
    services::{
        app_events, database, harness_settings, pi_sessions::get_session_path, task_runtime,
    },
};

const RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const NON_PROMPT_DELIVERY_GRACE: Duration = Duration::from_secs(90);

fn resolve_orchestra_extension_path(app: &AppHandle) -> Result<PathBuf, String> {
    if let Ok(project_root) = env::var("ORCHESTRA_PROJECT_ROOT") {
        let fallback = Path::new(&project_root).join("extensions/orchestra-tools.ts");
        if fallback.exists() {
            return Ok(fallback);
        }
    }

    let path = app
        .path()
        .resolve("extensions/orchestra-tools.ts", BaseDirectory::Resource)
        .map_err(|error| format!("Unable to resolve packaged Orchestra extension path: {error}"))?;

    if path.exists() {
        return Ok(path);
    }

    Err(format!(
        "Packaged Orchestra extension path does not exist: {}",
        path.display()
    ))
}

fn build_runtime_pi_args(
    session_path: &Path,
    session_dir: &Path,
    orchestra_extension_path: &Path,
    extra_extensions: &[String],
) -> Vec<String> {
    let mut args = vec![
        "--offline".to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
        "--session".to_string(),
        session_path.display().to_string(),
        "--session-dir".to_string(),
        session_dir.display().to_string(),
        "--no-extensions".to_string(),
        "--extension".to_string(),
        orchestra_extension_path.display().to_string(),
    ];
    for extension in extra_extensions {
        args.push("--extension".to_string());
        args.push(extension.clone());
    }
    args
}

fn format_path_diagnostic(path: &std::path::Path) -> String {
    let parent = path.parent();
    format!(
        "{} [exists={} dir={} file={} parent={} parent_exists={}]",
        path.display(),
        path.exists(),
        path.is_dir(),
        path.is_file(),
        parent
            .map(|value| value.display().to_string())
            .unwrap_or_else(|| "<none>".into()),
        parent.map(|value| value.exists()).unwrap_or(false),
    )
}

pub struct SessionRuntime {
    session_id: String,
    project_root: Mutex<PathBuf>,
    session_dir: PathBuf,
    session_path: PathBuf,
    pi_executable_path: PathBuf,
    shell_path: Option<String>,
    orchestra_extension_path: PathBuf,
    extra_extensions: Vec<String>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    subscribed: Mutex<bool>,
    current_run_id: Mutex<Option<String>>,
    closed: Mutex<bool>,
    last_non_prompt_delivery_at: Mutex<Option<Instant>>,
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
        let extra_extensions = harness_settings::get_pi_runtime_settings()?.extra_extensions;

        let pi_executable = app
            .state::<crate::state::AppState>()
            .sync_pi_runtime_health()?;
        let args = build_runtime_pi_args(
            &session_path,
            &session_dir,
            &extension_path,
            &extra_extensions,
        );
        let requested_project_root = project_root.clone();
        let requested_project_root_diagnostic = format_path_diagnostic(&requested_project_root);
        let session_dir_diagnostic = format_path_diagnostic(&session_dir);
        let session_path_diagnostic = format_path_diagnostic(&session_path);
        let pi_executable_diagnostic = format_path_diagnostic(&pi_executable);
        let extension_path_diagnostic = format_path_diagnostic(&extension_path);
        let extra_extension_diagnostics = if extra_extensions.is_empty() {
            "<none>".to_string()
        } else {
            extra_extensions.join(", ")
        };
        let shell_path = crate::services::pi_sessions::resolve_user_shell_path();

        app.state::<crate::state::AppState>().log(
            "info",
            "sessions.runtime.spawn.request",
            &format!(
                "Session {} spawn request: pi={} cwd={} session_dir={} session_path={} orchestra_extension={} extra_extensions={} shell_path={}",
                session_id,
                pi_executable_diagnostic,
                requested_project_root_diagnostic,
                session_dir_diagnostic,
                session_path_diagnostic,
                extension_path_diagnostic,
                &extra_extension_diagnostics,
                shell_path.as_deref().unwrap_or("<unavailable>"),
            ),
        );

        let mut command = Command::new(&pi_executable);
        crate::services::pi_sessions::apply_user_shell_environment(&mut command);
        let mut child = command
            .args(&args)
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
            .current_dir(&requested_project_root)
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .spawn()
            .map_err(|error| {
                let diagnostic = format!(
                    "Unable to start pi RPC process: {error} (pi={} cwd={} session_dir={} session_path={} orchestra_extension={} extra_extensions={})",
                    pi_executable_diagnostic,
                    requested_project_root_diagnostic,
                    session_dir_diagnostic,
                    session_path_diagnostic,
                    extension_path_diagnostic,
                    &extra_extension_diagnostics,
                );
                app.state::<crate::state::AppState>().log(
                    "error",
                    "sessions.runtime.spawn.failed",
                    &format!("Session {} spawn failed: {}", session_id, diagnostic),
                );
                diagnostic
            })?;

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
            project_root: Mutex::new(requested_project_root),
            session_dir,
            session_path,
            pi_executable_path: pi_executable,
            shell_path,
            orchestra_extension_path: extension_path,
            extra_extensions,
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            subscribed: Mutex::new(false),
            current_run_id: Mutex::new(None),
            closed: Mutex::new(false),
            last_non_prompt_delivery_at: Mutex::new(None),
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

        if event_type == "turn_end" {
            if let Some(run_id) = self.current_run_id() {
                let response_text = payload
                    .get("message")
                    .map(extract_message_text)
                    .unwrap_or_default();
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.run.turn_end",
                    &format!(
                        "Session {} completed turn for run {} with {} chars",
                        self.session_id,
                        run_id,
                        response_text.chars().count()
                    ),
                );
                let _ = crate::services::channels::deliver_channel_response_for_run(
                    self.app.clone(),
                    self.app.state::<crate::state::AppState>().inner(),
                    &self.session_id,
                    &run_id,
                    &response_text,
                );
            }
        }

        if event_type == "error" {
            if let Some(run_id) = self.current_run_id() {
                let error = extract_rpc_error(&payload);
                self.app.state::<crate::state::AppState>().log(
                    "error",
                    "sessions.run.error",
                    &format!(
                        "Session {} received error during run {}: {}",
                        self.session_id, run_id, error
                    ),
                );
                let _ = crate::services::channels::fail_channel_response_for_run(&run_id, &error);
            }
        }

        if event_type == "agent_end" {
            if let Some(run_id) = self.take_current_run_id() {
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.run.agent_end",
                    &format!("Session {} ended run {}", self.session_id, run_id),
                );
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
            self.app.state::<crate::state::AppState>().log(
                "error",
                "sessions.run.process_end",
                &format!(
                    "Session {} terminated active run {}: {}",
                    self.session_id, run_id, error_message
                ),
            );
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
            let _ =
                crate::services::channels::fail_channel_response_for_run(&run_id, &error_message);
            self.emit_stream_event(json!({
                "type": "error",
                "message": error_message,
                "source": "orchestra",
            }));
        }

        self.teardown_process();
    }

    fn emit_stream_event(&self, event: Value) {
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

        let _ = self
            .app
            .state::<crate::state::AppState>()
            .publish_remote_event(
                "session.stream",
                None,
                Some(self.session_id.clone()),
                None,
                None,
                &payload,
            );

        let emit_desktop = self
            .app
            .state::<crate::state::AppState>()
            .subscribed_session_ids()
            .map(|session_ids| session_ids.contains(&self.session_id))
            .unwrap_or(false);
        if !emit_desktop {
            return;
        }

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
            "sessions.run.start",
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

        if delivery_type != "prompt" {
            self.mark_non_prompt_delivery();
        }

        let result = self.send_command(command);
        if let Err(error) = result {
            self.app.state::<crate::state::AppState>().log(
                "error",
                "sessions.run.start_failed",
                &format!(
                    "Session {} failed to start {} delivery {}: {}",
                    self.session_id, delivery_type, run_id, error
                ),
            );
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

    pub fn get_stats(&self) -> Result<SessionStats, String> {
        let payload = self.send_command(json!({
            "id": format!("session-stats-{}", Uuid::new_v4()),
            "type": "get_session_stats",
        }))?;
        crate::services::pi_sessions::parse_session_stats_payload(&payload, &self.session_id)
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

    pub fn compact(&self, custom_instructions: Option<&str>) -> Result<Value, String> {
        if self.current_run_id().is_some() {
            return Err(
                "Wait for the current response to finish before compacting this session".into(),
            );
        }

        let mut command = json!({
            "id": format!("compact-{}", Uuid::new_v4()),
            "type": "compact",
        });

        if let Some(instructions) = custom_instructions.and_then(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then_some(trimmed)
        }) {
            command["customInstructions"] = Value::String(instructions.to_string());
        }

        self.send_command(command)
    }

    fn is_subscribed(&self) -> bool {
        self.subscribed.lock().map(|value| *value).unwrap_or(false)
    }

    pub fn runtime_details(&self) -> SessionRuntimeDetails {
        let loaded_extensions =
            std::iter::once(self.orchestra_extension_path.display().to_string())
                .chain(self.extra_extensions.iter().cloned())
                .collect::<Vec<_>>();

        SessionRuntimeDetails {
            session_id: self.session_id.clone(),
            source: "live_runtime".into(),
            runtime_active: !self.is_closed(),
            subscribed: self.is_subscribed(),
            extension_load_mode: "explicit_only".into(),
            automatic_extensions_disabled: true,
            orchestra_extension_path: Some(self.orchestra_extension_path.display().to_string()),
            extra_extensions: self.extra_extensions.clone(),
            loaded_extensions,
            pi_executable_path: Some(self.pi_executable_path.display().to_string()),
            shell_path: self.shell_path.clone(),
            project_root: self
                .project_root
                .lock()
                .ok()
                .map(|path| path.display().to_string()),
            session_dir: Some(self.session_dir.display().to_string()),
            session_path: Some(self.session_path.display().to_string()),
            notes: vec![
                "Orchestra launches live runtimes with --no-extensions and then explicitly loads only the extensions listed here.".into(),
            ],
        }
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
        if self.is_subscribed()
            || self.current_run_id().is_some()
            || self.is_closed()
            || self.has_recent_non_prompt_delivery()
        {
            return;
        }

        self.teardown_process();
    }

    fn mark_non_prompt_delivery(&self) {
        if let Ok(mut last) = self.last_non_prompt_delivery_at.lock() {
            *last = Some(Instant::now());
        }
    }

    fn has_recent_non_prompt_delivery(&self) -> bool {
        self.last_non_prompt_delivery_at
            .lock()
            .ok()
            .and_then(|last| *last)
            .map(|instant| instant.elapsed() < NON_PROMPT_DELIVERY_GRACE)
            .unwrap_or(false)
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

pub fn schedule_session_retirement(
    app: AppHandle,
    session_id: String,
    delay: Duration,
    reason: impl Into<String>,
) {
    let reason = reason.into();
    thread::spawn(move || {
        if !delay.is_zero() {
            thread::sleep(delay);
        }

        let should_skip = database::open_connection()
            .ok()
            .and_then(|connection| {
                let is_persistent_agent_session = connection
                    .query_row(
                        "SELECT 1 FROM agent_runtime_states WHERE main_session_id = ?1 LIMIT 1",
                        [session_id.as_str()],
                        |row| row.get::<_, i64>(0),
                    )
                    .optional()
                    .ok()
                    .flatten()
                    .is_some();
                if is_persistent_agent_session {
                    return Some(true);
                }

                task_runtime::get_active_assignment_for_session(&connection, &session_id)
                    .ok()
                    .map(|assignment| assignment.is_some())
            })
            .unwrap_or(false);

        if should_skip {
            return;
        }

        let state = app.state::<crate::state::AppState>();
        state.log(
            "info",
            "sessions.retire",
            &format!("Retiring session {} ({})", session_id, reason),
        );

        if let Ok(Some(runtime)) = state.remove_session_runtime(&session_id) {
            runtime.shutdown();
        }
        let _ = state.clear_session_tracking(&session_id);
        let _ = app_events::emit_session_change(&app, "sessions.retire", [session_id.clone()]);
    });
}

pub fn ensure_runtime(
    runtimes: &Mutex<HashMap<String, Arc<SessionRuntime>>>,
    app: AppHandle,
    project_root: PathBuf,
    session_dir: PathBuf,
    session_id: &str,
) -> Result<Arc<SessionRuntime>, String> {
    let existing_runtime = if let Ok(mut runtimes_guard) = runtimes.lock() {
        if let Some(existing) = runtimes_guard.get(session_id).cloned() {
            if !existing.is_closed() {
                let same_project_root = existing
                    .project_root
                    .lock()
                    .map(|current| *current == project_root)
                    .unwrap_or(false);
                if same_project_root || existing.has_active_prompt() {
                    app.state::<crate::state::AppState>().log(
                        "info",
                        "sessions.runtime.reuse",
                        &format!("Reusing live pi RPC runtime for session {}", session_id),
                    );
                    return Ok(existing);
                }

                app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.runtime.respawn",
                    &format!(
                        "Respawning live pi RPC runtime for session {} to switch cwd to {}",
                        session_id,
                        project_root.display()
                    ),
                );
            }
            runtimes_guard.remove(session_id);
            Some(existing)
        } else {
            None
        }
    } else {
        return Err("Unable to access live session runtime state".into());
    };

    if let Some(existing) = existing_runtime {
        if !existing.is_closed() {
            existing.shutdown();
        }
    }

    let session_path = get_session_path(&session_dir, session_id)?;
    let runtime = SessionRuntime::spawn(
        app,
        project_root,
        session_dir,
        session_id.to_string(),
        session_path,
    )?;

    if let Ok(mut runtimes_guard) = runtimes.lock() {
        runtimes_guard.insert(session_id.to_string(), Arc::clone(&runtime));
        Ok(runtime)
    } else {
        Err("Unable to access live session runtime state".into())
    }
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

pub fn get_session_runtime_details(
    app: &AppHandle,
    state: &crate::state::AppState,
    session_id: &str,
) -> Result<SessionRuntimeDetails, String> {
    if let Some(runtime) = maybe_runtime(&state.session_runtimes, session_id) {
        return Ok(runtime.runtime_details());
    }

    let context = crate::services::pi_sessions::find_session_context_for_session(session_id)?;
    let session_path = get_session_path(&context.session_dir, session_id)?;
    let orchestra_extension_path = resolve_orchestra_extension_path(app)?;
    let extra_extensions = harness_settings::get_pi_runtime_settings()?.extra_extensions;
    let pi_executable_path = state
        .sync_pi_runtime_health()
        .ok()
        .map(|path| path.display().to_string());
    let shell_path = crate::services::pi_sessions::resolve_user_shell_path();
    let loaded_extensions = std::iter::once(orchestra_extension_path.display().to_string())
        .chain(extra_extensions.iter().cloned())
        .collect::<Vec<_>>();

    Ok(SessionRuntimeDetails {
        session_id: session_id.to_string(),
        source: "expected_config".into(),
        runtime_active: false,
        subscribed: state
            .subscribed_session_ids()
            .map(|sessions| sessions.contains(session_id))
            .unwrap_or(false),
        extension_load_mode: "explicit_only".into(),
        automatic_extensions_disabled: true,
        orchestra_extension_path: Some(orchestra_extension_path.display().to_string()),
        extra_extensions,
        loaded_extensions,
        pi_executable_path,
        shell_path,
        project_root: Some(context.project_root.display().to_string()),
        session_dir: Some(context.session_dir.display().to_string()),
        session_path: Some(session_path.display().to_string()),
        notes: vec![
            "No live runtime is currently attached to this session. These details describe what Orchestra will load the next time it spawns the live runtime for this session.".into(),
            "Orchestra launches live runtimes with --no-extensions and then explicitly loads only the extensions listed here.".into(),
        ],
    })
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

    #[test]
    fn build_runtime_pi_args_appends_configured_extensions_after_orchestra_extension() {
        let args = build_runtime_pi_args(
            Path::new("/tmp/session.jsonl"),
            Path::new("/tmp/sessions"),
            Path::new("/tmp/extensions/orchestra-tools.ts"),
            &[
                "npm:pi-example".to_string(),
                "./extensions/local-extra.ts".to_string(),
            ],
        );

        assert_eq!(
            args,
            vec![
                "--offline".to_string(),
                "--mode".to_string(),
                "rpc".to_string(),
                "--session".to_string(),
                "/tmp/session.jsonl".to_string(),
                "--session-dir".to_string(),
                "/tmp/sessions".to_string(),
                "--no-extensions".to_string(),
                "--extension".to_string(),
                "/tmp/extensions/orchestra-tools.ts".to_string(),
                "--extension".to_string(),
                "npm:pi-example".to_string(),
                "--extension".to_string(),
                "./extensions/local-extra.ts".to_string(),
            ]
        );
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
