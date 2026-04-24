use std::{path::PathBuf, sync::Arc};

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

pub fn initialize_backend() -> Result<BackendBootstrap, String> {
    services::logging::init_logging();
    let database_path = services::database::initialize_database()?;
    let tool_bridge = services::tool_bridge::start_tool_bridge()?;
    let mut bootstrap_connection = services::database::open_connection()?;
    let (supervisor_policy, supervisor_agent) =
        services::auth_bootstrap::ensure_system_authorization_state(
            &mut bootstrap_connection,
            None,
        )?;
    services::install_seed::ensure_install_baseline_seeded(&mut bootstrap_connection)?;
    services::agent_runtime::reconcile_agent_runtime_states(&bootstrap_connection)?;

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
