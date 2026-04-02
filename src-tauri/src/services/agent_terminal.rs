use std::{
    io::{Read, Write},
    path::Path,
    sync::{Arc, Mutex},
    thread,
};

use portable_pty::{native_pty_system, CommandBuilder, PtySize};
use tauri::{AppHandle, Emitter, Manager};

use crate::state::AppState;

pub struct AgentTerminalSession {
    session_id: String,
    window_label: Mutex<String>,
    writer: Mutex<Box<dyn Write + Send>>,
    master: Mutex<Box<dyn portable_pty::MasterPty + Send>>,
    child: Mutex<Box<dyn portable_pty::Child + Send + Sync>>,
    buffer: Mutex<String>,
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

        let pi_executable = crate::services::pi_sessions::resolve_pi_executable(None)?;
        let mut command = CommandBuilder::new(&pi_executable);
        command.cwd(runtime_cwd);
        command.arg("--session");
        command.arg(session_path.to_string_lossy().to_string());
        command.arg("--session-dir");
        command.arg(session_dir.to_string_lossy().to_string());

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
            buffer: Mutex::new(String::new()),
            app: app.clone(),
        });

        let session_for_reader = Arc::clone(&session);
        thread::spawn(move || {
            session_for_reader.read_loop(reader);
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
            .map_err(|error| format!("Unable to flush terminal PTY input: {error}"))
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

        let state = self.app.state::<AppState>();
        let _ = state.clear_terminal_window(&self.session_id);
        let _ = state.remove_terminal_session(&self.session_id);
        let _ = self.app.emit(
            "orchestra:session-change",
            serde_json::json!({ "sessionIds": [self.session_id.clone()], "reason": "sessions.terminal.detach" }),
        );
    }
}
