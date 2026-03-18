use std::sync::Mutex;

use crate::models::{LogEntry, SessionEvent, SessionRecord};

pub struct AppState {
    pub logs: Mutex<Vec<LogEntry>>,
    pub sessions: Mutex<Vec<SessionRecord>>,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn generate_id(prefix: &str) -> String {
    format!("{}-{}", prefix, chrono::Utc::now().timestamp_micros())
}

fn create_event(kind: &str, message: &str) -> SessionEvent {
    SessionEvent {
        id: generate_id("event"),
        kind: kind.into(),
        message: message.into(),
        timestamp: now_iso(),
    }
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
        let timestamp = now_iso();

        Self {
            logs: Mutex::new(vec![
                create_log("info", "app.bootstrap", "Orchestra backend scaffold initialized"),
                create_log(
                    "info",
                    "session.backend",
                    "Session command surface ready for create, resume, and interaction wiring",
                ),
            ]),
            sessions: Mutex::new(vec![SessionRecord {
                id: generate_id("session"),
                title: "Session-first spike".into(),
                status: "idle".into(),
                created_at: timestamp.clone(),
                updated_at: timestamp,
                subscribed: false,
                events: vec![
                    create_event("system", "Seed session created by the Orchestra backend scaffold."),
                    create_event(
                        "assistant",
                        "This placeholder session exists so the Sessions UI can list, resume, subscribe, and interact immediately.",
                    ),
                ],
            }]),
        }
    }

    pub fn log(&self, level: &str, target: &str, message: &str) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.insert(0, create_log(level, target, message));
            logs.truncate(200);
        }
    }
}

pub fn assistant_reply(message: &str) -> String {
    format!(
        "Acknowledged: {}\n\nThis is the scaffold session backend. The app flow for create, resume, subscribe, and interaction is ready for real pi-agent-core integration.",
        message
    )
}

pub fn create_session_event(kind: &str, message: &str) -> SessionEvent {
    create_event(kind, message)
}
