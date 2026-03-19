use std::{
    collections::HashMap,
    io::{BufRead, BufReader, Read, Write},
    path::PathBuf,
    process::{Child, ChildStderr, ChildStdin, ChildStdout, Command, Stdio},
    sync::{mpsc, Arc, Mutex},
    thread,
    time::Duration,
};

use serde_json::{json, Value};
use tauri::{AppHandle, Emitter, Manager};
use uuid::Uuid;

use crate::{
    models::{SessionModel, SessionModelState, SessionStreamEvent},
    services::pi_sessions::{get_session, get_session_path},
};

const RPC_RESPONSE_TIMEOUT: Duration = Duration::from_secs(30);

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
        let mut child = Command::new("pi")
            .arg("--mode")
            .arg("rpc")
            .arg("--session")
            .arg(&session_path)
            .arg("--session-dir")
            .arg(&session_dir)
            .arg("--no-extensions")
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
            &format!("Spawning live pi RPC runtime for session {}", session_id),
        );

        let runtime = Arc::new(Self {
            session_id,
            session_dir,
            session_path,
            stdin: Mutex::new(Some(stdin)),
            child: Mutex::new(Some(child)),
            pending: Mutex::new(HashMap::new()),
            subscribed: Mutex::new(true),
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
                                runtime.emit_error_for_active_run(format!("Unable to parse pi RPC output: {error}"));
                            }
                        }
                    }
                    Err(error) => {
                        runtime.handle_process_end(format!("Unable to read pi RPC output: {error}"));
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
                runtime.app.state::<crate::state::AppState>().log("warn", "sessions.rpc.stderr", buffer.trim());
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
                            &format!("Session {} received response {} success={}", self.session_id, id, success),
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

        match payload.get("type").and_then(Value::as_str) {
            Some("message_update") => self.handle_message_update(&payload),
            Some("turn_end") => {
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.rpc.lifecycle",
                    &format!("Session {} received turn_end", self.session_id),
                );
            }
            Some("agent_end") => {
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.rpc.lifecycle",
                    &format!("Session {} received agent_end", self.session_id),
                );
                self.handle_agent_end()
            }
            Some("response") => {
                self.app.state::<crate::state::AppState>().log(
                    "debug",
                    "sessions.rpc.response",
                    &format!(
                        "Session {} received response {} success={} ",
                        self.session_id,
                        payload.get("id").and_then(Value::as_str).unwrap_or("(no id)"),
                        payload.get("success").and_then(Value::as_bool).unwrap_or(false)
                    ),
                );
            }
            _ => {}
        }
    }

    fn handle_message_update(&self, payload: &Value) {
        let Some(run_id) = self.current_run_id() else {
            return;
        };

        let Some(event_type) = payload.pointer("/assistantMessageEvent/type").and_then(Value::as_str) else {
            return;
        };

        if matches!(event_type, "text_start" | "text_delta" | "thinking_start" | "thinking_delta" | "error") {
            self.app.state::<crate::state::AppState>().log(
                "info",
                "sessions.rpc.message_update",
                &format!("Session {} message_update {}", self.session_id, event_type),
            );
        }

        match event_type {
            "done" => {
                self.app.state::<crate::state::AppState>().log(
                    "info",
                    "sessions.rpc.message_update",
                    &format!("Session {} message_update done", self.session_id),
                );
            }
            "text_start" | "thinking_start" => {
                if self.is_subscribed() {
                    self.app.state::<crate::state::AppState>().log(
                        "info",
                        "sessions.rpc.emit",
                        &format!("Session {} emitting assistantStart", self.session_id),
                    );
                    self.emit_stream_event(SessionStreamEvent {
                        session_id: self.session_id.clone(),
                        run_id,
                        event: "assistantStart".into(),
                        timestamp: Some(crate::state::now_iso()),
                        delta: None,
                        message: None,
                        record: None,
                    });
                }
            }
            "text_delta" => {
                if self.is_subscribed() {
                    self.app.state::<crate::state::AppState>().log(
                        "info",
                        "sessions.rpc.emit",
                        &format!("Session {} emitting assistantDelta", self.session_id),
                    );
                    self.emit_stream_event(SessionStreamEvent {
                        session_id: self.session_id.clone(),
                        run_id,
                        event: "assistantDelta".into(),
                        timestamp: None,
                        delta: payload
                            .pointer("/assistantMessageEvent/delta")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                        message: None,
                        record: None,
                    });
                }
            }
            "thinking_delta" => {
                if self.is_subscribed() {
                    self.app.state::<crate::state::AppState>().log(
                        "info",
                        "sessions.rpc.emit",
                        &format!("Session {} emitting assistantDelta(thinking)", self.session_id),
                    );
                    self.emit_stream_event(SessionStreamEvent {
                        session_id: self.session_id.clone(),
                        run_id,
                        event: "assistantDelta".into(),
                        timestamp: None,
                        delta: payload
                            .pointer("/assistantMessageEvent/delta")
                            .and_then(Value::as_str)
                            .map(|value| format!("{value}")),
                        message: None,
                        record: None,
                    });
                }
            }
            "error" => {
                self.emit_error_for_active_run(extract_rpc_error(payload));
            }
            _ => {}
        }
    }

    fn handle_agent_end(&self) {
        let Some(run_id) = self.take_current_run_id() else {
            self.close_if_idle();
            return;
        };

        let _ = self
            .app
            .state::<crate::state::AppState>()
            .end_session_run(&self.session_id, &run_id);

        if self.is_subscribed() {
            match get_session(&self.session_dir, &self.session_id, true) {
                Ok(record) => {
                    self.app.state::<crate::state::AppState>().log(
                        "info",
                        "sessions.runtime.complete",
                        &format!("Session {} emitting sessionUpdated for run {}", self.session_id, run_id),
                    );
                    self.emit_stream_event(SessionStreamEvent {
                        session_id: self.session_id.clone(),
                        run_id,
                        event: "sessionUpdated".into(),
                        timestamp: None,
                        delta: None,
                        message: None,
                        record: Some(record),
                    });
                }
                Err(error) => self.emit_stream_event(SessionStreamEvent {
                    session_id: self.session_id.clone(),
                    run_id,
                    event: "error".into(),
                    timestamp: None,
                    delta: None,
                    message: Some(error),
                    record: None,
                }),
            }
        }

        self.close_if_idle();
    }

    fn handle_process_end(&self, message: impl Into<String>) {
        self.mark_closed();
        let error_message = message.into();
        if let Ok(mut pending) = self.pending.lock() {
            for (_, sender) in pending.drain() {
                let _ = sender.send(Err(error_message.clone()));
            }
        }
        self.emit_error_for_active_run(error_message);
    }

    fn emit_error_for_active_run(&self, message: String) {
        if let Some(run_id) = self.take_current_run_id() {
            let _ = self
                .app
                .state::<crate::state::AppState>()
                .end_session_run(&self.session_id, &run_id);

            if self.is_subscribed() {
                self.emit_stream_event(SessionStreamEvent {
                    session_id: self.session_id.clone(),
                    run_id,
                    event: "error".into(),
                    timestamp: None,
                    delta: None,
                    message: Some(message),
                    record: None,
                });
            }
        }

        self.close_if_idle();
    }

    fn emit_stream_event(&self, payload: SessionStreamEvent) {
        let _ = self.app.emit("session-stream", payload);
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
            writeln!(stdin, "{command}").map_err(|error| format!("Unable to send command to pi RPC process: {error}"))?;
            stdin
                .flush()
                .map_err(|error| format!("Unable to flush pi RPC stdin: {error}"))?;
            Ok(())
        })();

        if let Err(error) = write_result {
            let _ = self.pending.lock().map(|mut pending| pending.remove(&request_id));
            self.app.state::<crate::state::AppState>().log(
                "error",
                "sessions.rpc.send",
                &format!("Session {} failed to send command {}: {}", self.session_id, request_id, error),
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

    pub fn start_run(&self, run_id: &str, message: &str) -> Result<(), String> {
        self.app.state::<crate::state::AppState>().log(
            "info",
            "sessions.runtime.start_run",
            &format!("Session {} starting run {} with {} chars", self.session_id, run_id, message.len()),
        );
        {
            let mut current_run_id = self
                .current_run_id
                .lock()
                .map_err(|_| "Unable to access current session run state".to_string())?;
            if current_run_id.is_some() {
                return Err("This session is already processing a message".into());
            }
            *current_run_id = Some(run_id.to_string());
        }

        let result = self.send_command(json!({
            "id": format!("prompt-{run_id}"),
            "type": "prompt",
            "message": message,
        }));

        if let Err(error) = result {
            let _ = self.take_current_run_id();
            return Err(error);
        }

        Ok(())
    }

    pub fn get_model_state(&self) -> Result<SessionModelState, String> {
        let state = self.send_command(json!({ "id": format!("state-{}", Uuid::new_v4()), "type": "get_state" }))?;
        let models = self.send_command(json!({
            "id": format!("models-{}", Uuid::new_v4()),
            "type": "get_available_models"
        }))?;

        Ok(SessionModelState {
            session_id: self.session_id.clone(),
            current_model: state.pointer("/data/model").and_then(parse_model_summary),
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
        self.current_run_id.lock().ok().and_then(|value| value.clone())
    }

    fn take_current_run_id(&self) -> Option<String> {
        self.current_run_id.lock().ok().and_then(|mut value| value.take())
    }

    fn close_if_idle(&self) {
        if self.is_subscribed() || self.current_run_id().is_some() || self.is_closed() {
            return;
        }

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

    fn is_closed(&self) -> bool {
        self.closed.lock().map(|value| *value).unwrap_or(true)
    }

    fn mark_closed(&self) {
        if let Ok(mut closed) = self.closed.lock() {
            *closed = true;
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
                existing.set_subscribed(true);
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
        reasoning: value.get("reasoning").and_then(Value::as_bool).unwrap_or(false),
    })
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
