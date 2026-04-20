use std::{
    collections::{HashMap, HashSet},
    path::PathBuf,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
};

use serde::Serialize;
use serde_json::Value;
use tokio::sync::{broadcast, oneshot};

use crate::{
    models::{
        AuthorizationContext, LogEntry, RemoteClientRecord, RemoteDeviceRecord, RemoteEventEnvelope,
    },
    services::{
        agent_terminal::AgentTerminalSession, channels::ChannelRuntimeHandle,
        live_sessions::SessionRuntime, tool_bridge::ToolBridgeConfig,
    },
};

#[derive(Debug)]
pub struct RemoteApiServerHandle {
    pub bind_host: String,
    pub port: u16,
    pub base_url: String,
    pub websocket_url: String,
    pub lan_base_url: Option<String>,
    pub started_at: String,
    pub shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug)]
pub struct RemoteWebServerHandle {
    pub bind_host: String,
    pub port: u16,
    pub base_url: String,
    pub started_at: String,
    pub shutdown: Option<oneshot::Sender<()>>,
}

#[derive(Debug, Clone)]
struct RemoteClientState {
    client_id: String,
    client_kind: String,
    device_id: Option<String>,
    device_label: Option<String>,
    active_project_id: Option<String>,
    connected_at: String,
    last_seen_at: String,
    subscribed_sessions: HashSet<String>,
}

pub struct AppState {
    pub logs: Mutex<Vec<LogEntry>>,
    desktop_subscribed_sessions: Mutex<HashSet<String>>,
    active_session_runs: Mutex<HashMap<String, String>>,
    pub session_runtimes: Mutex<HashMap<String, Arc<SessionRuntime>>>,
    pub channel_runtimes: Mutex<HashMap<String, ChannelRuntimeHandle>>,
    terminal_windows: Mutex<HashMap<String, String>>,
    terminal_sessions: Mutex<HashMap<String, Arc<AgentTerminalSession>>>,
    pub dispatcher_tick_active: Mutex<bool>,
    pi_dispatch_block_reason: Mutex<Option<String>>,
    pub tool_bridge: Arc<ToolBridgeConfig>,
    remote_clients: Mutex<HashMap<String, RemoteClientState>>,
    remote_server: Mutex<Option<RemoteApiServerHandle>>,
    remote_web_server: Mutex<Option<RemoteWebServerHandle>>,
    remote_server_last_error: Mutex<Option<String>>,
    remote_event_tx: broadcast::Sender<RemoteEventEnvelope>,
    next_remote_event_sequence: AtomicU64,
}

pub fn now_iso() -> String {
    chrono::Utc::now().to_rfc3339()
}

pub fn generate_id(prefix: &str) -> String {
    format!("{}-{}", prefix, chrono::Utc::now().timestamp_micros())
}

fn normalize_log_level(_level: &str, target: &str) -> &'static str {
    if target == "sessions.rpc.event" {
        "debug"
    } else {
        "info"
    }
}

fn create_log(level: &str, target: &str, message: &str) -> LogEntry {
    LogEntry {
        id: generate_id("log"),
        level: normalize_log_level(level, target).into(),
        target: target.into(),
        message: message.into(),
        timestamp: now_iso(),
    }
}

impl AppState {
    pub fn new(tool_bridge: Arc<ToolBridgeConfig>) -> Self {
        let (remote_event_tx, _) = broadcast::channel(512);
        Self {
            logs: Mutex::new(vec![
                create_log("info", "app.bootstrap", "Orchestra backend initialized"),
                create_log(
                    "info",
                    "session.backend",
                    "Desktop mode uses real pi session files, background RPC turns, streaming session events",
                ),
            ]),
            desktop_subscribed_sessions: Mutex::new(HashSet::new()),
            active_session_runs: Mutex::new(HashMap::new()),
            session_runtimes: Mutex::new(HashMap::new()),
            channel_runtimes: Mutex::new(HashMap::new()),
            terminal_windows: Mutex::new(HashMap::new()),
            terminal_sessions: Mutex::new(HashMap::new()),
            dispatcher_tick_active: Mutex::new(false),
            pi_dispatch_block_reason: Mutex::new(None),
            tool_bridge,
            remote_clients: Mutex::new(HashMap::new()),
            remote_server: Mutex::new(None),
            remote_web_server: Mutex::new(None),
            remote_server_last_error: Mutex::new(None),
            remote_event_tx,
            next_remote_event_sequence: AtomicU64::new(1),
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

    pub fn publish_remote_event<T: Serialize>(
        &self,
        topic: &str,
        project_id: Option<String>,
        session_id: Option<String>,
        task_id: Option<String>,
        delivery_id: Option<String>,
        payload: &T,
    ) -> Result<RemoteEventEnvelope, String> {
        let payload = serde_json::to_value(payload)
            .map_err(|error| format!("Unable to serialize remote event payload: {error}"))?;
        self.publish_remote_event_value(
            topic,
            project_id,
            session_id,
            task_id,
            delivery_id,
            payload,
        )
    }

    pub fn publish_remote_event_value(
        &self,
        topic: &str,
        project_id: Option<String>,
        session_id: Option<String>,
        task_id: Option<String>,
        delivery_id: Option<String>,
        payload: Value,
    ) -> Result<RemoteEventEnvelope, String> {
        let event = RemoteEventEnvelope {
            id: generate_id("remote-event"),
            sequence: self
                .next_remote_event_sequence
                .fetch_add(1, Ordering::Relaxed),
            topic: topic.to_string(),
            timestamp: now_iso(),
            project_id,
            session_id,
            task_id,
            delivery_id,
            payload,
        };
        let _ = self.remote_event_tx.send(event.clone());
        Ok(event)
    }

    pub fn subscribe_remote_events(&self) -> broadcast::Receiver<RemoteEventEnvelope> {
        self.remote_event_tx.subscribe()
    }

    pub fn set_remote_server(&self, server: RemoteApiServerHandle) -> Result<(), String> {
        let mut current = self
            .remote_server
            .lock()
            .map_err(|_| "Unable to access remote server state".to_string())?;
        *current = Some(server);
        self.clear_remote_server_error()?;
        Ok(())
    }

    pub fn clear_remote_server(&self) -> Result<(), String> {
        let mut current = self
            .remote_server
            .lock()
            .map_err(|_| "Unable to access remote server state".to_string())?;
        *current = None;
        Ok(())
    }

    pub fn take_remote_server(&self) -> Result<Option<RemoteApiServerHandle>, String> {
        self.remote_server
            .lock()
            .map_err(|_| "Unable to access remote server state".to_string())
            .map(|mut current| current.take())
    }

    pub fn remote_server_snapshot(
        &self,
    ) -> Result<Option<(String, u16, String, String, Option<String>, String)>, String> {
        self.remote_server
            .lock()
            .map_err(|_| "Unable to access remote server state".to_string())
            .map(|current| {
                current.as_ref().map(|server| {
                    (
                        server.bind_host.clone(),
                        server.port,
                        server.base_url.clone(),
                        server.websocket_url.clone(),
                        server.lan_base_url.clone(),
                        server.started_at.clone(),
                    )
                })
            })
    }

    pub fn set_remote_server_error(&self, error: impl Into<String>) -> Result<(), String> {
        let mut current = self
            .remote_server_last_error
            .lock()
            .map_err(|_| "Unable to access remote server error state".to_string())?;
        *current = Some(error.into());
        Ok(())
    }

    pub fn clear_remote_server_error(&self) -> Result<(), String> {
        let mut current = self
            .remote_server_last_error
            .lock()
            .map_err(|_| "Unable to access remote server error state".to_string())?;
        *current = None;
        Ok(())
    }

    pub fn remote_server_error(&self) -> Result<Option<String>, String> {
        self.remote_server_last_error
            .lock()
            .map_err(|_| "Unable to access remote server error state".to_string())
            .map(|current| current.clone())
    }

    pub fn set_remote_web_server(&self, server: RemoteWebServerHandle) -> Result<(), String> {
        let mut current = self
            .remote_web_server
            .lock()
            .map_err(|_| "Unable to access remote web server state".to_string())?;
        *current = Some(server);
        Ok(())
    }

    pub fn clear_remote_web_server(&self) -> Result<(), String> {
        let mut current = self
            .remote_web_server
            .lock()
            .map_err(|_| "Unable to access remote web server state".to_string())?;
        *current = None;
        Ok(())
    }

    pub fn take_remote_web_server(&self) -> Result<Option<RemoteWebServerHandle>, String> {
        self.remote_web_server
            .lock()
            .map_err(|_| "Unable to access remote web server state".to_string())
            .map(|mut current| current.take())
    }

    pub fn remote_web_server_snapshot(
        &self,
    ) -> Result<Option<(String, u16, String, String)>, String> {
        self.remote_web_server
            .lock()
            .map_err(|_| "Unable to access remote web server state".to_string())
            .map(|current| {
                current.as_ref().map(|server| {
                    (
                        server.bind_host.clone(),
                        server.port,
                        server.base_url.clone(),
                        server.started_at.clone(),
                    )
                })
            })
    }

    pub fn register_remote_client(
        &self,
        client_id: &str,
        client_kind: &str,
        device_id: Option<String>,
        device_label: Option<String>,
        active_project_id: Option<String>,
    ) -> Result<(), String> {
        let now = now_iso();
        self.remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?
            .insert(
                client_id.to_string(),
                RemoteClientState {
                    client_id: client_id.to_string(),
                    client_kind: client_kind.to_string(),
                    device_id,
                    device_label,
                    active_project_id,
                    connected_at: now.clone(),
                    last_seen_at: now,
                    subscribed_sessions: HashSet::new(),
                },
            );
        Ok(())
    }

    pub fn unregister_remote_client(&self, client_id: &str) -> Result<Vec<String>, String> {
        let removed = self
            .remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?
            .remove(client_id)
            .map(|client| client.subscribed_sessions.into_iter().collect::<Vec<_>>())
            .unwrap_or_default();
        for session_id in &removed {
            self.sync_session_runtime_subscription(session_id)?;
        }
        Ok(removed)
    }

    pub fn touch_remote_client(&self, client_id: &str) -> Result<(), String> {
        if let Some(client) = self
            .remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?
            .get_mut(client_id)
        {
            client.last_seen_at = now_iso();
        }
        Ok(())
    }

    pub fn set_remote_client_project(
        &self,
        client_id: &str,
        active_project_id: Option<String>,
    ) -> Result<(), String> {
        if let Some(client) = self
            .remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?
            .get_mut(client_id)
        {
            client.active_project_id = active_project_id;
            client.last_seen_at = now_iso();
        }
        Ok(())
    }

    pub fn set_remote_session_subscription(
        &self,
        client_id: &str,
        session_id: &str,
        subscribed: bool,
    ) -> Result<(), String> {
        let found = {
            let mut clients = self
                .remote_clients
                .lock()
                .map_err(|_| "Unable to access remote client state".to_string())?;
            if let Some(client) = clients.get_mut(client_id) {
                if subscribed {
                    client.subscribed_sessions.insert(session_id.to_string());
                } else {
                    client.subscribed_sessions.remove(session_id);
                }
                client.last_seen_at = now_iso();
                true
            } else {
                false
            }
        };
        if !found {
            return Err(format!("Remote client {client_id} is not registered"));
        }
        self.sync_session_runtime_subscription(session_id)
    }

    pub fn list_remote_clients(&self) -> Result<Vec<RemoteClientRecord>, String> {
        let mut clients = self
            .remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?
            .values()
            .cloned()
            .map(|client| RemoteClientRecord {
                client_id: client.client_id,
                client_kind: client.client_kind,
                device_id: client.device_id,
                device_label: client.device_label,
                active_project_id: client.active_project_id,
                connected_at: client.connected_at,
                last_seen_at: client.last_seen_at,
                subscribed_session_count: client.subscribed_sessions.len() as i64,
            })
            .collect::<Vec<_>>();
        clients.sort_by(|left, right| right.last_seen_at.cmp(&left.last_seen_at));
        Ok(clients)
    }

    pub fn remote_client_is_subscribed_to_session(
        &self,
        client_id: &str,
        session_id: &str,
    ) -> Result<bool, String> {
        self.remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())
            .map(|clients| {
                clients
                    .get(client_id)
                    .map(|client| client.subscribed_sessions.contains(session_id))
                    .unwrap_or(false)
            })
    }

    pub fn with_remote_device_client_counts(
        &self,
        devices: Vec<RemoteDeviceRecord>,
    ) -> Result<Vec<RemoteDeviceRecord>, String> {
        let clients = self
            .remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?;
        Ok(devices
            .into_iter()
            .map(|mut device| {
                device.active_client_count = clients
                    .values()
                    .filter(|client| client.device_id.as_deref() == Some(device.id.as_str()))
                    .count() as i64;
                device
            })
            .collect())
    }

    pub fn set_session_subscription(
        &self,
        session_id: &str,
        subscribed: bool,
    ) -> Result<(), String> {
        let mut sessions = self
            .desktop_subscribed_sessions
            .lock()
            .map_err(|_| "Unable to access session subscription state".to_string())?;

        if subscribed {
            sessions.insert(session_id.to_string());
        } else {
            sessions.remove(session_id);
        }
        drop(sessions);
        self.sync_session_runtime_subscription(session_id)
    }

    pub fn subscribed_session_ids(&self) -> Result<HashSet<String>, String> {
        self.desktop_subscribed_sessions
            .lock()
            .map(|sessions| sessions.clone())
            .map_err(|_| "Unable to access session subscription state".to_string())
    }

    pub fn has_session_subscribers(&self, session_id: &str) -> Result<bool, String> {
        if self
            .desktop_subscribed_sessions
            .lock()
            .map_err(|_| "Unable to access session subscription state".to_string())?
            .contains(session_id)
        {
            return Ok(true);
        }
        Ok(self
            .remote_clients
            .lock()
            .map_err(|_| "Unable to access remote client state".to_string())?
            .values()
            .any(|client| client.subscribed_sessions.contains(session_id)))
    }

    pub fn sync_session_runtime_subscription(&self, session_id: &str) -> Result<(), String> {
        let subscribed = self.has_session_subscribers(session_id)?;
        let runtime = self
            .session_runtimes
            .lock()
            .map_err(|_| "Unable to access session runtime state".to_string())?
            .get(session_id)
            .cloned();

        if let Some(runtime) = runtime {
            runtime.set_subscribed(subscribed);
        }
        Ok(())
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

    pub fn clear_active_session_run(&self, session_id: &str) -> Result<(), String> {
        self.active_session_runs
            .lock()
            .map_err(|_| "Unable to access active session run state".to_string())?
            .remove(session_id);
        Ok(())
    }

    pub fn is_session_running(&self, session_id: &str) -> Result<bool, String> {
        self.active_session_runs
            .lock()
            .map(|active_runs| active_runs.contains_key(session_id))
            .map_err(|_| "Unable to access active session run state".to_string())
    }

    pub fn active_session_run_id(&self, session_id: &str) -> Result<Option<String>, String> {
        self.active_session_runs
            .lock()
            .map(|active_runs| active_runs.get(session_id).cloned())
            .map_err(|_| "Unable to access active session run state".to_string())
    }

    pub fn set_terminal_window(&self, session_id: &str, window_label: &str) -> Result<(), String> {
        self.terminal_windows
            .lock()
            .map_err(|_| "Unable to access terminal window state".to_string())?
            .insert(session_id.to_string(), window_label.to_string());
        Ok(())
    }

    pub fn get_terminal_window_label(&self, session_id: &str) -> Result<Option<String>, String> {
        self.terminal_windows
            .lock()
            .map_err(|_| "Unable to access terminal window state".to_string())
            .map(|windows| windows.get(session_id).cloned())
    }

    pub fn clear_terminal_window(&self, session_id: &str) -> Result<(), String> {
        self.terminal_windows
            .lock()
            .map_err(|_| "Unable to access terminal window state".to_string())?
            .remove(session_id);
        Ok(())
    }

    pub fn terminal_attached_session_ids(&self) -> Result<HashSet<String>, String> {
        self.terminal_windows
            .lock()
            .map_err(|_| "Unable to access terminal window state".to_string())
            .map(|windows| windows.keys().cloned().collect())
    }

    pub fn insert_terminal_session(
        &self,
        session_id: &str,
        session: Arc<AgentTerminalSession>,
    ) -> Result<(), String> {
        self.terminal_sessions
            .lock()
            .map_err(|_| "Unable to access terminal session state".to_string())?
            .insert(session_id.to_string(), session);
        Ok(())
    }

    pub fn get_terminal_session(
        &self,
        session_id: &str,
    ) -> Result<Option<Arc<AgentTerminalSession>>, String> {
        self.terminal_sessions
            .lock()
            .map_err(|_| "Unable to access terminal session state".to_string())
            .map(|sessions| sessions.get(session_id).cloned())
    }

    pub fn remove_terminal_session(
        &self,
        session_id: &str,
    ) -> Result<Option<Arc<AgentTerminalSession>>, String> {
        self.terminal_sessions
            .lock()
            .map_err(|_| "Unable to access terminal session state".to_string())
            .map(|mut sessions| sessions.remove(session_id))
    }

    pub fn sync_pi_runtime_health(&self) -> Result<PathBuf, String> {
        match crate::services::pi_sessions::resolve_pi_executable(None) {
            Ok(path) => {
                let was_blocked = self
                    .pi_dispatch_block_reason
                    .lock()
                    .map_err(|_| "Unable to access PI dispatch block state".to_string())?
                    .take()
                    .is_some();
                if was_blocked {
                    self.log(
                        "info",
                        "pi.dispatch.unblocked",
                        &format!(
                            "PI executable is available again at {}. Dispatching re-enabled.",
                            path.display()
                        ),
                    );
                }
                Ok(path)
            }
            Err(error) => {
                let mut guard = self
                    .pi_dispatch_block_reason
                    .lock()
                    .map_err(|_| "Unable to access PI dispatch block state".to_string())?;
                let changed = guard.as_deref() != Some(error.as_str());
                *guard = Some(error.clone());
                drop(guard);
                if changed {
                    self.log(
                        "error",
                        "pi.dispatch.blocked",
                        &format!("Dispatching disabled: {error}"),
                    );
                }
                Err(error)
            }
        }
    }

    pub fn clear_session_tracking(&self, session_id: &str) -> Result<(), String> {
        self.desktop_subscribed_sessions
            .lock()
            .map_err(|_| "Unable to access session subscription state".to_string())?
            .remove(session_id);
        if let Ok(mut clients) = self.remote_clients.lock() {
            for client in clients.values_mut() {
                client.subscribed_sessions.remove(session_id);
            }
        }
        self.terminal_windows
            .lock()
            .map_err(|_| "Unable to access terminal window state".to_string())?
            .remove(session_id);
        self.terminal_sessions
            .lock()
            .map_err(|_| "Unable to access terminal session state".to_string())?
            .remove(session_id);
        self.active_session_runs
            .lock()
            .map_err(|_| "Unable to access active session run state".to_string())?
            .remove(session_id);
        let _ = self.sync_session_runtime_subscription(session_id);
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

    pub fn shutdown_all_session_runtimes(&self) -> Result<usize, String> {
        let runtimes = self
            .session_runtimes
            .lock()
            .map_err(|_| "Unable to access session runtime state".to_string())?
            .drain()
            .map(|(_, runtime)| runtime)
            .collect::<Vec<_>>();

        let count = runtimes.len();
        for runtime in runtimes {
            runtime.shutdown();
        }

        Ok(count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::tool_bridge::ToolBridgeConfig;

    fn test_state() -> AppState {
        AppState::new(Arc::new(ToolBridgeConfig::test_config()))
    }

    #[test]
    fn remote_event_bus_publishes_sequence_numbers() {
        let state = test_state();
        let mut receiver = state.subscribe_remote_events();
        let first = state
            .publish_remote_event_value(
                "session.updated",
                None,
                Some("session-1".into()),
                None,
                None,
                serde_json::json!({ "reason": "test" }),
            )
            .expect("first event should publish");
        let second = state
            .publish_remote_event_value(
                "task.updated",
                Some("project-1".into()),
                None,
                Some("task-1".into()),
                None,
                serde_json::json!({ "reason": "test-2" }),
            )
            .expect("second event should publish");

        assert_eq!(first.sequence + 1, second.sequence);
        let received = receiver.try_recv().expect("event should be delivered");
        assert_eq!(received.topic, "session.updated");
        assert_eq!(received.session_id.as_deref(), Some("session-1"));
    }

    #[test]
    fn remote_client_session_subscriptions_are_tracked() {
        let state = test_state();
        state
            .register_remote_client(
                "client-1",
                "remote_driver",
                Some("device-1".into()),
                Some("Phone".into()),
                Some("project-1".into()),
            )
            .expect("client should register");
        state
            .set_remote_session_subscription("client-1", "session-1", true)
            .expect("subscription should succeed");

        assert!(state
            .remote_client_is_subscribed_to_session("client-1", "session-1")
            .expect("subscription lookup should succeed"));
        assert!(state
            .has_session_subscribers("session-1")
            .expect("subscriber count should include remote client"));

        let clients = state.list_remote_clients().expect("clients should list");
        assert_eq!(clients.len(), 1);
        assert_eq!(clients[0].subscribed_session_count, 1);

        let removed = state
            .unregister_remote_client("client-1")
            .expect("client should unregister");
        assert_eq!(removed, vec!["session-1".to_string()]);
        assert!(!state
            .has_session_subscribers("session-1")
            .expect("no subscribers should remain"));
    }
}
