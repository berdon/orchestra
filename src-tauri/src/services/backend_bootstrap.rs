use std::{path::PathBuf, sync::Arc, time::Instant};

use tauri::Manager;

use crate::{
    models::{AgentDefinition, PolicyDefinition},
    services,
    state::AppState,
};

pub struct BackendBootstrap {
    pub database_path: PathBuf,
    pub tool_bridge: Arc<services::tool_bridge::ToolBridgeConfig>,
    pub supervisor_policy: PolicyDefinition,
    pub supervisor_agent: AgentDefinition,
}

fn log_startup_timing(stage: &str, started_at: Instant) {
    tracing::info!(
        target: "startup.timing.backend",
        "stage={stage} duration_ms={:.1}",
        started_at.elapsed().as_secs_f64() * 1000.0,
    );
}

pub fn initialize_backend() -> Result<BackendBootstrap, String> {
    let initialize_started_at = Instant::now();
    services::logging::init_logging();
    let database_started_at = Instant::now();
    let database_path = services::database::initialize_database()?;
    log_startup_timing("initialize_database", database_started_at);
    let tool_bridge_started_at = Instant::now();
    let tool_bridge = services::tool_bridge::start_tool_bridge()?;
    log_startup_timing("start_tool_bridge", tool_bridge_started_at);
    let connection_started_at = Instant::now();
    let mut bootstrap_connection = services::database::open_connection()?;
    log_startup_timing("open_bootstrap_connection", connection_started_at);
    let auth_started_at = Instant::now();
    let (supervisor_policy, supervisor_agent) =
        services::auth_bootstrap::ensure_system_authorization_state(
            &mut bootstrap_connection,
            None,
        )?;
    log_startup_timing("ensure_system_authorization_state", auth_started_at);
    let install_seed_started_at = Instant::now();
    services::install_seed::ensure_install_baseline_seeded(&mut bootstrap_connection)?;
    log_startup_timing("ensure_install_baseline_seeded", install_seed_started_at);
    let reconcile_started_at = Instant::now();
    services::agent_runtime::reconcile_agent_runtime_states(&bootstrap_connection)?;
    log_startup_timing("reconcile_agent_runtime_states", reconcile_started_at);
    log_startup_timing("initialize_backend_total", initialize_started_at);

    Ok(BackendBootstrap {
        database_path,
        tool_bridge,
        supervisor_policy,
        supervisor_agent,
    })
}

pub struct CliBackend {
    pub database_path: PathBuf,
    pub tool_bridge: Arc<services::tool_bridge::ToolBridgeConfig>,
    app_handle: tauri::AppHandle,
    _app: Option<tauri::App<tauri::Wry>>,
}

impl CliBackend {
    pub fn app_handle(&self) -> tauri::AppHandle {
        self.app_handle.clone()
    }

    pub fn state(&self) -> tauri::State<'_, AppState> {
        self.app_handle.state::<AppState>()
    }

    #[cfg(test)]
    pub(crate) fn from_test_handle(
        database_path: PathBuf,
        tool_bridge: Arc<services::tool_bridge::ToolBridgeConfig>,
        app_handle: tauri::AppHandle,
    ) -> Self {
        Self {
            database_path,
            tool_bridge,
            app_handle,
            _app: None,
        }
    }
}

pub fn initialize_cli_backend() -> Result<CliBackend, String> {
    let bootstrap = initialize_backend()?;
    let app = tauri::Builder::default()
        .manage(AppState::new(bootstrap.tool_bridge.clone()))
        .build(crate::tauri_context())
        .map_err(|error| format!("Unable to build headless orc CLI app handle: {error}"))?;
    let app_handle = app.handle().clone();
    bootstrap.tool_bridge.attach_app_handle(app_handle.clone());
    app_handle.state::<AppState>().log(
        "info",
        "orc.cli.bootstrap",
        &format!(
            "Initialized orc CLI backend at {}",
            bootstrap.database_path.display()
        ),
    );
    Ok(CliBackend {
        database_path: bootstrap.database_path,
        tool_bridge: bootstrap.tool_bridge,
        app_handle,
        _app: Some(app),
    })
}
