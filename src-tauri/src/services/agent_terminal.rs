use std::{
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
    thread,
    time::Duration,
};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

const TERMINAL_BOOTSTRAP_TEXT: &str = "[Orchestra embedded terminal attached]\r\n";

pub struct AgentTerminalSession {
    session_id: String,
    window_label: Mutex<String>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    buffer: Mutex<String>,
    temp_home_dir: Option<PathBuf>,
    app: AppHandle,
}

impl AgentTerminalSession {
    pub fn spawn(
        app: AppHandle,
        session_id: &str,
        session_path: &Path,
        session_dir: &Path,
        runtime_cwd: &Path,
        window_label: &str,
    ) -> Result<Arc<Self>, String> {
        let pty_system = native_pty_system();
        let pair = pty_system
            .openpty(PtySize {
                rows: 36,
                cols: 120,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Unable to create terminal PTY: {error}"))?;

        let runtime = crate::services::pi_runtime::resolve_pi_runtime(None)?;
        let pi_executable = runtime.executable_path.clone();
        let temp_home_dir = prepare_terminal_home_dir(session_id, &pi_executable)?;
        let orchestra_extension_path =
            crate::services::live_sessions::resolve_orchestra_extension_path(&app)?;
        let extra_extensions = crate::services::harness_settings::resolve_spawn_extra_extensions(
            crate::services::harness_settings::get_pi_runtime_settings()?.extra_extensions,
        )?;
        let skill_launch_plan =
            crate::services::runtime_skills::resolve_managed_pi_skill_launch_plan(session_id)?;

        let mut command = CommandBuilder::new(&pi_executable);
        command.cwd(runtime_cwd);
        command.arg("--session");
        command.arg(session_path.to_string_lossy().to_string());
        command.arg("--session-dir");
        command.arg(session_dir.to_string_lossy().to_string());
        let mut launch_args = Vec::new();
        crate::services::runtime_skills::append_managed_pi_extension_and_skill_args(
            &mut launch_args,
            &orchestra_extension_path,
            &extra_extensions,
            &skill_launch_plan,
        );
        for arg in &launch_args {
            command.arg(arg);
        }
        command.env("TERM", "xterm-256color");
        command.env("COLORTERM", "truecolor");
        command.env(
            "PI_CODING_AGENT_DIR",
            crate::services::pi_sessions::orchestra_pi_agent_dir_display()?,
        );
        if let Some(environment) = crate::services::pi_sessions::resolve_user_shell_environment() {
            for (key, value) in environment {
                command.env(key, value);
            }
        }
        if let Some(temp_home_dir) = temp_home_dir.as_ref() {
            command.env("HOME", temp_home_dir);
            if let Some(prefix) = infer_npm_prefix(&pi_executable, temp_home_dir) {
                command.env("NPM_CONFIG_PREFIX", prefix.to_string_lossy().to_string());
                command.env("npm_config_prefix", prefix.to_string_lossy().to_string());
            }
        }
        if runtime.source == "bundled" {
            if let Some(package_dir) = runtime.package_dir.as_ref() {
                command.env("PI_PACKAGE_DIR", package_dir);
            }
        }
        if runtime.bundled_bun_path.is_some() {
            if let Some(path_value) =
                crate::services::pi_runtime::resolve_effective_subprocess_path(Some(&runtime))
            {
                command.env("PATH", path_value);
            }
        }

        let child = pair
            .slave
            .spawn_command(command)
            .map_err(|error| format!("Unable to spawn terminal pi session: {error}"))?;
        let reader = pair
            .master
            .try_clone_reader()
            .map_err(|error| format!("Unable to clone terminal PTY reader: {error}"))?;
        let writer = pair
            .master
            .take_writer()
            .map_err(|error| format!("Unable to take terminal PTY writer: {error}"))?;

        let session = Arc::new(Self {
            session_id: session_id.to_string(),
            window_label: Mutex::new(window_label.to_string()),
            writer: Mutex::new(writer),
            master: Mutex::new(pair.master),
            child: Mutex::new(child),
            buffer: Mutex::new(TERMINAL_BOOTSTRAP_TEXT.to_string()),
            temp_home_dir,
            app: app.clone(),
        });

        let session_for_reader = Arc::clone(&session);
        thread::spawn(move || {
            session_for_reader.read_loop(reader);
        });

        let session_for_bootstrap = Arc::clone(&session);
        thread::spawn(move || {
            thread::sleep(Duration::from_millis(300));
            let _ = session_for_bootstrap.write_input("\r");
        });

        Ok(session)
    }

    pub fn set_window_label(&self, window_label: &str) {
        if let Ok(mut current) = self.window_label.lock() {
            *current = window_label.to_string();
        }
    }

    pub fn write_input(&self, data: &str) -> Result<(), String> {
        let mut writer = self
            .writer
            .lock()
            .map_err(|_| "Unable to access terminal PTY writer".to_string())?;
        writer
            .write_all(data.as_bytes())
            .map_err(|error| format!("Unable to write to terminal PTY: {error}"))?;
        writer
            .flush()
            .map_err(|error| format!("Unable to flush terminal PTY input: {error}"))?;

        if let Ok(mut buffer) = self.buffer.lock() {
            buffer.push_str(data);
        }
        if let Ok(window_label) = self.window_label.lock() {
            if let Some(window) = self.app.get_webview_window(window_label.as_str()) {
                let _ = window.emit(
                    "agent-terminal-output",
                    serde_json::json!({ "sessionId": self.session_id, "data": data }),
                );
            }
        }
        Ok(())
    }

    pub fn resize(&self, cols: u16, rows: u16) -> Result<(), String> {
        self.master
            .lock()
            .map_err(|_| "Unable to access terminal PTY state".to_string())?
            .resize(PtySize {
                rows,
                cols,
                pixel_width: 0,
                pixel_height: 0,
            })
            .map_err(|error| format!("Unable to resize terminal PTY: {error}"))
    }

    pub fn buffer(&self) -> Result<String, String> {
        self.buffer
            .lock()
            .map(|buffer| buffer.clone())
            .map_err(|_| "Unable to access terminal output buffer".to_string())
    }

    pub fn shutdown(&self) {
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
        }
        self.cleanup_temp_home_dir();
    }

    fn read_loop(&self, mut reader: Box<dyn Read + Send>) {
        let mut bytes = [0_u8; 4096];
        loop {
            match reader.read(&mut bytes) {
                Ok(0) => break,
                Ok(count) => {
                    let chunk = String::from_utf8_lossy(&bytes[..count]).to_string();
                    if let Ok(mut buffer) = self.buffer.lock() {
                        buffer.push_str(&chunk);
                    }
                    if let Ok(window_label) = self.window_label.lock() {
                        if let Some(window) = self.app.get_webview_window(window_label.as_str()) {
                            let _ = window.emit(
                                "agent-terminal-output",
                                serde_json::json!({ "sessionId": self.session_id, "data": chunk }),
                            );
                        }
                    }
                }
                Err(_) => break,
            }
        }

        self.cleanup_temp_home_dir();
        let state = self.app.state::<AppState>();
        let _ = state.clear_terminal_window(&self.session_id);
        let _ = state.remove_terminal_session(&self.session_id);
        let _ = crate::services::session_attachments::clear_session_terminal_attachment(
            &self.session_id,
        );
        let _ = self.app.emit(
            "orchestra:session-change",
            serde_json::json!({ "sessionIds": [self.session_id.clone()], "reason": "sessions.terminal.detach" }),
        );
    }

    fn cleanup_temp_home_dir(&self) {
        if let Some(temp_home_dir) = self.temp_home_dir.as_ref() {
            let _ = fs::remove_dir_all(temp_home_dir);
        }
    }
}

fn prepare_terminal_home_dir(
    _session_id: &str,
    _pi_executable: &Path,
) -> Result<Option<PathBuf>, String> {
    Ok(None)
}

fn sanitize_for_path(value: &str) -> String {
    value
        .chars()
        .map(|ch| if ch.is_ascii_alphanumeric() { ch } else { '-' })
        .collect()
}

fn copy_if_exists(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }
    fs::copy(source, destination).map(|_| ()).map_err(|error| {
        format!(
            "Unable to copy {} to {}: {error}",
            source.display(),
            destination.display()
        )
    })
}

fn copy_filtered_settings(source: &Path, destination: &Path) -> Result<(), String> {
    if !source.exists() {
        return Ok(());
    }

    let mut settings: serde_json::Value = serde_json::from_slice(
        &fs::read(source)
            .map_err(|error| format!("Unable to read {}: {error}", source.display()))?,
    )
    .map_err(|error| format!("Unable to parse {}: {error}", source.display()))?;

    if let Some(packages) = settings
        .get_mut("packages")
        .and_then(serde_json::Value::as_array_mut)
    {
        packages.retain(|entry| entry.as_str() != Some("npm:pi-powerline-footer"));
    }

    fs::write(
        destination,
        serde_json::to_vec_pretty(&settings)
            .map_err(|error| format!("Unable to serialize filtered settings: {error}"))?,
    )
    .map_err(|error| format!("Unable to write {}: {error}", destination.display()))
}

fn infer_npm_prefix(pi_executable: &Path, temp_home_dir: &Path) -> Option<PathBuf> {
    if let Ok(prefix) = std::env::var("NPM_CONFIG_PREFIX") {
        let path = PathBuf::from(prefix);
        if path.exists() {
            return Some(path);
        }
    }
    if let Ok(prefix) = std::env::var("npm_config_prefix") {
        let path = PathBuf::from(prefix);
        if path.exists() {
            return Some(path);
        }
    }

    let parent = pi_executable.parent()?;
    if parent.file_name()? == "bin" {
        return parent
            .parent()
            .map(Path::to_path_buf)
            .filter(|path| path.exists());
    }

    let fallback = temp_home_dir.join(".npm-global");
    Some(fallback)
}
