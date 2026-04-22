use std::{
    env, fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{Arc, Mutex, OnceLock},
    thread,
};

use chrono::Utc;
use serde::Deserialize;
use serde_json::json;
use tauri::{AppHandle, Manager};

use crate::{
    models::{PiOAuthFlowState, PiOAuthPromptState},
    services::{
        app_events,
        orchestra_paths::{default_orchestra_root, pi_agent_dir, pi_runtime_root},
        pi_sessions, pi_setup,
    },
    state::AppState,
};

const OAUTH_HELPER_SCRIPT: &str = include_str!("../../scripts/pi_oauth_helper.mjs");

struct PiOAuthFlowHandle {
    id: String,
    state: Arc<Mutex<PiOAuthFlowState>>,
    stdin: Mutex<Option<ChildStdin>>,
    child: Mutex<Child>,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum HelperEvent {
    Auth {
        url: String,
        instructions: Option<String>,
    },
    Prompt {
        kind: String,
        message: String,
        placeholder: Option<String>,
        allow_empty: bool,
    },
    Progress {
        message: String,
    },
    Success,
    Cancelled {
        message: Option<String>,
    },
    Error {
        message: String,
    },
}

static ACTIVE_FLOW: OnceLock<Mutex<Option<Arc<PiOAuthFlowHandle>>>> = OnceLock::new();

fn flow_slot() -> &'static Mutex<Option<Arc<PiOAuthFlowHandle>>> {
    ACTIVE_FLOW.get_or_init(|| Mutex::new(None))
}

fn is_current_flow(flow_id: &str) -> bool {
    flow_slot()
        .lock()
        .ok()
        .and_then(|guard| guard.as_ref().map(|handle| handle.id == flow_id))
        .unwrap_or(false)
}

fn clone_flow_state(handle: &Arc<PiOAuthFlowHandle>) -> Result<PiOAuthFlowState, String> {
    handle
        .state
        .lock()
        .map_err(|_| "Unable to access Pi OAuth flow state".to_string())
        .map(|state| state.clone())
}

fn emit_flow_state(app: &AppHandle, state: &PiOAuthFlowState) {
    let _ = app_events::emit_window_event(app, "orchestra:pi-oauth-flow-change", state);
}

fn update_flow_state<F>(
    app: &AppHandle,
    handle: &Arc<PiOAuthFlowHandle>,
    updater: F,
) -> Result<PiOAuthFlowState, String>
where
    F: FnOnce(&mut PiOAuthFlowState),
{
    let next_state = {
        let mut state = handle
            .state
            .lock()
            .map_err(|_| "Unable to access Pi OAuth flow state".to_string())?;
        updater(&mut state);
        state.clone()
    };
    if is_current_flow(&handle.id) {
        emit_flow_state(app, &next_state);
    }
    Ok(next_state)
}

fn helper_script_path() -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let helper_dir = pi_runtime_root(&orchestra_root).join("helpers");
    fs::create_dir_all(&helper_dir).map_err(|error| {
        format!(
            "Unable to create Pi OAuth helper directory {}: {error}",
            helper_dir.display()
        )
    })?;
    let helper_path = helper_dir.join("pi_oauth_helper.mjs");
    let should_write = match fs::read_to_string(&helper_path) {
        Ok(existing) => existing != OAUTH_HELPER_SCRIPT,
        Err(_) => true,
    };
    if should_write {
        fs::write(&helper_path, OAUTH_HELPER_SCRIPT).map_err(|error| {
            format!(
                "Unable to write Pi OAuth helper {}: {error}",
                helper_path.display()
            )
        })?;
    }
    Ok(helper_path)
}

fn resolve_command_in_path(command: &str) -> Option<PathBuf> {
    let candidate = PathBuf::from(command);
    if candidate.components().count() > 1 {
        return candidate.exists().then_some(candidate);
    }

    let path_value = env::var_os("PATH")?;
    for directory in env::split_paths(&path_value) {
        let direct = directory.join(command);
        if direct.exists() {
            return Some(direct);
        }
        #[cfg(target_os = "windows")]
        {
            for extension in ["exe", "cmd", "bat"] {
                let with_extension = directory.join(format!("{}.{}", command, extension));
                if with_extension.exists() {
                    return Some(with_extension);
                }
            }
        }
    }
    None
}

fn resolve_js_runtime() -> Result<PathBuf, String> {
    if let Ok(configured) = env::var("ORCHESTRA_NODE_EXECUTABLE") {
        if let Some(path) = resolve_command_in_path(&configured) {
            return Ok(path);
        }
    }

    for candidate in ["node", "bun"] {
        if let Some(path) = resolve_command_in_path(candidate) {
            return Ok(path);
        }
    }

    Err(
        "Unable to locate a JavaScript runtime for Orchestra-started Pi OAuth flows. Install Node.js (or Bun) or set ORCHESTRA_NODE_EXECUTABLE to the runtime path."
            .into(),
    )
}

fn resolve_pi_package_dir(pi_executable: &Path) -> Result<PathBuf, String> {
    if let Ok(configured) = env::var("ORCHESTRA_PI_PACKAGE_DIR") {
        let path = PathBuf::from(configured);
        if path.exists() {
            return Ok(path);
        }
    }

    let canonical = fs::canonicalize(pi_executable).unwrap_or_else(|_| pi_executable.to_path_buf());
    for ancestor in canonical.ancestors() {
        if ancestor.join("package.json").exists()
            && ancestor.join("dist").join("core").join("auth-storage.js").exists()
        {
            return Ok(ancestor.to_path_buf());
        }
    }

    Err(format!(
        "Unable to derive the Pi package directory from {}. Set ORCHESTRA_PI_PACKAGE_DIR to the installed @mariozechner/pi-coding-agent package root.",
        canonical.display()
    ))
}

fn open_external_url(url: &str) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("cmd")
            .arg("/C")
            .arg("start")
            .arg("")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Unable to open {} in the default browser: {error}", url))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Unable to open {} in the default browser: {error}", url))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(url)
            .spawn()
            .map_err(|error| format!("Unable to open {} in the default browser: {error}", url))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(format!(
        "Opening browser URLs is not supported on this platform for {}",
        url
    ))
}

fn send_helper_message(handle: &Arc<PiOAuthFlowHandle>, payload: &serde_json::Value) -> Result<(), String> {
    let serialized = serde_json::to_string(payload)
        .map_err(|error| format!("Unable to serialize Pi OAuth helper message: {error}"))?;
    let mut stdin_guard = handle
        .stdin
        .lock()
        .map_err(|_| "Unable to access Pi OAuth helper stdin".to_string())?;
    let stdin = stdin_guard
        .as_mut()
        .ok_or_else(|| "Pi OAuth flow is no longer accepting input.".to_string())?;
    writeln!(stdin, "{serialized}")
        .map_err(|error| format!("Unable to write Pi OAuth helper input: {error}"))?;
    stdin.flush()
        .map_err(|error| format!("Unable to flush Pi OAuth helper input: {error}"))
}

fn kill_child_process(handle: &Arc<PiOAuthFlowHandle>) {
    if let Ok(mut child) = handle.child.lock() {
        let _ = child.kill();
    }
}

fn finalize_success(app: &AppHandle, handle: &Arc<PiOAuthFlowHandle>) {
    let _ = update_flow_state(app, handle, |state| {
        state.status = "succeeded".into();
        state.prompt = None;
        state.error = None;
        state.finished_at = Some(Utc::now().to_rfc3339());
    });
    let _ = app_events::emit_window_event(
        app,
        "orchestra:pi-setup-change",
        &json!({ "reason": "pi.oauth.succeeded" }),
    );
    app.state::<AppState>().log(
        "info",
        "pi.oauth",
        &format!(
            "Completed Orchestra-managed Pi OAuth flow for provider {}",
            clone_flow_state(handle)
                .map(|state| state.provider_id)
                .unwrap_or_else(|_| "unknown".into())
        ),
    );
}

fn finalize_failure(
    app: &AppHandle,
    handle: &Arc<PiOAuthFlowHandle>,
    status: &str,
    message: String,
) {
    let _ = update_flow_state(app, handle, |state| {
        if state.finished_at.is_some() && state.status == "succeeded" {
            return;
        }
        state.status = status.into();
        state.prompt = None;
        state.error = Some(message.clone());
        state.finished_at = Some(Utc::now().to_rfc3339());
    });
    app.state::<AppState>().log(
        if status == "cancelled" { "info" } else { "warn" },
        "pi.oauth",
        &message,
    );
}

fn process_helper_event(app: &AppHandle, handle: &Arc<PiOAuthFlowHandle>, event: HelperEvent) {
    match event {
        HelperEvent::Auth { url, instructions } => {
            let open_result = open_external_url(&url);
            let _ = update_flow_state(app, handle, |state| {
                state.status = "running".into();
                state.auth_url = Some(url.clone());
                state.auth_instructions = instructions.clone();
                state.prompt = None;
                state.browser_opened = open_result.is_ok();
                state.browser_open_error = open_result.err();
            });
        }
        HelperEvent::Prompt {
            kind,
            message,
            placeholder,
            allow_empty,
        } => {
            let _ = update_flow_state(app, handle, |state| {
                state.status = "awaiting_input".into();
                state.prompt = Some(PiOAuthPromptState {
                    kind,
                    message,
                    placeholder,
                    allow_empty,
                });
            });
        }
        HelperEvent::Progress { message } => {
            let _ = update_flow_state(app, handle, |state| {
                if state.prompt.is_none() {
                    state.status = "running".into();
                }
                state.latest_progress_message = Some(message);
            });
        }
        HelperEvent::Success => finalize_success(app, handle),
        HelperEvent::Cancelled { message } => finalize_failure(
            app,
            handle,
            "cancelled",
            message.unwrap_or_else(|| "Login cancelled".into()),
        ),
        HelperEvent::Error { message } => finalize_failure(app, handle, "failed", message),
    }
}

fn watch_helper_stdout(app: AppHandle, handle: Arc<PiOAuthFlowHandle>, stdout: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stdout);
        for line_result in reader.lines() {
            if !is_current_flow(&handle.id) {
                break;
            }
            match line_result {
                Ok(line) => match serde_json::from_str::<HelperEvent>(&line) {
                    Ok(event) => process_helper_event(&app, &handle, event),
                    Err(error) => app.state::<AppState>().log(
                        "warn",
                        "pi.oauth.parse",
                        &format!("Unable to parse Pi OAuth helper event: {error}; line={line}"),
                    ),
                },
                Err(error) => {
                    finalize_failure(
                        &app,
                        &handle,
                        "failed",
                        format!("Unable to read Pi OAuth helper output: {error}"),
                    );
                    break;
                }
            }
        }

        if !is_current_flow(&handle.id) {
            if let Ok(mut child) = handle.child.lock() {
                let _ = child.wait();
            }
            return;
        }

        let wait_result = handle
            .child
            .lock()
            .map_err(|_| "Unable to access Pi OAuth child process".to_string())
            .and_then(|mut child| {
                child
                    .wait()
                    .map_err(|error| format!("Unable to wait for Pi OAuth helper process: {error}"))
            });

        let current_state = clone_flow_state(&handle).ok();
        let already_finished = current_state
            .as_ref()
            .map(|state| state.finished_at.is_some())
            .unwrap_or(false);
        if already_finished {
            return;
        }

        match wait_result {
            Ok(status) if status.success() => finalize_success(&app, &handle),
            Ok(status) => finalize_failure(
                &app,
                &handle,
                "failed",
                format!(
                    "The Pi OAuth helper exited before login completed (status {}).",
                    status
                ),
            ),
            Err(error) => finalize_failure(&app, &handle, "failed", error),
        }
    });
}

fn watch_helper_stderr(app: AppHandle, handle: Arc<PiOAuthFlowHandle>, stderr: impl std::io::Read + Send + 'static) {
    thread::spawn(move || {
        let reader = BufReader::new(stderr);
        for line in reader.lines().map_while(Result::ok) {
            if !is_current_flow(&handle.id) {
                break;
            }
            app.state::<AppState>().log("debug", "pi.oauth.stderr", &line);
        }
    });
}

fn current_flow_handle() -> Result<Option<Arc<PiOAuthFlowHandle>>, String> {
    flow_slot()
        .lock()
        .map_err(|_| "Unable to access Pi OAuth flow slot".to_string())
        .map(|guard| guard.as_ref().cloned())
}

pub fn get_flow_state() -> Result<Option<PiOAuthFlowState>, String> {
    current_flow_handle()?.map(|handle| clone_flow_state(&handle)).transpose()
}

pub fn start_flow(app: AppHandle, provider_id: &str) -> Result<PiOAuthFlowState, String> {
    if let Some(existing) = current_flow_handle()? {
        let existing_state = clone_flow_state(&existing)?;
        if existing_state.finished_at.is_none() {
            let _ = send_helper_message(&existing, &json!({ "type": "cancel" }));
            kill_child_process(&existing);
        }
    }

    let setup_state = pi_setup::get_pi_setup_state()?;
    let provider = setup_state
        .available_providers
        .into_iter()
        .find(|provider| provider.id == provider_id)
        .ok_or_else(|| format!("Unknown Pi provider {}.", provider_id))?;
    if !provider.auth_modes.iter().any(|mode| mode == "oauth") {
        return Err(format!(
            "Provider {} does not support an Orchestra-managed OAuth flow.",
            provider.name
        ));
    }

    let pi_executable = pi_sessions::resolve_pi_executable(None)?;
    let pi_package_dir = resolve_pi_package_dir(&pi_executable)?;
    let js_runtime = resolve_js_runtime()?;
    let orchestra_root = default_orchestra_root()?;
    let helper_path = helper_script_path()?;
    let agent_dir = pi_agent_dir(&orchestra_root);

    fs::create_dir_all(&agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra-managed Pi agent directory {}: {error}",
            agent_dir.display()
        )
    })?;

    let mut command = Command::new(&js_runtime);
    command
        .arg(&helper_path)
        .arg("--package-dir")
        .arg(&pi_package_dir)
        .arg("--provider-id")
        .arg(provider_id)
        .env("PI_CODING_AGENT_DIR", agent_dir.display().to_string())
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());

    let mut child = command.spawn().map_err(|error| {
        format!(
            "Unable to start Orchestra-managed Pi OAuth flow with {}: {error}",
            js_runtime.display()
        )
    })?;

    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to capture Pi OAuth helper stdout".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to capture Pi OAuth helper stderr".to_string())?;
    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Unable to capture Pi OAuth helper stdin".to_string())?;

    let flow_handle = Arc::new(PiOAuthFlowHandle {
        id: format!("pi-oauth-{}", Utc::now().timestamp_micros()),
        state: Arc::new(Mutex::new(PiOAuthFlowState {
            provider_id: provider.id.clone(),
            provider_name: provider.name.clone(),
            uses_callback_server: provider.uses_callback_server,
            status: "running".into(),
            auth_url: None,
            auth_instructions: None,
            browser_opened: false,
            browser_open_error: None,
            prompt: None,
            latest_progress_message: Some(format!("Starting {} sign-in…", provider.name)),
            error: None,
            started_at: Utc::now().to_rfc3339(),
            finished_at: None,
        })),
        stdin: Mutex::new(Some(stdin)),
        child: Mutex::new(child),
    });

    {
        let mut slot = flow_slot()
            .lock()
            .map_err(|_| "Unable to access Pi OAuth flow slot".to_string())?;
        *slot = Some(flow_handle.clone());
    }

    emit_flow_state(&app, &clone_flow_state(&flow_handle)?);
    app.state::<AppState>().log(
        "info",
        "pi.oauth",
        &format!(
            "Started Orchestra-managed Pi OAuth flow for provider {} using {} and package {}",
            provider.id,
            js_runtime.display(),
            pi_package_dir.display()
        ),
    );

    watch_helper_stdout(app.clone(), flow_handle.clone(), stdout);
    watch_helper_stderr(app, flow_handle.clone(), stderr);

    clone_flow_state(&flow_handle)
}

pub fn submit_flow_input(app: AppHandle, value: &str) -> Result<PiOAuthFlowState, String> {
    let handle = current_flow_handle()?
        .ok_or_else(|| "No active Pi OAuth flow is waiting for input.".to_string())?;
    let prompt = clone_flow_state(&handle)?
        .prompt
        .ok_or_else(|| "The current Pi OAuth flow is not waiting for input.".to_string())?;
    let trimmed = value.trim();
    if !prompt.allow_empty && trimmed.is_empty() {
        return Err("A value is required before continuing the Pi OAuth flow.".into());
    }

    send_helper_message(&handle, &json!({ "type": "input", "value": value }))?;
    update_flow_state(&app, &handle, |state| {
        state.status = "running".into();
        state.prompt = None;
        state.error = None;
    })
}

pub fn cancel_flow(app: AppHandle) -> Result<Option<PiOAuthFlowState>, String> {
    let Some(handle) = current_flow_handle()? else {
        return Ok(None);
    };

    let next_state = update_flow_state(&app, &handle, |state| {
        if state.finished_at.is_none() {
            state.status = "cancelled".into();
            state.prompt = None;
            state.error = Some("Login cancelled".into());
            state.finished_at = Some(Utc::now().to_rfc3339());
        }
    })?;
    let _ = send_helper_message(&handle, &json!({ "type": "cancel" }));
    kill_child_process(&handle);
    Ok(Some(next_state))
}
