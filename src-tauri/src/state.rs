use std::{
    collections::{HashMap, HashSet},
    sync::{Arc, Mutex},
};

use crate::{
    models::{AuthorizationContext, LogEntry},
    services::{live_sessions::SessionRuntime, tool_bridge::ToolBridgeConfig},
};

pub struct AppState {
    pub logs: Mutex<Vec<LogEntry>>,
    subscribed_sessions: Mutex<HashSet<String>>,
    active_session_runs: Mutex<HashMap<String, String>>,
    pub session_runtimes: Mutex<HashMap<String, Arc<SessionRuntime>>>,
    pub dispatcher_tick_active: Mutex<bool>,
    pub tool_bridge: Arc<ToolBridgeConfig>,
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
    pub fn new(tool_bridge: Arc<ToolBridgeConfig>) -> Self {
        Self {
            logs: Mutex::new(vec![
                create_log("info", "app.bootstrap", "Orchestra backend initialized"),
                create_log(
                    "info",
                    "session.backend",
                    "Desktop mode uses real pi session files, background RPC turns, streaming session events",
                ),
            ]),
            subscribed_sessions: Mutex::new(HashSet::new()),
            active_session_runs: Mutex::new(HashMap::new()),
            session_runtimes: Mutex::new(HashMap::new()),
            dispatcher_tick_active: Mutex::new(false),
            tool_bridge,
        }
    }

    pub fn log(&self, level: &str, target: &str, message: &str) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.insert(0, create_log(level, target, message));
            logs.truncate(200);
        }
    }

    pub fn clear_logs(&self) {
        if let Ok(mut logs) = self.logs.lock() {
            logs.clear();
        }
    }

    pub fn log_authorized_action(
        &self,
        target: &str,
        action: &str,
        authorization: Option<&AuthorizationContext>,
        permission: Option<&str>,
        object: &str,
        outcome: &str,
    ) {
        let actor = authorization
            .map(|ctx| format!("{}:{}", ctx.actor_type, ctx.actor_id))
            .unwrap_or_else(|| "unknown".into());
        let permission = permission.unwrap_or("none");
        self.log(
            "info",
            target,
            &format!(
                "action={} actor={} permission={} object={} outcome={}",
                action, actor, permission, object, outcome
            ),
        );
    }

    pub fn set_session_subscription(
        &self,
        session_id: &str,
        subscribed: bool,
    ) -> Result<(), String> {
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

        if active_runs
            .get(session_id)
            .is_some_and(|current| current == run_id)
        {
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

    pub fn clear_session_tracking(&self, session_id: &str) -> Result<(), String> {
        self.subscribed_sessions
            .lock()
            .map_err(|_| "Unable to access session subscription state".to_string())?
            .remove(session_id);
        self.active_session_runs
            .lock()
            .map_err(|_| "Unable to access active session run state".to_string())?
            .remove(session_id);
        Ok(())
    }

    pub fn remove_session_runtime(
        &self,
        session_id: &str,
    ) -> Result<Option<Arc<SessionRuntime>>, String> {
        self.session_runtimes
            .lock()
            .map_err(|_| "Unable to access session runtime state".to_string())
            .map(|mut runtimes| runtimes.remove(session_id))
    }
}
