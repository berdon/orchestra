use std::{
    fs::File,
    io::Write,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::Utc;
use serde_json::json;
use tauri::{AppHandle, Manager, State, WebviewUrl, WebviewWindowBuilder};
use zip::{write::FileOptions, CompressionMethod, ZipWriter};

use crate::{
    models::{
        AppInfo, BridgeCleanupEvent, BridgeDiagnostics, LogEntry, PiExecutableDiagnostic,
        SessionModel, SessionStorageInfo,
    },
    services::{
        database,
        orchestra_paths::default_orchestra_root,
        pi_sessions::{detect_session_context, list_available_models, resolve_pi_executable},
    },
    state::AppState,
};

#[tauri::command]
pub fn get_app_info() -> AppInfo {
    let version = env!("CARGO_PKG_VERSION");
    let hash = option_env!("ORCHESTRA_GIT_HASH").unwrap_or("dev");
    AppInfo {
        app_name: "Orchestra".into(),
        environment: "tauri".into(),
        backend_status: "connected".into(),
        version_display: format!("{}-{}", version, hash),
    }
}

#[tauri::command]
pub fn get_logs(state: State<'_, AppState>) -> Vec<LogEntry> {
    state
        .logs
        .lock()
        .map(|logs| logs.clone())
        .unwrap_or_default()
}

#[tauri::command]
pub fn clear_logs(state: State<'_, AppState>) {
    state.clear_logs();
}

#[tauri::command]
pub fn report_client_error(state: State<'_, AppState>, target: String, message: String) {
    state.log("error", &target, &message);
}

#[tauri::command]
pub fn get_bridge_diagnostics(state: State<'_, AppState>) -> BridgeDiagnostics {
    state.tool_bridge.diagnostics()
}

#[tauri::command]
pub fn cleanup_stale_bridge_instances(
    state: State<'_, AppState>,
) -> Result<Vec<BridgeCleanupEvent>, String> {
    state.tool_bridge.cleanup_stale_instances()
}

#[tauri::command]
pub fn open_logs_window(app: AppHandle) -> Result<(), String> {
    if let Some(window) = app.get_webview_window("logs") {
        window
            .show()
            .map_err(|error| format!("Unable to show logs window: {error}"))?;
        window
            .set_focus()
            .map_err(|error| format!("Unable to focus logs window: {error}"))?;
        return Ok(());
    }

    WebviewWindowBuilder::new(&app, "logs", WebviewUrl::App(PathBuf::from("index.html")))
        .title("Orchestra Logs")
        .inner_size(980.0, 760.0)
        .resizable(true)
        .visible(true)
        .build()
        .map_err(|error| format!("Unable to create logs window: {error}"))?;

    Ok(())
}

#[tauri::command]
pub fn export_logs_bundle(state: State<'_, AppState>) -> Result<String, String> {
    let orchestra_root = default_orchestra_root()?;
    let bundle_dir = orchestra_root.join("exports").join("log-bundles");
    std::fs::create_dir_all(&bundle_dir).map_err(|error| {
        format!(
            "Unable to create log bundle directory {}: {error}",
            bundle_dir.display()
        )
    })?;

    let timestamp = Utc::now();
    let bundle_path = bundle_dir.join(format!(
        "orchestra-logs-{}.zip",
        timestamp.format("%Y%m%d-%H%M%S")
    ));

    let logs = state
        .logs
        .lock()
        .map(|entries| entries.clone())
        .map_err(|_| "Unable to read Orchestra logs".to_string())?;
    let bridge_diagnostics = state.tool_bridge.diagnostics();
    let database_path = database::database_path()?;

    let bundle_file = File::create(&bundle_path).map_err(|error| {
        format!(
            "Unable to create log bundle {}: {error}",
            bundle_path.display()
        )
    })?;
    let mut zip = ZipWriter::new(bundle_file);
    let options = FileOptions::default()
        .compression_method(CompressionMethod::Deflated)
        .unix_permissions(0o644);

    let runtime_log_json = serde_json::to_vec_pretty(&logs)
        .map_err(|error| format!("Unable to serialize runtime logs: {error}"))?;
    zip.start_file("runtime-log.json", options)
        .map_err(|error| format!("Unable to add runtime-log.json to log bundle: {error}"))?;
    zip.write_all(&runtime_log_json)
        .map_err(|error| format!("Unable to write runtime-log.json: {error}"))?;

    let runtime_log_text = format_logs_as_text(&logs);
    zip.start_file("runtime-log.txt", options)
        .map_err(|error| format!("Unable to add runtime-log.txt to log bundle: {error}"))?;
    zip.write_all(runtime_log_text.as_bytes())
        .map_err(|error| format!("Unable to write runtime-log.txt: {error}"))?;

    let bridge_diagnostics_json = serde_json::to_vec_pretty(&bridge_diagnostics)
        .map_err(|error| format!("Unable to serialize bridge diagnostics: {error}"))?;
    zip.start_file("bridge-diagnostics.json", options)
        .map_err(|error| format!("Unable to add bridge-diagnostics.json to log bundle: {error}"))?;
    zip.write_all(&bridge_diagnostics_json)
        .map_err(|error| format!("Unable to write bridge-diagnostics.json: {error}"))?;

    let metadata_json = serde_json::to_vec_pretty(&json!({
        "createdAt": timestamp.to_rfc3339(),
        "appName": "Orchestra",
        "version": env!("CARGO_PKG_VERSION"),
        "gitHash": option_env!("ORCHESTRA_GIT_HASH").unwrap_or("dev"),
        "databasePath": database_path.display().to_string(),
        "bundlePath": bundle_path.display().to_string(),
        "logCount": logs.len(),
    }))
    .map_err(|error| format!("Unable to serialize log bundle metadata: {error}"))?;
    zip.start_file("bundle-metadata.json", options)
        .map_err(|error| format!("Unable to add bundle-metadata.json to log bundle: {error}"))?;
    zip.write_all(&metadata_json)
        .map_err(|error| format!("Unable to write bundle-metadata.json: {error}"))?;

    zip.finish().map_err(|error| {
        format!(
            "Unable to finalize log bundle {}: {error}",
            bundle_path.display()
        )
    })?;

    state.log(
        "info",
        "logs.export",
        &format!("Created log bundle at {}", bundle_path.display()),
    );
    if let Err(error) = open_directory(&bundle_dir) {
        state.log(
            "warn",
            "logs.export.open_dir",
            &format!(
                "Created log bundle at {} but could not open {}: {}",
                bundle_path.display(),
                bundle_dir.display(),
                error
            ),
        );
    }

    Ok(bundle_path.display().to_string())
}

#[tauri::command]
pub fn get_session_storage_info(
    project_slug: Option<String>,
) -> Result<SessionStorageInfo, String> {
    let context = detect_session_context(project_slug.as_deref())?;

    Ok(SessionStorageInfo {
        orchestra_root: context.orchestra_root.display().to_string(),
        project_slug: context.project_slug,
        session_dir: context.session_dir.display().to_string(),
    })
}

#[tauri::command]
pub fn get_pi_executable_diagnostic(state: State<'_, AppState>) -> PiExecutableDiagnostic {
    match resolve_pi_executable(None) {
        Ok(path) => PiExecutableDiagnostic {
            resolved_path: Some(path.display().to_string()),
            error: None,
        },
        Err(error) => {
            state.log(
                "error",
                "pi.executable.resolve",
                &format!("Unable to resolve pi executable: {error}"),
            );
            PiExecutableDiagnostic {
                resolved_path: None,
                error: Some(error),
            }
        }
    }
}

#[tauri::command]
pub async fn list_pi_models(state: State<'_, AppState>) -> Result<Vec<SessionModel>, String> {
    let result = tauri::async_runtime::spawn_blocking(list_available_models)
        .await
        .map_err(|error| format!("Unable to join PI model discovery task: {error}"))?;

    if let Err(error) = &result {
        state.log(
            "error",
            "pi.models.load",
            &format!("Unable to load PI models: {error}"),
        );
    }

    result
}

fn format_logs_as_text(logs: &[LogEntry]) -> String {
    logs.iter()
        .map(|entry| {
            format!(
                "[{}] {} ({}): {}",
                entry.level.to_uppercase(),
                entry.timestamp,
                entry.target,
                entry.message.replace('\n', " ").trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

fn open_directory(path: &Path) -> Result<(), String> {
    #[cfg(target_os = "windows")]
    {
        Command::new("explorer")
            .arg(path)
            .spawn()
            .map_err(|error| format!("Unable to open {} in Explorer: {error}", path.display()))?;
        return Ok(());
    }

    #[cfg(target_os = "macos")]
    {
        Command::new("open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("Unable to open {} in Finder: {error}", path.display()))?;
        return Ok(());
    }

    #[cfg(all(unix, not(target_os = "macos")))]
    {
        Command::new("xdg-open")
            .arg(path)
            .spawn()
            .map_err(|error| format!("Unable to open {} with xdg-open: {error}", path.display()))?;
        return Ok(());
    }

    #[allow(unreachable_code)]
    Err(format!(
        "Opening directories is not supported on this platform for {}",
        path.display()
    ))
}
