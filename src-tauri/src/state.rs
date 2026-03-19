use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use crate::{models::LogEntry, services::live_sessions::SessionRuntime};

pub struct AppState {
    pub logs: Mutex<Vec<LogEntry>>,
    subscribed_sessions: Mutex<HashSet<String>>,
    active_session_runs: Mutex<HashMap<String, String>>,
    pub session_runtimes: Mutex<HashMap<String, Arc<SessionRuntime>>>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn generate_id(prefix: &str) -> String {
    format!("{}-{}", prefix, chrono::Utc::now().timestamp_micros())
}

fn create_log(level: &str, target: &str, message: &str) -> LogEntry {
    LogEntry {
        id: generate_id("log"),
        level: level.into(),
        target: target.into(),
        message: message.into(),
        timestamp: now_iso(),
    }
}

impl AppState {
    pub fn new() -> Self {
        Self {
            logs: Mutex::new(vec![
                create_log("info", "app.bootstrap", "Orchestra backend initialized"),
                create_log(
                    "info",
                    "session.backend",
                    "Desktop mode uses real pi session files, background RPC turns, and streaming session events",
                ),
            ]),
            subscribed_sessions: Mutex::new(HashSet::new()),
            active_session_runs: Mutex::new(HashMap::new()),
            session_runtimes: Mutex::new(HashMap::new()),
        }
    }

    pub fn log(&self, level: &str, target: &str, message: &str) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.insert(0, create_log(level, target, message));
            logs.truncate(200);
        }
    }

    pub fn set_session_subscription(&self, session_id: &str, subscribed: bool) -> Result<(), String> {
        let mut sessions = self
            .subscribed_sessions
            .lock()
            .map_err(|_| "Unable to access session subscription state".to_string())?;

        if subscribed {
            sessions.insert(session_id.to_string());
        } else {
            sessions.remove(session_id);
        }

        Ok(())
    }

    pub fn subscribed_session_ids(&self) -> Result<HashSet<String>, String> {
        self.subscribed_sessions
            .lock()
            .map(|sessions| sessions.clone())
            .map_err(|_| "Unable to access session subscription state".to_string())
    }

    pub fn begin_session_run(&self, session_id: &str, run_id: &str) -> Result<(), String> {
        let mut active_runs = self
            .active_session_runs
            .lock()
            .map_err(|_| "Unable to access active session run state".to_string())?;

        if active_runs.contains_key(session_id) {
            return Err("This session is already processing a message".into());
        }

        active_runs.insert(session_id.to_string(), run_id.to_string());
        Ok(())
    }

    pub fn end_session_run(&self, session_id: &str, run_id: &str) -> Result<(), String> {
        let mut active_runs = self
            .active_session_runs
            .lock()
            .map_err(|_| "Unable to access active session run state".to_string())?;

        if active_runs.get(session_id).is_some_and(|current| current == run_id) {
            active_runs.remove(session_id);
        }

        Ok(())
    }

    pub fn is_session_running(&self, session_id: &str) -> Result<bool, String> {
        self.active_session_runs
            .lock()
            .map(|active_runs| active_runs.contains_key(session_id))
            .map_err(|_| "Unable to access active session run state".to_string())
    }
}
