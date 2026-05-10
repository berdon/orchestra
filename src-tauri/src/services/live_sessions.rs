use std::{
    collections::{HashMap, VecDeque},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::{Duration, Instant},
};

use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tauri::{AppHandle, Manager};
use uuid::Uuid;

use crate::{
    models::{
        AuthorizationContext, ManagedSkillRuntimeDiagnostics, OrchestraToolDefinition,
        PiRuntimeHealth, SessionControlCapabilities, SessionControlCapability,
        SessionControlOperationState, SessionModel, SessionModelState, SessionRuntimeDetails,
        SessionStats, SessionStreamEnvelope,
    },
    services::{
        app_events, database, harness_settings, pi_auth_failures,
        pi_sessions::get_session_path,
        runtime_skills,
        session_compaction::{
            parse_compaction_window_spec, resolve_session_compaction_policy, CompactionWindowSpec,
        },
        session_ownership,
    },
};

const RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);
const NON_PROMPT_DELIVERY_GRACE: Duration = Duration::from_secs(90);
const DEFAULT_SESSION_DELIVERY_START_TIMEOUT: Duration = Duration::from_secs(90);
const SESSION_DELIVERY_START_TIMEOUT_ENV: &str = "ORCHESTRA_SESSION_DELIVERY_START_TIMEOUT_MS";

fn supported_control_capability() -> SessionControlCapability {
    SessionControlCapability {
        status: "supported".into(),
        reason: None,
    }
}

fn unknown_control_capability() -> SessionControlCapability {
    SessionControlCapability {
        status: "unknown".into(),
        reason: None,
    }
}

fn unsupported_control_capability(reason: &str) -> SessionControlCapability {
    SessionControlCapability {
        status: "unsupported".into(),
        reason: Some(reason.into()),
    }
}

pub(crate) fn is_unknown_command_error(error: &str) -> bool {
    error.to_ascii_lowercase().contains("unknown command")
}

fn build_runtime_pi_args(
    session_path: &Path,
    session_dir: &Path,
    orchestra_extension_path: &Path,
    extra_extensions: &[String],
    skill_launch_plan: &runtime_skills::ManagedPiSkillLaunchPlan,
) -> Vec<String> {
    let mut args = vec![
        "--offline".to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
        "--session".to_string(),
        session_path.display().to_string(),
        "--session-dir".to_string(),
        session_dir.display().to_string(),
    ];
    runtime_skills::append_managed_pi_extension_and_skill_args(
        &mut args,
        orchestra_extension_path,
        extra_extensions,
        skill_launch_plan,
    );
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

fn session_delivery_start_timeout() -> Duration {
    std::env::var(SESSION_DELIVERY_START_TIMEOUT_ENV)
        .ok()
        .and_then(|value| value.parse::<u64>().ok())
        .map(Duration::from_millis)
        .filter(|duration| !duration.is_zero())
        .unwrap_or(DEFAULT_SESSION_DELIVERY_START_TIMEOUT)
}

#[derive(Debug, Clone)]
struct RuntimeAuthorizationSnapshot {
    authorization_context: Option<AuthorizationContext>,
    allowed_tools: Vec<OrchestraToolDefinition>,
    hash: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
enum SessionRuntimeReuseDecision {
    Reuse,
    ReuseUntilIdle {
        cwd_changed: bool,
        skills_changed: bool,
        auth_tools_changed: bool,
    },
    Respawn {
        cwd_changed: bool,
        skills_changed: bool,
        auth_tools_changed: bool,
    },
}

fn compute_runtime_authorization_snapshot_hash(
    authorization_context: Option<&AuthorizationContext>,
    allowed_tools: &[OrchestraToolDefinition],
) -> Result<String, String> {
    let payload = serde_json::to_vec(&json!({
        "authorizationContext": authorization_context,
        "allowedTools": allowed_tools,
    }))
    .map_err(|error| format!("Unable to serialize runtime authorization snapshot: {error}"))?;
    Ok(format!("{:x}", Sha256::digest(payload)))
}

fn decide_session_runtime_reuse(
    current_project_root: &Path,
    requested_project_root: &Path,
    current_skill_context_hash: &str,
    desired_skill_context_hash: &str,
    current_auth_tool_snapshot_hash: &str,
    desired_auth_tool_snapshot_hash: &str,
    has_active_prompt: bool,
) -> SessionRuntimeReuseDecision {
    let cwd_changed = current_project_root != requested_project_root;
    let skills_changed = current_skill_context_hash != desired_skill_context_hash;
    let auth_tools_changed = current_auth_tool_snapshot_hash != desired_auth_tool_snapshot_hash;

    if !cwd_changed && !skills_changed && !auth_tools_changed {
        SessionRuntimeReuseDecision::Reuse
    } else if has_active_prompt {
        SessionRuntimeReuseDecision::ReuseUntilIdle {
            cwd_changed,
            skills_changed,
            auth_tools_changed,
        }
    } else {
        SessionRuntimeReuseDecision::Respawn {
            cwd_changed,
            skills_changed,
            auth_tools_changed,
        }
    }
}

#[derive(Debug, Clone)]
struct QueuedDelivery {
    run_id: String,
    delivery_type: String,
    message: String,
    accepted_at: Instant,
}

#[derive(Debug, Clone)]
struct ActiveDelivery {
    run_id: String,
    delivery_type: String,
    accepted_at: Instant,
    started: bool,
}

pub struct SessionRuntime {
    instance_id: String,
    session_id: String,
    project_root: Mutex<PathBuf>,
    session_dir: PathBuf,
    session_path: PathBuf,
    pi_runtime_health: PiRuntimeHealth,
    pi_executable_path: PathBuf,
    pi_runtime_source: String,
    pi_agent_dir: PathBuf,
    shell_path: Option<String>,
    orchestra_extension_path: PathBuf,
    extra_extensions: Vec<String>,
    skill_context_hash: String,
    auth_tool_snapshot_hash: String,
    managed_skills: ManagedSkillRuntimeDiagnostics,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Option<Child>>,
    pending: Mutex<HashMap<String, mpsc::Sender<Result<Value, String>>>>,
    subscribed: Mutex<bool>,
    current_run_id: Mutex<Option<String>>,
    current_prompt_message: Mutex<Option<String>>,
    active_delivery: Mutex<Option<ActiveDelivery>>,
    queued_deliveries: Mutex<VecDeque<QueuedDelivery>>,
    closed: Mutex<bool>,
    last_non_prompt_delivery_at: Mutex<Option<Instant>>,
    reload_capability: Mutex<SessionControlCapability>,
    compact_capability: Mutex<SessionControlCapability>,
    auto_compact_capability: Mutex<SessionControlCapability>,
    control_operation: Mutex<Option<SessionControlOperationState>>,
    last_auto_compaction_context_tokens: Mutex<Option<i64>>,
    app: AppHandle,
}

impl SessionRuntime {
    fn spawn(
        app: AppHandle,
        project_root: PathBuf,
        session_dir: PathBuf,
        session_id: String,
        session_path: PathBuf,
        skill_launch_plan: runtime_skills::ManagedPiSkillLaunchPlan,
        authorization_snapshot: RuntimeAuthorizationSnapshot,
    ) -> Result<Arc<Self>, String> {
        let bridge_config = app.state::<crate::state::AppState>().tool_bridge.clone();
        let RuntimeAuthorizationSnapshot {
            authorization_context,
            allowed_tools,
            hash: auth_tool_snapshot_hash,
        } = authorization_snapshot;
        let bridge_client_id = format!("bridge-client-{}", Uuid::new_v4().simple());
        let extension_path =
            crate::services::orchestra_paths::resolve_orchestra_extension_path(Some(&app))?;
        let extra_extensions = harness_settings::resolve_spawn_extra_extensions(
            harness_settings::get_pi_runtime_settings()?.extra_extensions,
        )?;
        let pi_runtime = crate::services::pi_runtime::resolve_pi_runtime(None)?;
        let pi_runtime_health = pi_runtime.health();
        let pi_executable = pi_runtime.executable_path.clone();
        let args = build_runtime_pi_args(
            &session_path,
            &session_dir,
            &extension_path,
            &extra_extensions,
            &skill_launch_plan,
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
        let scoped_skill_diagnostics = if skill_launch_plan.skill_paths.is_empty() {
            "<none>".to_string()
        } else {
            skill_launch_plan
                .skill_paths
                .iter()
                .map(|path| path.display().to_string())
                .collect::<Vec<_>>()
                .join(", ")
        };
        let shell_path = crate::services::pi_sessions::resolve_user_shell_path();
        let allowed_tool_count = allowed_tools.len();

        app.state::<crate::state::AppState>().log(
            "info",
            "sessions.runtime.spawn.request",
            &format!(
                "Session {} spawn request: pi={} runtime_source={} runtime_mode={} runtime_version={} cwd={} session_dir={} session_path={} orchestra_extension={} extra_extensions={} scoped_skills={} skill_context_hash={} auth_tool_snapshot_hash={} allowed_tool_count={} shell_path={}",
                session_id,
                pi_executable_diagnostic,
                pi_runtime_health.source,
                pi_runtime_health.mode,
                pi_runtime_health.version.as_deref().unwrap_or("<unknown>"),
                requested_project_root_diagnostic,
                session_dir_diagnostic,
                session_path_diagnostic,
                extension_path_diagnostic,
                &extra_extension_diagnostics,
                &scoped_skill_diagnostics,
                skill_launch_plan.context_hash,
                auth_tool_snapshot_hash,
                allowed_tool_count,
                shell_path.as_deref().unwrap_or("<unavailable>"),
            ),
        );

        let mut command = Command::new(&pi_executable);
        crate::services::pi_sessions::apply_user_shell_environment(&mut command);
        crate::services::pi_runtime::apply_runtime_environment(&mut command, &pi_runtime, None);
        crate::services::pi_sessions::apply_orchestra_pi_environment(&mut command)?;
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
            instance_id: Uuid::new_v4().to_string(),
            session_id,
            project_root: Mutex::new(requested_project_root),
            session_dir,
            session_path,
            pi_runtime_health,
            pi_executable_path: pi_executable,
            pi_runtime_source: pi_runtime.source.clone(),
            pi_agent_dir: pi_runtime.agent_dir.clone(),
            shell_path,
            orchestra_extension_path: extension_path,
            extra_extensions,
            skill_context_hash: skill_launch_plan.context_hash,
            auth_tool_snapshot_hash,
            managed_skills: skill_launch_plan.diagnostics,
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            subscribed: Mutex::new(false),
            current_run_id: Mutex::new(None),
            current_prompt_message: Mutex::new(None),
            active_delivery: Mutex::new(None),
            queued_deliveries: Mutex::new(VecDeque::new()),
            closed: Mutex::new(false),
            last_non_prompt_delivery_at: Mutex::new(None),
            reload_capability: Mutex::new(unknown_control_capability()),
            compact_capability: Mutex::new(supported_control_capability()),
            auto_compact_capability: Mutex::new(unknown_control_capability()),
            control_operation: Mutex::new(None),
            last_auto_compaction_context_tokens: Mutex::new(None),
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
            if let Ok(mut pending) = self.pending.lock() {
                let response_id = payload
                    .get("id")
                    .and_then(Value::as_str)
                    .map(str::to_string);
                let response_command = payload
                    .get("command")
                    .and_then(Value::as_str)
                    .map(str::to_string);

                let matched_pending_id = response_id
                    .clone()
                    .filter(|id| pending.contains_key(id))
                    .or_else(|| {
                        let command = response_command.as_deref()?;
                        let prefix = format!("{command}-");
                        let matches = pending
                            .keys()
                            .filter(|id| id.starts_with(&prefix))
                            .cloned()
                            .collect::<Vec<_>>();
                        if matches.len() == 1 {
                            matches.into_iter().next()
                        } else {
                            None
                        }
                    });

                if let Some(matched_id) = matched_pending_id {
                    if let Some(sender) = pending.remove(&matched_id) {
                        let success = payload.get("success").and_then(Value::as_bool) == Some(true);
                        self.app.state::<crate::state::AppState>().log(
                            "info",
                            "sessions.rpc.response",
                            &format!(
                                "Session {} received response {} success={}",
                                self.session_id, matched_id, success
                            ),
                        );
                        let result = if success {
                            Ok(payload)
                        } else {
                            Err(pi_auth_failures::encode_embedded_model_auth_error(
                                &extract_rpc_error(&payload),
                                None,
                                None,
                            ))
                        };
                        let _ = sender.send(result);
                        return;
                    }
                }

                if let Some(id) = response_id {
                    self.app.state::<crate::state::AppState>().log(
                        "warn",
                        "sessions.rpc.response.unmatched",
                        &format!(
                            "Session {} received unmatched response {}: {}",
                            self.session_id, id, payload
                        ),
                    );
                }
            }
        }

        let event_type = payload
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or("unknown");

        if event_type == "response" {
            self.app.state::<crate::state::AppState>().log(
                "warn",
                "sessions.rpc.response.unhandled",
                &format!(
                    "Session {} received unhandled response payload: {}",
                    self.session_id, payload
                ),
            );
        }

        self.app.state::<crate::state::AppState>().log(
            "info",
            "sessions.rpc.event",
            &format!("Session {} received {}", self.session_id, event_type),
        );

        if event_type != "response" {
            self.mark_active_delivery_started();
        }

        let mut event_payload = payload.clone();
        if let Some(raw_error) = extract_rpc_error_message(&payload) {
            let _ = pi_auth_failures::attach_normalized_model_auth_error(
                &mut event_payload,
                &raw_error,
                None,
                None,
            );
        }
        self.emit_stream_event(event_payload);

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
                if !response_text.trim().is_empty() {
                    if let Ok(connection) = crate::services::database::open_connection() {
                        let _ =
                            crate::services::task_runtime::clear_unanswered_task_whips_for_session(
                                &connection,
                                &self.session_id,
                            );
                    }
                }
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
            let completed_run = if let Some(run_id) = self.take_current_run_id() {
                let _ = self.take_current_prompt_message();
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
                let _ = crate::services::dispatcher::request_dispatcher_check(
                    &self.app,
                    "session.run.agent_end",
                );
                let _ = crate::services::role_dispatch::complete_role_run(&self.session_id);
                true
            } else {
                false
            };

            let promoted_delivery = self.promote_next_queued_delivery();
            if let Some(delivery) = promoted_delivery.as_ref() {
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.run.promoted",
                    &format!(
                        "Session {} promoted queued {} delivery {}",
                        self.session_id, delivery.delivery_type, delivery.run_id
                    ),
                );
            }

            if let Some(runtime) = maybe_runtime(
                &self.app.state::<crate::state::AppState>().session_runtimes,
                &self.session_id,
            ) {
                if completed_run {
                    runtime.mark_non_prompt_delivery();
                    if promoted_delivery.is_none() {
                        let runtime_for_idle = Arc::clone(&runtime);
                        thread::spawn(move || {
                            let _ = maybe_auto_compact(Arc::clone(&runtime_for_idle));
                            runtime_for_idle.close_if_idle();
                        });
                    }
                }
                if promoted_delivery.is_some() {
                    runtime.mark_non_prompt_delivery();
                }
                runtime.close_if_idle();
            } else {
                self.close_if_idle();
            }
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
            let _ = self.take_current_prompt_message();
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
            let _ = crate::services::dispatcher::request_dispatcher_check(
                &self.app,
                "session.run.process_end",
            );
            let _ = crate::services::role_dispatch::fail_role_run(&self.session_id, &error_message);
            let _ =
                crate::services::channels::fail_channel_response_for_run(&run_id, &error_message);
            let mut event = json!({
                "type": "error",
                "message": error_message.clone(),
                "source": "orchestra",
            });
            let _ = pi_auth_failures::attach_normalized_model_auth_error(
                &mut event,
                &error_message,
                None,
                None,
            );
            self.emit_stream_event_for_run(Some(run_id), event);
        }

        for delivery in self.take_queued_deliveries() {
            let message = format!(
                "Queued {} delivery failed before it began processing: {}",
                delivery.delivery_type, error_message
            );
            let _ = crate::services::channels::fail_channel_response_for_run(
                &delivery.run_id,
                &message,
            );
            self.emit_stream_event_for_run(
                Some(delivery.run_id),
                json!({
                    "type": "delivery_error",
                    "message": message,
                    "source": "orchestra",
                }),
            );
        }

        self.teardown_process();
    }

    fn emit_stream_event(&self, event: Value) {
        self.emit_stream_event_for_run(self.current_run_id(), event);
    }

    fn emit_stream_event_for_run(&self, run_id: Option<String>, event: Value) {
        let payload = SessionStreamEnvelope {
            session_id: self.session_id.clone(),
            run_id,
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
            || self.has_queued_deliveries()
    }

    pub fn has_active_control_operation(&self) -> bool {
        self.control_operation
            .lock()
            .ok()
            .and_then(|operation| operation.clone())
            .map(|operation| operation.status == "running")
            .unwrap_or(false)
    }

    pub fn control_operation(&self) -> Option<SessionControlOperationState> {
        self.control_operation
            .lock()
            .ok()
            .and_then(|operation| operation.clone())
    }

    fn set_control_capability(&self, control: &str, capability: SessionControlCapability) {
        let target = match control {
            "reload" => &self.reload_capability,
            "compact" => &self.compact_capability,
            "auto_compact" => &self.auto_compact_capability,
            _ => return,
        };
        if let Ok(mut current) = target.lock() {
            *current = capability;
        }
    }

    fn control_capability(&self, control: &str) -> SessionControlCapability {
        let target = match control {
            "reload" => &self.reload_capability,
            "compact" => &self.compact_capability,
            "auto_compact" => &self.auto_compact_capability,
            _ => return unknown_control_capability(),
        };
        target
            .lock()
            .ok()
            .map(|current| current.clone())
            .unwrap_or_else(unknown_control_capability)
    }

    fn start_control_operation(&self, kind: &str, trigger: &str) -> (String, String) {
        let operation_id = format!("session-control-{}", Uuid::new_v4().simple());
        let started_at = crate::state::now_iso();
        let next_operation = SessionControlOperationState {
            kind: kind.into(),
            trigger: trigger.into(),
            status: "running".into(),
            started_at: started_at.clone(),
            finished_at: None,
            message: None,
        };
        let mut stored_operation = false;
        if let Ok(mut operation) = self.control_operation.lock() {
            let preserve_existing = kind == "compact"
                && trigger == "auto"
                && operation.as_ref().is_some_and(|existing| {
                    existing.kind == "reload"
                        && existing.trigger == "manual"
                        && existing.status == "succeeded"
                });
            if !preserve_existing {
                *operation = Some(next_operation.clone());
                stored_operation = true;
            }
        }
        if stored_operation {
            let _ = self
                .app
                .state::<crate::state::AppState>()
                .set_last_session_control_operation(&self.session_id, next_operation);
        }
        self.emit_stream_event(json!({
            "type": "session_control_start",
            "operationId": operation_id,
            "control": kind,
            "trigger": trigger,
            "startedAt": started_at,
        }));
        (operation_id, started_at)
    }

    fn finish_control_operation(
        &self,
        operation_id: &str,
        kind: &str,
        trigger: &str,
        started_at: &str,
        success: bool,
        message: Option<String>,
        error: Option<String>,
    ) {
        let finished_at = crate::state::now_iso();
        let next_operation = SessionControlOperationState {
            kind: kind.into(),
            trigger: trigger.into(),
            status: if success { "succeeded" } else { "failed" }.into(),
            started_at: started_at.into(),
            finished_at: Some(finished_at.clone()),
            message: message.clone().or_else(|| error.clone()),
        };
        let mut stored_operation = false;
        if let Ok(mut operation) = self.control_operation.lock() {
            let preserve_existing = kind == "compact"
                && trigger == "auto"
                && operation.as_ref().is_some_and(|existing| {
                    existing.kind == "reload"
                        && existing.trigger == "manual"
                        && existing.status == "succeeded"
                });
            if !preserve_existing {
                *operation = Some(next_operation.clone());
                stored_operation = true;
            }
        }
        if stored_operation {
            let _ = self
                .app
                .state::<crate::state::AppState>()
                .set_last_session_control_operation(&self.session_id, next_operation);
        }
        self.emit_stream_event(json!({
            "type": "session_control_end",
            "operationId": operation_id,
            "control": kind,
            "trigger": trigger,
            "startedAt": started_at,
            "finishedAt": finished_at,
            "success": success,
            "message": message,
            "error": error,
        }));
    }

    pub fn mark_control_operation_success(&self, kind: &str, trigger: &str, message: &str) {
        match kind {
            "reload" => self.set_control_capability("reload", supported_control_capability()),
            "compact" => self.set_control_capability("compact", supported_control_capability()),
            _ => {}
        }
        let operation_id = format!("session-control-fallback-{}", Uuid::new_v4().simple());
        let started_at = crate::state::now_iso();
        self.finish_control_operation(
            &operation_id,
            kind,
            trigger,
            &started_at,
            true,
            Some(message.to_string()),
            None,
        );
    }

    pub fn snapshot_control_capabilities(
        &self,
        effective_compaction_window: Option<&str>,
        effective_compaction_window_source: Option<&str>,
        terminal_attached: bool,
        pi_available: bool,
    ) -> SessionControlCapabilities {
        let base_unavailable_reason = if terminal_attached {
            Some("terminal_attached")
        } else if !pi_available {
            Some("pi_unavailable")
        } else {
            None
        };

        let reload = base_unavailable_reason
            .map(unsupported_control_capability)
            .unwrap_or_else(|| self.control_capability("reload"));
        let compact = base_unavailable_reason
            .map(unsupported_control_capability)
            .unwrap_or_else(|| self.control_capability("compact"));
        let auto_compact = if let Some(reason) = base_unavailable_reason {
            unsupported_control_capability(reason)
        } else if matches!(effective_compaction_window, Some("off")) {
            unsupported_control_capability("compaction_window_disabled")
        } else {
            self.control_capability("auto_compact")
        };

        SessionControlCapabilities {
            reload,
            compact,
            auto_compact,
            effective_compaction_window: effective_compaction_window.map(str::to_string),
            effective_compaction_window_source: effective_compaction_window_source
                .map(str::to_string),
        }
    }

    pub fn shutdown(&self) {
        self.teardown_process();
    }

    pub fn abort_active_run(&self) {
        let _ = self.take_current_run_id();
        let _ = self.take_current_prompt_message();
        let _ = self.take_queued_deliveries();
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

        let accepted_at = Instant::now();
        let queued_delivery = QueuedDelivery {
            run_id: run_id.to_string(),
            delivery_type: delivery_type.to_string(),
            message: message.to_string(),
            accepted_at,
        };
        let command_id = format!("{}-{}", delivery_type, run_id);
        let activated_non_prompt_delivery =
            delivery_type != "prompt" && self.current_run_id().is_none();
        let command = match delivery_type {
            "prompt" => {
                self.activate_delivery(run_id, delivery_type, message, accepted_at)?;
                json!({ "id": command_id, "type": "prompt", "message": message })
            }
            "steer" | "follow_up" => {
                if self.current_run_id().is_some() {
                    self.queue_delivery(queued_delivery.clone())?;
                } else {
                    self.activate_delivery(run_id, delivery_type, message, accepted_at)?;
                    if let Err(error) = self.ensure_session_run_tracking(run_id) {
                        let _ = self.take_current_run_id();
                        let _ = self.take_current_prompt_message();
                        return Err(error);
                    }
                }
                json!({ "id": command_id, "type": delivery_type, "message": message })
            }
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
            if self.current_run_id().as_deref() == Some(run_id) {
                let _ = self.take_current_run_id();
                let _ = self.take_current_prompt_message();
                if activated_non_prompt_delivery {
                    let _ = self
                        .app
                        .state::<crate::state::AppState>()
                        .end_session_run(&self.session_id, run_id);
                }
            } else {
                let _ = self.remove_queued_delivery(run_id);
            }
            return Err(error);
        }

        if delivery_type != "prompt" && self.is_delivery_queued(run_id, accepted_at) {
            self.spawn_queued_delivery_watchdog(run_id.to_string(), accepted_at);
        }

        if self.current_run_id().as_deref() == Some(run_id) {
            self.spawn_active_delivery_watchdog(run_id.to_string(), accepted_at);
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

    pub fn reload(&self) -> Result<Value, String> {
        if self.current_run_id().is_some() {
            return Err(
                "Wait for the current response to finish before reloading this session".into(),
            );
        }

        self.send_command(json!({
            "id": format!("reload-{}", Uuid::new_v4()),
            "type": "reload",
        }))
    }

    pub fn set_auto_compaction_enabled(&self, enabled: bool) -> Result<Value, String> {
        self.send_command(json!({
            "id": format!("auto-compact-{}", Uuid::new_v4()),
            "type": "set_auto_compaction",
            "enabled": enabled,
        }))
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
            blocked_extra_extensions: Vec::new(),
            loaded_extensions,
            pi_runtime_source: Some(self.pi_runtime_health.source.clone()),
            pi_runtime_mode: Some(self.pi_runtime_health.mode.clone()),
            pi_runtime_status: Some(self.pi_runtime_health.status.clone()),
            pi_executable_path: Some(self.pi_executable_path.display().to_string()),
            pi_package_dir: self.pi_runtime_health.package_dir.clone(),
            pi_agent_dir: self.pi_runtime_health.agent_dir.clone(),
            pi_runtime_version: self.pi_runtime_health.version.clone(),
            pi_runtime_built_at: self.pi_runtime_health.built_at.clone(),
            pi_runtime_manifest_path: self.pi_runtime_health.manifest_path.clone(),
            pi_runtime_error_kind: self.pi_runtime_health.error_kind.clone(),
            pi_runtime_error_message: self.pi_runtime_health.error_message.clone(),
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
            managed_skills: Some(self.managed_skills.clone()),
            control_capabilities: None,
            control_operation: self.control_operation(),
        }
    }

    fn current_run_id(&self) -> Option<String> {
        self.current_run_id
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    fn activate_delivery(
        &self,
        run_id: &str,
        delivery_type: &str,
        message: &str,
        accepted_at: Instant,
    ) -> Result<(), String> {
        let mut current_run_id = self
            .current_run_id
            .lock()
            .map_err(|_| "Unable to access current session run state".to_string())?;
        if current_run_id.is_some() {
            return Err("This session is already processing a message".into());
        }
        let mut active_delivery = self
            .active_delivery
            .lock()
            .map_err(|_| "Unable to access current session delivery state".to_string())?;
        *current_run_id = Some(run_id.to_string());
        *active_delivery = Some(ActiveDelivery {
            run_id: run_id.to_string(),
            delivery_type: delivery_type.to_string(),
            accepted_at,
            started: false,
        });
        if let Ok(mut current_prompt_message) = self.current_prompt_message.lock() {
            *current_prompt_message = Some(message.to_string());
        }
        Ok(())
    }

    fn mark_active_delivery_started(&self) {
        let current_run_id = self.current_run_id();
        if let (Some(run_id), Ok(mut active_delivery)) =
            (current_run_id, self.active_delivery.lock())
        {
            if let Some(delivery) = active_delivery.as_mut() {
                if delivery.run_id == run_id {
                    delivery.started = true;
                }
            }
        }
    }

    fn clear_timed_out_active_delivery(
        &self,
        run_id: &str,
        accepted_at: Instant,
    ) -> Option<String> {
        let mut current_run_id = match self.current_run_id.lock() {
            Ok(current_run_id) => current_run_id,
            Err(_) => return None,
        };
        if current_run_id.as_deref() != Some(run_id) {
            return None;
        }
        let mut active_delivery = match self.active_delivery.lock() {
            Ok(active_delivery) => active_delivery,
            Err(_) => return None,
        };
        let Some(delivery) = active_delivery.as_ref() else {
            return None;
        };
        if delivery.run_id != run_id || delivery.accepted_at != accepted_at || delivery.started {
            return None;
        }
        let delivery_type = delivery.delivery_type.clone();
        *current_run_id = None;
        *active_delivery = None;
        if let Ok(mut current_prompt_message) = self.current_prompt_message.lock() {
            *current_prompt_message = None;
        }
        Some(delivery_type)
    }

    fn has_queued_deliveries(&self) -> bool {
        self.queued_deliveries
            .lock()
            .map(|deliveries| !deliveries.is_empty())
            .unwrap_or(false)
    }

    fn queue_delivery(&self, delivery: QueuedDelivery) -> Result<(), String> {
        let mut queued_deliveries = self
            .queued_deliveries
            .lock()
            .map_err(|_| "Unable to access queued session deliveries".to_string())?;
        if delivery.delivery_type == "steer" {
            let insert_at = queued_deliveries
                .iter()
                .position(|queued| queued.delivery_type != "steer")
                .unwrap_or(queued_deliveries.len());
            queued_deliveries.insert(insert_at, delivery);
        } else {
            queued_deliveries.push_back(delivery);
        }
        Ok(())
    }

    fn is_delivery_queued(&self, run_id: &str, accepted_at: Instant) -> bool {
        self.queued_deliveries
            .lock()
            .ok()
            .and_then(|deliveries| {
                deliveries
                    .iter()
                    .find(|delivery| delivery.run_id == run_id)
                    .map(|delivery| delivery.accepted_at == accepted_at)
            })
            .unwrap_or(false)
    }

    fn remove_queued_delivery(&self, run_id: &str) -> bool {
        if let Ok(mut queued_deliveries) = self.queued_deliveries.lock() {
            let original_len = queued_deliveries.len();
            queued_deliveries.retain(|delivery| delivery.run_id != run_id);
            return queued_deliveries.len() != original_len;
        }
        false
    }

    fn take_queued_deliveries(&self) -> Vec<QueuedDelivery> {
        self.queued_deliveries
            .lock()
            .map(|mut deliveries| deliveries.drain(..).collect::<Vec<_>>())
            .unwrap_or_default()
    }

    fn promote_next_queued_delivery(&self) -> Option<QueuedDelivery> {
        let next_delivery = self
            .queued_deliveries
            .lock()
            .ok()
            .and_then(|mut deliveries| deliveries.pop_front());
        if let Some(delivery) = next_delivery.as_ref() {
            let activated_at = Instant::now();
            if self
                .activate_delivery(
                    &delivery.run_id,
                    &delivery.delivery_type,
                    &delivery.message,
                    activated_at,
                )
                .is_err()
            {
                return None;
            }
            if let Err(error) = self.ensure_session_run_tracking(&delivery.run_id) {
                let message = format!(
                    "Message was accepted but Orchestra could not promote it into the active session run. The session was reset so you can retry your message. ({error})"
                );
                self.app.state::<crate::state::AppState>().log(
                    "error",
                    "sessions.run.promote.failed",
                    &format!(
                        "Session {} failed to track promoted queued delivery {}: {}",
                        self.session_id, delivery.run_id, error
                    ),
                );
                let _ = self.take_current_run_id();
                let _ = self.take_current_prompt_message();
                let _ = crate::services::channels::fail_channel_response_for_run(
                    &delivery.run_id,
                    &message,
                );
                self.emit_stream_event_for_run(
                    Some(delivery.run_id.clone()),
                    json!({
                        "type": "delivery_error",
                        "message": message,
                        "source": "orchestra",
                    }),
                );
                return None;
            }
            self.spawn_active_delivery_watchdog(delivery.run_id.clone(), activated_at);
        }
        next_delivery
    }

    fn spawn_queued_delivery_watchdog(&self, run_id: String, accepted_at: Instant) {
        let app = self.app.clone();
        let session_id = self.session_id.clone();
        thread::spawn(move || {
            thread::sleep(session_delivery_start_timeout());
            let Some(runtime) = maybe_runtime(
                &app.state::<crate::state::AppState>().session_runtimes,
                &session_id,
            ) else {
                return;
            };
            if !runtime.is_delivery_queued(&run_id, accepted_at) {
                return;
            }
            let message = "Message was accepted but never reached the front of the session queue in time. Retry your message.";
            if runtime.remove_queued_delivery(&run_id) {
                app.state::<crate::state::AppState>().log(
                    "error",
                    "sessions.run.delivery_timeout",
                    &format!(
                        "Session {} delivery {} timed out before it started processing",
                        session_id, run_id
                    ),
                );
                let _ = crate::services::channels::fail_channel_response_for_run(&run_id, message);
                runtime.emit_stream_event_for_run(
                    Some(run_id.clone()),
                    json!({
                        "type": "delivery_error",
                        "message": message,
                        "source": "orchestra",
                    }),
                );
                runtime.close_if_idle();
            }
        });
    }

    fn spawn_active_delivery_watchdog(&self, run_id: String, accepted_at: Instant) {
        let app = self.app.clone();
        let session_id = self.session_id.clone();
        thread::spawn(move || {
            thread::sleep(session_delivery_start_timeout());
            let Some(runtime) = maybe_runtime(
                &app.state::<crate::state::AppState>().session_runtimes,
                &session_id,
            ) else {
                return;
            };
            let _ = runtime.handle_active_delivery_timeout(&run_id, accepted_at);
        });
    }

    fn handle_active_delivery_timeout(&self, run_id: &str, accepted_at: Instant) -> bool {
        let Some(delivery_type) = self.clear_timed_out_active_delivery(run_id, accepted_at) else {
            return false;
        };
        let message =
            "Message was accepted but the session never started processing it. Orchestra reset the stale runtime so you can retry your message.";
        self.app.state::<crate::state::AppState>().log(
            "error",
            "sessions.run.delivery_timeout",
            &format!(
                "Session {} {} delivery {} timed out after acceptance before any runtime activity",
                self.session_id, delivery_type, run_id
            ),
        );
        let _ = self
            .app
            .state::<crate::state::AppState>()
            .clear_active_session_run(&self.session_id);
        let _ = crate::services::channels::fail_channel_response_for_run(run_id, message);
        self.emit_stream_event_for_run(
            Some(run_id.to_string()),
            json!({
                "type": "delivery_error",
                "message": message,
                "source": "orchestra",
            }),
        );
        self.teardown_process();
        let _ = app_events::emit_session_change(
            &self.app,
            "sessions.delivery_timeout",
            [self.session_id.clone()],
        );
        true
    }

    fn ensure_session_run_tracking(&self, run_id: &str) -> Result<(), String> {
        let state = self.app.state::<crate::state::AppState>();
        match state.begin_session_run(&self.session_id, run_id) {
            Ok(()) => Ok(()),
            Err(error) if error == "This session is already processing a message" => {
                state.clear_active_session_run(&self.session_id)?;
                state.begin_session_run(&self.session_id, run_id)
            }
            Err(error) => Err(error),
        }
    }

    pub fn current_prompt_message(&self) -> Option<String> {
        self.current_prompt_message
            .lock()
            .ok()
            .and_then(|value| value.clone())
    }

    fn take_current_run_id(&self) -> Option<String> {
        let run_id = self
            .current_run_id
            .lock()
            .ok()
            .and_then(|mut value| value.take());
        if run_id.is_some() {
            let _ = self.active_delivery.lock().map(|mut value| value.take());
        }
        run_id
    }

    fn take_current_prompt_message(&self) -> Option<String> {
        self.current_prompt_message
            .lock()
            .ok()
            .and_then(|mut value| value.take())
    }

    fn close_if_idle(&self) {
        if self.is_subscribed()
            || self.current_run_id().is_some()
            || self.has_queued_deliveries()
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
            let should_remove = runtimes
                .get(&self.session_id)
                .map(|runtime| runtime.instance_id == self.instance_id)
                .unwrap_or(false);
            if should_remove {
                runtimes.remove(&self.session_id);
            } else {
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.runtime.teardown.stale",
                    &format!(
                        "Skipping stale runtime teardown removal for session {} instance {}",
                        self.session_id, self.instance_id
                    ),
                );
            }
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
                session_ownership::load_session_worker_context(&connection, &session_id)
                    .ok()
                    .flatten()
                    .map(|context| {
                        context.current_assignment_id.is_some()
                            || (context.context_source
                                == session_ownership::CONTEXT_SOURCE_AGENT_MAIN_SESSION
                                && context.agent_id.is_some())
                    })
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
    let desired_skill_launch_plan = match runtime_skills::resolve_managed_pi_skill_launch_plan(
        session_id,
    ) {
        Ok(plan) => {
            app.state::<crate::state::AppState>().log(
                "info",
                "skills.runtime.resolved",
                &format!(
                    "Resolved managed skills for session {} (context_hash={} ambient={} resolved={} suppressed={} snapshot={})",
                    session_id,
                    plan.context_hash,
                    plan.diagnostics.ambient_skills.len(),
                    plan.diagnostics.resolved_skills.len(),
                    plan.diagnostics.suppressed_skills.len(),
                    plan.diagnostics
                        .scoped_snapshot
                        .as_ref()
                        .map(|snapshot| snapshot.snapshot_id.as_str())
                        .unwrap_or("<none>"),
                ),
            );
            plan
        }
        Err(error) => {
            app.state::<crate::state::AppState>().log(
                "error",
                "skills.runtime.collision",
                &format!(
                    "Failed to resolve managed skills for session {}: {}",
                    session_id, error
                ),
            );
            return Err(error);
        }
    };
    let desired_skill_context_hash = desired_skill_launch_plan.context_hash.clone();
    let desired_authorization_snapshot = match resolve_runtime_authorization_snapshot(session_id) {
        Ok(snapshot) => snapshot,
        Err(error) => {
            app.state::<crate::state::AppState>().log(
                "error",
                "sessions.runtime.authorization.failed",
                &format!(
                    "Failed to resolve runtime authorization snapshot for session {}: {}",
                    session_id, error
                ),
            );
            return Err(error);
        }
    };
    let desired_auth_tool_snapshot_hash = desired_authorization_snapshot.hash.clone();

    let existing_runtime = if let Ok(mut runtimes_guard) = runtimes.lock() {
        if let Some(existing) = runtimes_guard.get(session_id).cloned() {
            if !existing.is_closed() {
                let current_project_root = existing
                    .project_root
                    .lock()
                    .map(|current| current.clone())
                    .unwrap_or_else(|_| project_root.clone());
                match decide_session_runtime_reuse(
                    &current_project_root,
                    &project_root,
                    &existing.skill_context_hash,
                    &desired_skill_context_hash,
                    &existing.auth_tool_snapshot_hash,
                    &desired_auth_tool_snapshot_hash,
                    existing.has_active_prompt(),
                ) {
                    SessionRuntimeReuseDecision::Reuse => {
                        app.state::<crate::state::AppState>().log(
                            "info",
                            "sessions.runtime.reuse",
                            &format!("Reusing live pi RPC runtime for session {}", session_id),
                        );
                        return Ok(existing);
                    }
                    SessionRuntimeReuseDecision::ReuseUntilIdle {
                        cwd_changed,
                        skills_changed,
                        auth_tools_changed,
                    } => {
                        app.state::<crate::state::AppState>().log(
                            "info",
                            "sessions.runtime.reuse.busy",
                            &format!(
                                "Reusing busy live pi RPC runtime for session {} until idle (cwd_changed={} skills_changed={} auth_tools_changed={} desired_skill_context_hash={} desired_auth_tool_snapshot_hash={})",
                                session_id,
                                cwd_changed,
                                skills_changed,
                                auth_tools_changed,
                                desired_skill_context_hash,
                                desired_auth_tool_snapshot_hash,
                            ),
                        );
                        return Ok(existing);
                    }
                    SessionRuntimeReuseDecision::Respawn {
                        cwd_changed,
                        skills_changed,
                        auth_tools_changed,
                    } => {
                        let mut reasons = Vec::new();
                        if cwd_changed {
                            reasons.push(format!("switch cwd to {}", project_root.display()));
                        }
                        if skills_changed {
                            reasons.push(format!(
                                "apply new skill context {}",
                                desired_skill_context_hash
                            ));
                        }
                        if auth_tools_changed {
                            reasons.push(format!(
                                "apply new authorization/tool snapshot {}",
                                desired_auth_tool_snapshot_hash
                            ));
                        }
                        let reason = if reasons.is_empty() {
                            "refresh runtime".to_string()
                        } else {
                            reasons.join(" and ")
                        };
                        app.state::<crate::state::AppState>().log(
                            "info",
                            if skills_changed {
                                "sessions.runtime.respawn.skills_changed"
                            } else if auth_tools_changed {
                                "sessions.runtime.respawn.authorization_changed"
                            } else {
                                "sessions.runtime.respawn"
                            },
                            &format!(
                                "Respawning live pi RPC runtime for session {} to {}",
                                session_id, reason
                            ),
                        );
                    }
                }
            }
            runtimes_guard.remove(session_id);
            Some(existing)
        } else {
            None
        }
    } else {
        return Err("Unable to access live session runtime state".into());
    };

    let preserved_subscription = existing_runtime
        .as_ref()
        .map(|runtime| runtime.is_subscribed())
        .unwrap_or(false);

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
        desired_skill_launch_plan,
        desired_authorization_snapshot,
    )?;

    if preserved_subscription {
        runtime.set_subscribed(true);
    }

    match runtime.set_auto_compaction_enabled(false) {
        Ok(_) => runtime.set_control_capability("auto_compact", supported_control_capability()),
        Err(error) => {
            let reason = if is_unknown_command_error(&error) {
                "runtime_control_unsupported"
            } else {
                "runtime_control_failed"
            };
            runtime.set_control_capability("auto_compact", unsupported_control_capability(reason));
            runtime.app.state::<crate::state::AppState>().log(
                "warn",
                "sessions.auto_compact.init_failed",
                &format!(
                    "Session {} could not disable PI auto-compaction: {}",
                    session_id, error
                ),
            );
        }
    }

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

fn resolve_effective_compaction_policy(
    session_id: &str,
) -> Result<crate::services::session_compaction::ResolvedCompactionPolicy, String> {
    let settings = harness_settings::get_pi_runtime_settings()?;
    let connection = database::open_connection()?;
    resolve_session_compaction_policy(
        &connection,
        session_id,
        Some(settings.default_compaction_window.as_str()),
    )
}

pub fn get_session_control_snapshot(
    state: &crate::state::AppState,
    session_id: &str,
    terminal_attached: bool,
) -> Result<
    (
        SessionControlCapabilities,
        Option<SessionControlOperationState>,
    ),
    String,
> {
    let policy = resolve_effective_compaction_policy(session_id)?;
    let pi_available = state.sync_pi_runtime_health().is_ok();
    let last_operation = state.last_session_control_operation(session_id)?;

    if let Some(runtime) = maybe_runtime(&state.session_runtimes, session_id) {
        let mut control_capabilities = runtime.snapshot_control_capabilities(
            Some(policy.window_spec.as_str()),
            Some(policy.source.as_str()),
            terminal_attached,
            pi_available,
        );
        let control_operation = runtime
            .control_operation()
            .or_else(|| last_operation.clone());
        if matches!(control_capabilities.reload.status.as_str(), "unknown")
            && control_operation.as_ref().is_some_and(|operation| {
                operation.kind == "reload" && operation.status == "succeeded"
            })
        {
            control_capabilities.reload = supported_control_capability();
        }
        return Ok((control_capabilities, control_operation));
    }

    let unavailable_reason = if terminal_attached {
        Some("terminal_attached")
    } else if !pi_available {
        Some("pi_unavailable")
    } else {
        None
    };

    let compact = unavailable_reason
        .map(unsupported_control_capability)
        .unwrap_or_else(supported_control_capability);
    let reload = unavailable_reason
        .map(unsupported_control_capability)
        .unwrap_or_else(|| {
            last_operation
                .as_ref()
                .filter(|operation| operation.kind == "reload" && operation.status == "succeeded")
                .map(|_| supported_control_capability())
                .unwrap_or_else(unknown_control_capability)
        });
    let auto_compact = if let Some(reason) = unavailable_reason {
        unsupported_control_capability(reason)
    } else if policy.window_spec == "off" {
        unsupported_control_capability("compaction_window_disabled")
    } else {
        unknown_control_capability()
    };

    Ok((
        SessionControlCapabilities {
            reload,
            compact,
            auto_compact,
            effective_compaction_window: Some(policy.window_spec),
            effective_compaction_window_source: Some(policy.source),
        },
        last_operation,
    ))
}

pub fn perform_session_compaction(
    runtime: Arc<SessionRuntime>,
    trigger: &str,
    custom_instructions: Option<String>,
) -> Result<(), String> {
    if runtime.has_active_control_operation() {
        return Err("Wait for the current session control operation to finish".into());
    }

    let (operation_id, started_at) = runtime.start_control_operation("compact", trigger);
    let result = runtime.compact(custom_instructions.as_deref());

    match result {
        Ok(_) => {
            runtime.set_control_capability("compact", supported_control_capability());
            if trigger == "auto" {
                runtime.set_control_capability("auto_compact", supported_control_capability());
            }
            if let Ok(mut last) = runtime.last_auto_compaction_context_tokens.lock() {
                if trigger != "auto" {
                    *last = None;
                }
            }
            runtime.finish_control_operation(
                &operation_id,
                "compact",
                trigger,
                &started_at,
                true,
                Some(if trigger == "auto" {
                    "Session auto-compacted.".into()
                } else {
                    "Session compacted.".into()
                }),
                None,
            );
            let _ = app_events::emit_session_change(
                &runtime.app,
                if trigger == "auto" {
                    "sessions.compact.auto"
                } else {
                    "sessions.compact"
                },
                [runtime.session_id.clone()],
            );
            Ok(())
        }
        Err(error) => {
            if is_unknown_command_error(&error) {
                runtime.set_control_capability(
                    "compact",
                    unsupported_control_capability("runtime_control_unsupported"),
                );
                if trigger == "auto" {
                    runtime.set_control_capability(
                        "auto_compact",
                        unsupported_control_capability("runtime_control_unsupported"),
                    );
                }
            }
            runtime.finish_control_operation(
                &operation_id,
                "compact",
                trigger,
                &started_at,
                false,
                None,
                Some(error.clone()),
            );
            let _ = app_events::emit_session_change(
                &runtime.app,
                "sessions.compact.failed",
                [runtime.session_id.clone()],
            );
            Err(error)
        }
    }
}

fn busy_runtime_context_reload_error() -> String {
    "Wait for the current response to finish before reloading this session so the updated runtime context can be applied".into()
}

fn perform_session_reload_with_launch_plan(
    runtime: Arc<SessionRuntime>,
    trigger: &str,
    desired_skill_launch_plan: runtime_skills::ManagedPiSkillLaunchPlan,
    desired_auth_tool_snapshot_hash: &str,
) -> Result<(), String> {
    if desired_skill_launch_plan.context_hash != runtime.skill_context_hash
        || desired_auth_tool_snapshot_hash != runtime.auth_tool_snapshot_hash
    {
        let project_root = runtime
            .project_root
            .lock()
            .map(|path| path.clone())
            .unwrap_or_else(|_| PathBuf::from("."));

        if matches!(
            decide_session_runtime_reuse(
                &project_root,
                &project_root,
                &runtime.skill_context_hash,
                &desired_skill_launch_plan.context_hash,
                &runtime.auth_tool_snapshot_hash,
                desired_auth_tool_snapshot_hash,
                runtime.has_active_prompt(),
            ),
            SessionRuntimeReuseDecision::ReuseUntilIdle { .. }
        ) {
            runtime.app.state::<crate::state::AppState>().log(
                "info",
                "sessions.reload.deferred.runtime_context_changed",
                &format!(
                    "Rejecting reload for busy session {} until idle because the desired runtime context changed (skill_context {} -> {}, auth_tool_snapshot {} -> {})",
                    runtime.session_id,
                    runtime.skill_context_hash,
                    desired_skill_launch_plan.context_hash,
                    runtime.auth_tool_snapshot_hash,
                    desired_auth_tool_snapshot_hash,
                ),
            );
            return Err(busy_runtime_context_reload_error());
        }

        let replacement = ensure_runtime(
            &runtime
                .app
                .state::<crate::state::AppState>()
                .session_runtimes,
            runtime.app.clone(),
            project_root,
            runtime.session_dir.clone(),
            &runtime.session_id,
        )?;
        if Arc::ptr_eq(&replacement, &runtime) {
            runtime.app.state::<crate::state::AppState>().log(
                "warn",
                "sessions.reload.deferred.runtime_context_changed",
                &format!(
                    "Reload for session {} did not respawn immediately even though the desired runtime context changed (skill_context {} -> {}, auth_tool_snapshot {} -> {})",
                    runtime.session_id,
                    runtime.skill_context_hash,
                    desired_skill_launch_plan.context_hash,
                    runtime.auth_tool_snapshot_hash,
                    desired_auth_tool_snapshot_hash,
                ),
            );
            return Err(busy_runtime_context_reload_error());
        }
        replacement.set_subscribed(runtime.is_subscribed());
        replacement.mark_control_operation_success("reload", trigger, "Session reloaded.");
        let _ = app_events::emit_session_change(
            &replacement.app,
            "sessions.reload",
            [replacement.session_id.clone()],
        );
        return Ok(());
    }

    let (operation_id, started_at) = runtime.start_control_operation("reload", trigger);
    let result = runtime.reload();

    match result {
        Ok(_) => {
            runtime.set_control_capability("reload", supported_control_capability());
            runtime.finish_control_operation(
                &operation_id,
                "reload",
                trigger,
                &started_at,
                true,
                Some("Session reloaded.".into()),
                None,
            );
            let _ = app_events::emit_session_change(
                &runtime.app,
                "sessions.reload",
                [runtime.session_id.clone()],
            );
            Ok(())
        }
        Err(error) => {
            if is_unknown_command_error(&error) {
                runtime.set_control_capability(
                    "reload",
                    unsupported_control_capability("runtime_control_unsupported"),
                );
                return Err(error);
            }
            runtime.finish_control_operation(
                &operation_id,
                "reload",
                trigger,
                &started_at,
                false,
                None,
                Some(error.clone()),
            );
            let _ = app_events::emit_session_change(
                &runtime.app,
                "sessions.reload.failed",
                [runtime.session_id.clone()],
            );
            Err(error)
        }
    }
}

pub fn perform_session_reload(runtime: Arc<SessionRuntime>, trigger: &str) -> Result<(), String> {
    if runtime.has_active_control_operation() {
        return Err("Wait for the current session control operation to finish".into());
    }

    let desired_skill_launch_plan =
        runtime_skills::resolve_managed_pi_skill_launch_plan(&runtime.session_id)?;
    let desired_authorization_snapshot =
        resolve_runtime_authorization_snapshot(&runtime.session_id)?;
    perform_session_reload_with_launch_plan(
        runtime,
        trigger,
        desired_skill_launch_plan,
        &desired_authorization_snapshot.hash,
    )
}

fn should_auto_compact_for_usage(
    context_window: i64,
    context_tokens: i64,
    window_spec: &str,
) -> Result<bool, String> {
    if context_window <= 0 {
        return Ok(false);
    }

    let remaining = context_window - context_tokens;
    let threshold = match parse_compaction_window_spec(window_spec)? {
        CompactionWindowSpec::RemainingPercent(percent) => {
            (context_window * i64::from(percent) + 99) / 100
        }
        CompactionWindowSpec::RemainingTokens(tokens) => tokens,
        CompactionWindowSpec::Off => return Ok(false),
    };

    Ok(remaining <= threshold)
}

#[derive(Debug, PartialEq, Eq)]
struct AutoCompactionEvaluation {
    capability_status: String,
    capability_reason: Option<String>,
    trigger: bool,
    context_tokens: Option<i64>,
    reset_last_context_tokens: bool,
}

fn evaluate_auto_compaction(
    stats: &SessionStats,
    window_spec: &str,
    last_auto_compaction_context_tokens: Option<i64>,
) -> Result<AutoCompactionEvaluation, String> {
    if window_spec == "off" {
        return Ok(AutoCompactionEvaluation {
            capability_status: "unsupported".into(),
            capability_reason: Some("compaction_window_disabled".into()),
            trigger: false,
            context_tokens: None,
            reset_last_context_tokens: false,
        });
    }

    let Some(context_usage) = stats.context_usage.as_ref() else {
        return Ok(AutoCompactionEvaluation {
            capability_status: "unsupported".into(),
            capability_reason: Some("context_usage_unavailable".into()),
            trigger: false,
            context_tokens: None,
            reset_last_context_tokens: false,
        });
    };
    let Some(context_tokens) = context_usage.tokens else {
        return Ok(AutoCompactionEvaluation {
            capability_status: "unsupported".into(),
            capability_reason: Some("context_usage_unavailable".into()),
            trigger: false,
            context_tokens: None,
            reset_last_context_tokens: false,
        });
    };
    if context_usage.context_window <= 0 {
        return Ok(AutoCompactionEvaluation {
            capability_status: "unsupported".into(),
            capability_reason: Some("context_usage_unavailable".into()),
            trigger: false,
            context_tokens: None,
            reset_last_context_tokens: false,
        });
    }

    if !should_auto_compact_for_usage(context_usage.context_window, context_tokens, window_spec)? {
        return Ok(AutoCompactionEvaluation {
            capability_status: "supported".into(),
            capability_reason: None,
            trigger: false,
            context_tokens: None,
            reset_last_context_tokens: true,
        });
    }

    if last_auto_compaction_context_tokens == Some(context_tokens) {
        return Ok(AutoCompactionEvaluation {
            capability_status: "supported".into(),
            capability_reason: None,
            trigger: false,
            context_tokens: None,
            reset_last_context_tokens: false,
        });
    }

    Ok(AutoCompactionEvaluation {
        capability_status: "supported".into(),
        capability_reason: None,
        trigger: true,
        context_tokens: Some(context_tokens),
        reset_last_context_tokens: false,
    })
}

pub fn maybe_auto_compact(runtime: Arc<SessionRuntime>) -> Result<bool, String> {
    if runtime.has_active_prompt() || runtime.has_active_control_operation() {
        return Ok(false);
    }

    let policy = resolve_effective_compaction_policy(&runtime.session_id)?;
    let stats = match runtime.get_stats() {
        Ok(stats) => stats,
        Err(error) => {
            runtime.set_control_capability(
                "auto_compact",
                unsupported_control_capability("context_usage_unavailable"),
            );
            return Err(error);
        }
    };
    let last_auto_compaction_context_tokens = runtime
        .last_auto_compaction_context_tokens
        .lock()
        .ok()
        .and_then(|last| *last);
    let evaluation = evaluate_auto_compaction(
        &stats,
        &policy.window_spec,
        last_auto_compaction_context_tokens,
    )?;

    runtime.set_control_capability(
        "auto_compact",
        SessionControlCapability {
            status: evaluation.capability_status,
            reason: evaluation.capability_reason,
        },
    );

    if !evaluation.trigger {
        if evaluation.reset_last_context_tokens {
            if let Ok(mut last) = runtime.last_auto_compaction_context_tokens.lock() {
                *last = None;
            }
        }
        return Ok(false);
    }

    perform_session_compaction(Arc::clone(&runtime), "auto", None)?;
    if let Ok(mut last) = runtime.last_auto_compaction_context_tokens.lock() {
        *last = evaluation.context_tokens;
    }
    Ok(true)
}

pub fn get_session_runtime_details(
    app: &AppHandle,
    state: &crate::state::AppState,
    session_id: &str,
) -> Result<SessionRuntimeDetails, String> {
    if let Some(runtime) = maybe_runtime(&state.session_runtimes, session_id) {
        let terminal_attached = state
            .terminal_attached_session_ids()
            .map(|sessions| sessions.contains(session_id))
            .unwrap_or(false);
        let (control_capabilities, control_operation) =
            get_session_control_snapshot(state, session_id, terminal_attached)?;
        let mut details = runtime.runtime_details();
        details.control_capabilities = Some(control_capabilities);
        details.control_operation = control_operation;
        return Ok(details);
    }

    let context = crate::services::pi_sessions::find_session_context_for_session(session_id)?;
    let session_path = get_session_path(&context.session_dir, session_id)?;
    let orchestra_extension_path =
        crate::services::orchestra_paths::resolve_orchestra_extension_path(Some(app))?;
    let configured_settings = harness_settings::get_pi_runtime_settings()?;
    let blocked_extra_extensions =
        harness_settings::blocked_packaged_mode_extensions(&configured_settings.extra_extensions);
    let extra_extensions = configured_settings.extra_extensions;
    let pi_runtime_health = crate::services::pi_runtime::current_pi_runtime_health();
    let shell_path = crate::services::pi_sessions::resolve_user_shell_path();
    let loaded_extensions = std::iter::once(orchestra_extension_path.display().to_string())
        .chain(extra_extensions.iter().cloned())
        .collect::<Vec<_>>();

    let terminal_attached = state
        .terminal_attached_session_ids()
        .map(|sessions| sessions.contains(session_id))
        .unwrap_or(false);
    let (control_capabilities, control_operation) =
        get_session_control_snapshot(state, session_id, terminal_attached)?;

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
        blocked_extra_extensions: blocked_extra_extensions.clone(),
        loaded_extensions,
        pi_runtime_source: Some(pi_runtime_health.source.clone()),
        pi_runtime_mode: Some(pi_runtime_health.mode.clone()),
        pi_runtime_status: Some(pi_runtime_health.status.clone()),
        pi_executable_path: pi_runtime_health.resolved_path.clone(),
        pi_package_dir: pi_runtime_health.package_dir.clone(),
        pi_agent_dir: pi_runtime_health.agent_dir.clone(),
        pi_runtime_version: pi_runtime_health.version.clone(),
        pi_runtime_built_at: pi_runtime_health.built_at.clone(),
        pi_runtime_manifest_path: pi_runtime_health.manifest_path.clone(),
        pi_runtime_error_kind: pi_runtime_health.error_kind.clone(),
        pi_runtime_error_message: pi_runtime_health.error_message.clone(),
        shell_path,
        project_root: Some(context.project_root.display().to_string()),
        session_dir: Some(context.session_dir.display().to_string()),
        session_path: Some(session_path.display().to_string()),
        notes: {
            let mut notes = vec![
                "No live runtime is currently attached to this session. These details describe what Orchestra will load the next time it spawns the live runtime for this session.".into(),
                "Orchestra launches live runtimes with --no-extensions and then explicitly loads only the extensions listed here.".into(),
            ];
            if !blocked_extra_extensions.is_empty() {
                notes.push(format!(
                    "Packaged Orchestra will reject unsupported extra extension entries: {}.",
                    blocked_extra_extensions.join(", ")
                ));
            }
            notes
        },
        managed_skills: runtime_skills::get_managed_pi_skill_runtime_diagnostics(session_id).ok(),
        control_capabilities: Some(control_capabilities),
        control_operation,
    })
}

pub fn authorization_context_for_session(
    session_id: &str,
) -> Result<Option<AuthorizationContext>, String> {
    let connection = database::open_connection()?;
    runtime_authorization_context_for_connection(&connection, session_id)
}

fn resolve_runtime_authorization_snapshot(
    session_id: &str,
) -> Result<RuntimeAuthorizationSnapshot, String> {
    let connection = database::open_connection()?;
    resolve_runtime_authorization_snapshot_for_connection(&connection, session_id)
}

fn resolve_runtime_authorization_snapshot_for_connection(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<RuntimeAuthorizationSnapshot, String> {
    let authorization_context =
        runtime_authorization_context_for_connection(connection, session_id)?;
    let allowed_tools = crate::services::tool_bridge::list_bridge_tools(
        connection,
        authorization_context.as_ref(),
    )?;
    let hash = compute_runtime_authorization_snapshot_hash(
        authorization_context.as_ref(),
        &allowed_tools,
    )?;

    Ok(RuntimeAuthorizationSnapshot {
        authorization_context,
        allowed_tools,
        hash,
    })
}

fn runtime_authorization_context_for_connection(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<AuthorizationContext>, String> {
    if let Some(authorization) =
        session_ownership::load_session_authorization_actor(connection, session_id)?
    {
        return Ok(Some(authorization));
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

    static LIVE_SESSIONS_TEST_APP_HANDLE: std::sync::OnceLock<tauri::AppHandle> =
        std::sync::OnceLock::new();

    #[ctor::ctor]
    fn initialize_live_sessions_test_app_handle() {
        let tool_bridge = crate::services::tool_bridge::dummy_tool_bridge_config(
            "live-sessions-tests-main-thread",
        );
        let app = tauri::Builder::default()
            .manage(crate::state::AppState::new(tool_bridge.clone()))
            .build(crate::tauri_context())
            .expect("main-thread test app should build");
        let leaked_app = Box::leak(Box::new(app));
        let app_handle = leaked_app.handle().clone();
        tool_bridge.attach_app_handle(app_handle.clone());
        let _ = LIVE_SESSIONS_TEST_APP_HANDLE.set(app_handle);
    }

    fn test_app_handle() -> tauri::AppHandle {
        LIVE_SESSIONS_TEST_APP_HANDLE
            .get()
            .expect("main-thread live sessions test app should exist")
            .clone()
    }

    fn test_skill_launch_plan(context_hash: &str) -> runtime_skills::ManagedPiSkillLaunchPlan {
        runtime_skills::ManagedPiSkillLaunchPlan {
            context: runtime_skills::ManagedSkillRuntimeContext {
                session_id: Some("session-1".into()),
                project_id: "project-1".into(),
                role_id: None,
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
                context_source: "project_session".into(),
            },
            context_hash: context_hash.into(),
            global_publication_manifest_path: PathBuf::from("/tmp/manifest.json"),
            snapshot: None,
            skill_paths: Vec::new(),
            global_skill_slugs: Vec::new(),
            scoped_skill_slugs: Vec::new(),
            diagnostics: ManagedSkillRuntimeDiagnostics {
                state: "resolved".into(),
                context: crate::models::ManagedSkillRuntimeContextSummary {
                    session_id: Some("session-1".into()),
                    project_id: "project-1".into(),
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                    context_source: "project_session".into(),
                },
                context_hash: context_hash.into(),
                ambient_skills: Vec::new(),
                resolved_skills: Vec::new(),
                suppressed_skills: Vec::new(),
                scoped_snapshot: None,
                global_publication_manifest_path: Some("/tmp/manifest.json".into()),
                notes: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
            },
        }
    }

    fn test_runtime(
        app_handle: &tauri::AppHandle,
        session_id: &str,
        skill_context_hash: &str,
        auth_tool_snapshot_hash: &str,
        active_prompt: bool,
    ) -> Arc<SessionRuntime> {
        Arc::new(SessionRuntime {
            instance_id: format!("test-instance-{session_id}"),
            session_id: session_id.into(),
            project_root: Mutex::new(PathBuf::from("/tmp/project")),
            session_dir: PathBuf::from("/tmp/sessions"),
            session_path: PathBuf::from(format!("/tmp/sessions/{session_id}.jsonl")),
            pi_runtime_health: PiRuntimeHealth {
                source: "test".into(),
                mode: "rpc".into(),
                status: "healthy".into(),
                resolved_path: None,
                package_dir: None,
                agent_dir: None,
                version: None,
                built_at: None,
                manifest_path: None,
                error_kind: None,
                error_message: None,
            },
            pi_executable_path: PathBuf::from("/tmp/pi"),
            pi_runtime_source: "test".into(),
            pi_agent_dir: PathBuf::from("/tmp/agent"),
            shell_path: None,
            orchestra_extension_path: PathBuf::from("/tmp/orchestra-tools.ts"),
            extra_extensions: Vec::new(),
            skill_context_hash: skill_context_hash.into(),
            auth_tool_snapshot_hash: auth_tool_snapshot_hash.into(),
            managed_skills: runtime_skills::ManagedPiSkillLaunchPlan {
                context: runtime_skills::ManagedSkillRuntimeContext {
                    session_id: Some(session_id.into()),
                    project_id: "project-1".into(),
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                    context_source: "project_session".into(),
                },
                context_hash: skill_context_hash.into(),
                global_publication_manifest_path: PathBuf::from("/tmp/manifest.json"),
                snapshot: None,
                skill_paths: Vec::new(),
                global_skill_slugs: Vec::new(),
                scoped_skill_slugs: Vec::new(),
                diagnostics: crate::models::ManagedSkillRuntimeDiagnostics {
                    state: "resolved".into(),
                    context: crate::models::ManagedSkillRuntimeContextSummary {
                        session_id: Some(session_id.into()),
                        project_id: "project-1".into(),
                        role_id: None,
                        agent_id: None,
                        workflow_id: None,
                        workflow_lane_id: None,
                        context_source: "project_session".into(),
                    },
                    context_hash: skill_context_hash.into(),
                    ambient_skills: Vec::new(),
                    resolved_skills: Vec::new(),
                    suppressed_skills: Vec::new(),
                    scoped_snapshot: None,
                    global_publication_manifest_path: Some("/tmp/manifest.json".into()),
                    notes: Vec::new(),
                    warnings: Vec::new(),
                    error_message: None,
                },
            }
            .diagnostics,
            stdin: Mutex::new(None),
            child: Mutex::new(None),
            pending: Mutex::new(HashMap::new()),
            subscribed: Mutex::new(false),
            current_run_id: Mutex::new(active_prompt.then(|| "run-1".into())),
            current_prompt_message: Mutex::new(active_prompt.then(|| "Test prompt".into())),
            active_delivery: Mutex::new(active_prompt.then(|| ActiveDelivery {
                run_id: "run-1".into(),
                delivery_type: "prompt".into(),
                accepted_at: Instant::now(),
                started: false,
            })),
            queued_deliveries: Mutex::new(VecDeque::new()),
            closed: Mutex::new(false),
            last_non_prompt_delivery_at: Mutex::new(None),
            reload_capability: Mutex::new(unknown_control_capability()),
            compact_capability: Mutex::new(supported_control_capability()),
            auto_compact_capability: Mutex::new(unknown_control_capability()),
            control_operation: Mutex::new(None),
            last_auto_compaction_context_tokens: Mutex::new(None),
            app: app_handle.clone(),
        })
    }

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
    fn runtime_authorization_snapshot_refreshes_after_agent_permission_grant() {
        let connection = in_memory_connection();
        seed_agent(&connection, "agent-refresh");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES ('task-agent-refresh', 'orchestra', 3, 'ORC-3', 'Agent refresh', NULL, 'task', 'in_progress', 'P1', NULL, NULL, 'agent', 'agent-refresh', NULL, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
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
                    'assignment-agent-refresh', 'task-agent-refresh', 'workflow-1', 'lane-1', 'agent', 'agent-refresh', 'active',
                    'session-agent-refresh', '/tmp/runtime', NULL, NULL, NULL,
                    '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                )
                "#,
                [],
            )
            .expect("agent assignment should seed");

        let before = resolve_runtime_authorization_snapshot_for_connection(
            &connection,
            "session-agent-refresh",
        )
        .expect("snapshot should resolve");
        assert!(!before
            .allowed_tools
            .iter()
            .any(|tool| tool.name == "list_tasks"));

        connection
            .execute(
                "UPDATE agents SET direct_permissions = '[\"tasks.read\"]' WHERE id = 'agent-refresh'",
                [],
            )
            .expect("agent permissions should update");

        let after = resolve_runtime_authorization_snapshot_for_connection(
            &connection,
            "session-agent-refresh",
        )
        .expect("updated snapshot should resolve");
        assert_ne!(before.hash, after.hash);
        assert!(after
            .allowed_tools
            .iter()
            .any(|tool| tool.name == "list_tasks"));
    }

    #[test]
    fn runtime_authorization_snapshot_refreshes_for_role_instance_after_role_permission_grant() {
        let connection = in_memory_connection();
        seed_role(&connection, "role-refresh");
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-refresh', 'role-refresh', 'Refresh instance', 'running', NULL, 'session-role-refresh', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
                [],
            )
            .expect("role instance should seed");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES ('task-role-refresh', 'orchestra', 4, 'ORC-4', 'Role refresh', NULL, 'task', 'in_progress', 'P1', NULL, NULL, 'role', 'role-refresh', NULL, NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')",
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
                    'assignment-role-refresh', 'task-role-refresh', 'workflow-1', 'lane-1', 'role', 'role-refresh', 'active',
                    'session-role-refresh', '/tmp/runtime', NULL, 'instance-refresh', NULL,
                    '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                )
                "#,
                [],
            )
            .expect("role assignment should seed");

        let before = resolve_runtime_authorization_snapshot_for_connection(
            &connection,
            "session-role-refresh",
        )
        .expect("snapshot should resolve");
        assert_eq!(
            before
                .authorization_context
                .as_ref()
                .map(|value| value.actor_type.as_str()),
            Some("role_instance")
        );
        assert!(!before
            .allowed_tools
            .iter()
            .any(|tool| tool.name == "list_tasks"));

        connection
            .execute(
                "UPDATE roles SET direct_permissions = '[\"tasks.read\"]' WHERE id = 'role-refresh'",
                [],
            )
            .expect("role permissions should update");

        let after = resolve_runtime_authorization_snapshot_for_connection(
            &connection,
            "session-role-refresh",
        )
        .expect("updated snapshot should resolve");
        assert_ne!(before.hash, after.hash);
        assert!(after
            .allowed_tools
            .iter()
            .any(|tool| tool.name == "list_tasks"));
    }

    #[test]
    fn runtime_reuse_decision_respawns_when_authorization_snapshot_changes_and_defers_when_busy() {
        assert_eq!(
            decide_session_runtime_reuse(
                Path::new("/tmp/a"),
                Path::new("/tmp/a"),
                "skill-1",
                "skill-1",
                "auth-1",
                "auth-2",
                false,
            ),
            SessionRuntimeReuseDecision::Respawn {
                cwd_changed: false,
                skills_changed: false,
                auth_tools_changed: true,
            }
        );
        assert_eq!(
            decide_session_runtime_reuse(
                Path::new("/tmp/a"),
                Path::new("/tmp/a"),
                "skill-1",
                "skill-1",
                "auth-1",
                "auth-2",
                true,
            ),
            SessionRuntimeReuseDecision::ReuseUntilIdle {
                cwd_changed: false,
                skills_changed: false,
                auth_tools_changed: true,
            }
        );
        assert_eq!(
            decide_session_runtime_reuse(
                Path::new("/tmp/a"),
                Path::new("/tmp/a"),
                "skill-1",
                "skill-1",
                "auth-1",
                "auth-1",
                false,
            ),
            SessionRuntimeReuseDecision::Reuse
        );
    }

    #[test]
    fn live_runtime_details_include_managed_skill_diagnostics() {
        let app_handle = test_app_handle();
        let runtime = test_runtime(
            &app_handle,
            "session-diagnostics",
            "hash-diagnostics",
            "auth-hash-diagnostics",
            false,
        );
        let details = runtime.runtime_details();
        assert_eq!(
            details
                .managed_skills
                .as_ref()
                .map(|value| value.context_hash.as_str()),
            Some("hash-diagnostics")
        );
        assert_eq!(
            details
                .managed_skills
                .as_ref()
                .map(|value| value.state.as_str()),
            Some("resolved")
        );
    }

    #[test]
    fn build_runtime_pi_args_appends_configured_extensions_after_orchestra_extension() {
        let launch_plan = runtime_skills::ManagedPiSkillLaunchPlan {
            context: runtime_skills::ManagedSkillRuntimeContext {
                session_id: Some("session-1".into()),
                project_id: "orchestra".into(),
                role_id: None,
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
                context_source: "project_session".into(),
            },
            context_hash: "hash-1".into(),
            global_publication_manifest_path: PathBuf::from("/tmp/manifest.json"),
            snapshot: None,
            skill_paths: vec![PathBuf::from("/tmp/skills/000-project-skill")],
            global_skill_slugs: vec!["global-skill".into()],
            scoped_skill_slugs: vec!["project-skill".into()],
            diagnostics: ManagedSkillRuntimeDiagnostics {
                state: "resolved".into(),
                context: crate::models::ManagedSkillRuntimeContextSummary {
                    session_id: Some("session-1".into()),
                    project_id: "orchestra".into(),
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                    context_source: "project_session".into(),
                },
                context_hash: "hash-1".into(),
                ambient_skills: Vec::new(),
                resolved_skills: Vec::new(),
                suppressed_skills: Vec::new(),
                scoped_snapshot: None,
                global_publication_manifest_path: Some("/tmp/manifest.json".into()),
                notes: Vec::new(),
                warnings: Vec::new(),
                error_message: None,
            },
        };
        let args = build_runtime_pi_args(
            Path::new("/tmp/session.jsonl"),
            Path::new("/tmp/sessions"),
            Path::new("/tmp/extensions/orchestra-tools.ts"),
            &[
                "npm:pi-example".to_string(),
                "./extensions/local-extra.ts".to_string(),
            ],
            &launch_plan,
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
                "--skill".to_string(),
                "/tmp/skills/000-project-skill".to_string(),
            ]
        );
    }

    #[test]
    fn reload_rejects_busy_skill_context_change_without_reporting_success() {
        let app_handle = test_app_handle();
        let runtime = test_runtime(&app_handle, "session-1", "old-hash", "auth-hash-1", true);

        let error = perform_session_reload_with_launch_plan(
            Arc::clone(&runtime),
            "manual",
            test_skill_launch_plan("new-hash"),
            "auth-hash-1",
        )
        .expect_err("busy reload should be rejected until idle");

        assert_eq!(error, busy_runtime_context_reload_error());
        assert!(runtime.control_operation().is_none());
        assert_eq!(runtime.control_capability("reload").status, "unknown");
    }

    #[test]
    fn reload_rejects_busy_authorization_snapshot_change_without_reporting_success() {
        let app_handle = test_app_handle();
        let runtime = test_runtime(&app_handle, "session-1", "same-hash", "auth-hash-1", true);

        let error = perform_session_reload_with_launch_plan(
            Arc::clone(&runtime),
            "manual",
            test_skill_launch_plan("same-hash"),
            "auth-hash-2",
        )
        .expect_err("busy reload should be rejected until idle");

        assert_eq!(error, busy_runtime_context_reload_error());
        assert!(runtime.control_operation().is_none());
        assert_eq!(runtime.control_capability("reload").status, "unknown");
    }

    #[test]
    fn auto_compaction_thresholds_trigger_at_expected_headroom() {
        assert!(should_auto_compact_for_usage(200_000, 181_000, "10%")
            .expect("percent threshold should parse"));
        assert!(!should_auto_compact_for_usage(200_000, 170_000, "10%")
            .expect("percent threshold should parse"));
        assert!(should_auto_compact_for_usage(200_000, 184_100, "16000")
            .expect("token threshold should parse"));
        assert!(!should_auto_compact_for_usage(200_000, 180_000, "16000")
            .expect("token threshold should parse"));
    }

    #[test]
    fn disabled_auto_compaction_never_triggers() {
        assert!(!should_auto_compact_for_usage(200_000, 199_500, "off").expect("off should parse"));
    }

    fn make_auto_compaction_stats(
        context_window: i64,
        context_tokens: Option<i64>,
    ) -> SessionStats {
        SessionStats {
            session_id: "session-1".into(),
            session_file: None,
            user_messages: 0,
            assistant_messages: 0,
            tool_calls: 0,
            tool_results: 0,
            total_messages: 0,
            tokens: crate::models::SessionTokenUsage {
                input: 0,
                output: 0,
                cache_read: 0,
                cache_write: 0,
                total: context_tokens.unwrap_or(0),
            },
            cost: 0.0,
            context_usage: Some(crate::models::SessionContextUsage {
                tokens: context_tokens,
                context_window,
                percent: None,
            }),
        }
    }

    #[test]
    fn auto_compaction_evaluation_triggers_when_threshold_is_crossed() {
        let evaluation = evaluate_auto_compaction(
            &make_auto_compaction_stats(200_000, Some(181_000)),
            "10%",
            None,
        )
        .expect("evaluation should succeed");

        assert_eq!(evaluation.capability_status, "supported");
        assert_eq!(evaluation.capability_reason, None);
        assert!(evaluation.trigger);
        assert_eq!(evaluation.context_tokens, Some(181_000));
        assert!(!evaluation.reset_last_context_tokens);
    }

    #[test]
    fn auto_compaction_evaluation_marks_context_usage_unavailable_when_tokens_are_missing() {
        let evaluation =
            evaluate_auto_compaction(&make_auto_compaction_stats(200_000, None), "10%", None)
                .expect("evaluation should succeed");

        assert_eq!(evaluation.capability_status, "unsupported");
        assert_eq!(
            evaluation.capability_reason.as_deref(),
            Some("context_usage_unavailable")
        );
        assert!(!evaluation.trigger);
        assert_eq!(evaluation.context_tokens, None);
        assert!(!evaluation.reset_last_context_tokens);
    }

    #[test]
    fn auto_compaction_evaluation_skips_duplicate_threshold_crossings() {
        let evaluation = evaluate_auto_compaction(
            &make_auto_compaction_stats(200_000, Some(181_000)),
            "10%",
            Some(181_000),
        )
        .expect("evaluation should succeed");

        assert_eq!(evaluation.capability_status, "supported");
        assert_eq!(evaluation.capability_reason, None);
        assert!(!evaluation.trigger);
        assert_eq!(evaluation.context_tokens, None);
        assert!(!evaluation.reset_last_context_tokens);
    }

    #[test]
    fn auto_compaction_evaluation_resets_duplicate_guard_after_headroom_recovers() {
        let evaluation = evaluate_auto_compaction(
            &make_auto_compaction_stats(200_000, Some(170_000)),
            "10%",
            Some(181_000),
        )
        .expect("evaluation should succeed");

        assert_eq!(evaluation.capability_status, "supported");
        assert_eq!(evaluation.capability_reason, None);
        assert!(!evaluation.trigger);
        assert_eq!(evaluation.context_tokens, None);
        assert!(evaluation.reset_last_context_tokens);
    }

    #[test]
    fn queued_deliveries_promote_in_priority_order_after_agent_end() {
        let app_handle = test_app_handle();
        let runtime = test_runtime(
            &app_handle,
            "session-queued-promotion",
            "hash-queued-promotion",
            "auth-hash-queued-promotion",
            true,
        );

        runtime
            .queue_delivery(QueuedDelivery {
                run_id: "run-follow-up".into(),
                delivery_type: "follow_up".into(),
                message: "follow-up".into(),
                accepted_at: Instant::now(),
            })
            .expect("follow-up should queue");
        runtime
            .queue_delivery(QueuedDelivery {
                run_id: "run-steer".into(),
                delivery_type: "steer".into(),
                message: "steer".into(),
                accepted_at: Instant::now(),
            })
            .expect("steer should queue");

        runtime.handle_payload(json!({ "type": "agent_end" }));
        assert_eq!(runtime.current_run_id(), Some("run-steer".into()));
        assert_eq!(runtime.current_prompt_message(), Some("steer".into()));

        runtime.handle_payload(json!({ "type": "agent_end" }));
        assert_eq!(runtime.current_run_id(), Some("run-follow-up".into()));
        assert_eq!(runtime.current_prompt_message(), Some("follow-up".into()));
    }

    #[test]
    fn promoted_queued_delivery_reclaims_active_session_run_tracking() {
        let app_handle = test_app_handle();
        let state = app_handle.state::<crate::state::AppState>();
        let runtime = test_runtime(
            &app_handle,
            "session-promoted-run-tracking",
            "hash-promoted-run-tracking",
            "auth-hash-promoted-run-tracking",
            true,
        );

        state
            .begin_session_run("session-promoted-run-tracking", "run-1")
            .expect("initial active run should register");
        runtime
            .queue_delivery(QueuedDelivery {
                run_id: "run-queued".into(),
                delivery_type: "follow_up".into(),
                message: "queued".into(),
                accepted_at: Instant::now(),
            })
            .expect("delivery should queue");

        runtime.handle_payload(json!({ "type": "agent_end" }));

        assert_eq!(runtime.current_run_id(), Some("run-queued".into()));
        assert_eq!(runtime.current_prompt_message(), Some("queued".into()));
        assert_eq!(
            state
                .active_session_run_id("session-promoted-run-tracking")
                .expect("active session run should resolve"),
            Some("run-queued".into())
        );
    }

    #[test]
    fn active_delivery_timeout_clears_run_tracking_and_prompt_state() {
        let app_handle = test_app_handle();
        let state = app_handle.state::<crate::state::AppState>();
        let runtime = test_runtime(
            &app_handle,
            "session-active-timeout",
            "hash-active-timeout",
            "auth-hash-active-timeout",
            false,
        );
        let accepted_at = Instant::now();

        state
            .begin_session_run("session-active-timeout", "run-timeout")
            .expect("active run should register");
        runtime
            .activate_delivery("run-timeout", "prompt", "stale prompt", accepted_at)
            .expect("prompt should activate");

        assert!(runtime.handle_active_delivery_timeout("run-timeout", accepted_at));
        assert_eq!(runtime.current_run_id(), None);
        assert_eq!(runtime.current_prompt_message(), None);
        assert_eq!(
            state
                .active_session_run_id("session-active-timeout")
                .expect("active session run should resolve"),
            None
        );
    }

    #[test]
    fn active_delivery_timeout_ignores_runs_after_activity_starts() {
        let app_handle = test_app_handle();
        let runtime = test_runtime(
            &app_handle,
            "session-active-timeout-started",
            "hash-active-timeout-started",
            "auth-hash-active-timeout-started",
            false,
        );
        let accepted_at = Instant::now();

        runtime
            .activate_delivery("run-started", "prompt", "started prompt", accepted_at)
            .expect("prompt should activate");
        runtime.mark_active_delivery_started();

        assert!(!runtime.handle_active_delivery_timeout("run-started", accepted_at));
        assert_eq!(runtime.current_run_id(), Some("run-started".into()));
        assert_eq!(
            runtime.current_prompt_message(),
            Some("started prompt".into())
        );
    }

    #[test]
    fn has_active_prompt_stays_true_while_queued_deliveries_remain() {
        let app_handle = test_app_handle();
        let runtime = test_runtime(
            &app_handle,
            "session-queued-busy",
            "hash-queued-busy",
            "auth-hash-queued-busy",
            false,
        );

        assert!(!runtime.has_active_prompt());
        runtime
            .queue_delivery(QueuedDelivery {
                run_id: "run-queued".into(),
                delivery_type: "follow_up".into(),
                message: "queued".into(),
                accepted_at: Instant::now(),
            })
            .expect("delivery should queue");

        assert!(runtime.has_active_prompt());
    }
}

fn extract_rpc_error_message(payload: &Value) -> Option<String> {
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
}

fn extract_rpc_error(payload: &Value) -> String {
    extract_rpc_error_message(payload).unwrap_or_else(|| "pi reported an RPC error".into())
}
