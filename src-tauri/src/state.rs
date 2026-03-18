use std::{collections::HashSet, sync::Mutex};

use crate::models::LogEntry;

pub struct AppState {
    pub logs: Mutex<Vec<LogEntry>>,
    subscribed_sessions: Mutex<HashSet<String>>,
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
                    "Desktop mode now uses real pi session files plus pi --mode rpc for prompt execution",
                ),
            ]),
            subscribed_sessions: Mutex::new(HashSet::new()),
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
}
