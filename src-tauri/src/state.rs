use std::sync::Mutex;

use crate::models::LogEntry;

pub struct AppState {
    pub logs: Mutex<Vec<LogEntry>>,
}

impl AppState {
    pub fn new() -> Self {
        Self {
            logs: Mutex::new(vec![
                LogEntry {
                    id: "log-1".into(),
                    level: "info".into(),
                    target: "app.bootstrap".into(),
                    message: "Orchestra backend scaffold initialized".into(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                },
                LogEntry {
                    id: "log-2".into(),
                    level: "info".into(),
                    target: "settings.logs".into(),
                    message: "Runtime log viewer ready for session integration".into(),
                    timestamp: chrono::Utc::now().to_rfc3339(),
                },
            ]),
        }
    }
}
