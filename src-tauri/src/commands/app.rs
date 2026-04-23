use std::{
    collections::BTreeSet,
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
        PiImportLegacyResult, PiLegacyImportPreview, PiOAuthFlowState, PiRuntimeDiagnostics,
        PiRuntimeSettings, PiSetupState, ProjectUpsertInput, RoleUpsertInput, SessionModel,
        SessionStorageInfo, SystemNotificationEnvironmentStatus, SystemNotificationPermissionState,
        SystemNotificationRequest, TaskUpsertInput, WorkflowLaneInput, WorkflowUpsertInput,
    },
    services::{
        app_events, database, harness_settings,
        orchestra_paths::default_orchestra_root,
        pi_oauth, pi_runtime,
        pi_sessions::{
            detect_session_context, find_session_context_for_session, get_session_path,
            list_available_models,
        },
        pi_setup, projects, roles, system_notifications, tasks, workflows,
    },
    state::AppState,
};

pub fn build_app_info(state: &AppState) -> AppInfo {
    let version = env!("CARGO_PKG_VERSION");
    let hash = option_env!("ORCHESTRA_GIT_HASH").unwrap_or("dev");
    let pi_runtime_diagnostics = crate::services::pi_runtime::get_pi_runtime_diagnostics()
        .unwrap_or_else(|error| PiRuntimeDiagnostics {
            runtime: crate::models::PiRuntimeStatus {
                available: false,
                source: if crate::services::pi_runtime::is_packaged_mode() {
                    "bundled".into()
                } else {
                    "external".into()
                },
                packaged_mode: crate::services::pi_runtime::is_packaged_mode(),
                resolved_path: None,
                error: Some(error.clone()),
                message: error.clone(),
            },
            auth: crate::models::PiAuthStatus {
                configured: false,
                agent_dir: "<unavailable>".into(),
                auth_path: "<unavailable>".into(),
                models_path: "<unavailable>".into(),
                settings_path: "<unavailable>".into(),
                auth_exists: false,
                models_exists: false,
                legacy_agent_dir: None,
                legacy_auth_available: false,
                legacy_models_available: false,
                auth_imported_at: None,
                models_imported_at: None,
                message: error.clone(),
            },
            add_ons: crate::models::PiAddOnPolicyStatus {
                packaged_mode: crate::services::pi_runtime::is_packaged_mode(),
                allowed: true,
                extra_extensions: Vec::new(),
                blocked_extensions: Vec::new(),
                message: error,
            },
        });
    let dispatch_blocked_reason = pi_runtime_diagnostics.runtime.error.clone().or_else(|| {
        match state.sync_pi_runtime_health() {
            Ok(_) => pi_setup::require_pi_setup_ready().err(),
            Err(error) => Some(error),
        }
    });
    AppInfo {
        app_name: "Orchestra".into(),
        environment: "tauri".into(),
        backend_status: "connected".into(),
        version_display: format!("{}-{}", version, hash),
        dispatch_blocked: dispatch_blocked_reason.is_some(),
        dispatch_blocked_reason,
        pi_runtime_diagnostics,
    }
}

#[tauri::command]
pub fn get_app_info(state: State<'_, AppState>) -> AppInfo {
    build_app_info(state.inner())
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
pub fn export_logs_bundle(
    state: State<'_, AppState>,
    include_related_session_snapshot: Option<bool>,
) -> Result<String, String> {
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
    let include_related_session_snapshot = include_related_session_snapshot.unwrap_or(false);

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

    let (included_session_ids, missing_session_ids) = if include_related_session_snapshot {
        let session_ids = collect_related_session_ids(&logs, &bridge_diagnostics);
        let mut included = Vec::new();
        let mut missing = Vec::new();
        for session_id in session_ids {
            match add_session_file_to_zip(&mut zip, options, &session_id) {
                Ok(true) => included.push(session_id),
                Ok(false) => missing.push(session_id),
                Err(error) => return Err(error),
            }
        }
        add_database_snapshot_to_zip(&mut zip, options, &database_path)?;
        (included, missing)
    } else {
        (Vec::new(), Vec::new())
    };

    let metadata_json = serde_json::to_vec_pretty(&json!({
        "createdAt": timestamp.to_rfc3339(),
        "appName": "Orchestra",
        "version": env!("CARGO_PKG_VERSION"),
        "gitHash": option_env!("ORCHESTRA_GIT_HASH").unwrap_or("dev"),
        "databasePath": database_path.display().to_string(),
        "bundlePath": bundle_path.display().to_string(),
        "logCount": logs.len(),
        "includeRelatedSessionSnapshot": include_related_session_snapshot,
        "includedSessionIds": included_session_ids,
        "missingSessionIds": missing_session_ids,
        "includesDatabaseSnapshot": include_related_session_snapshot,
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
pub fn get_pi_runtime_settings() -> Result<PiRuntimeSettings, String> {
    harness_settings::get_pi_runtime_settings()
}

#[tauri::command]
pub fn update_pi_runtime_settings(
    extra_extensions: Vec<String>,
    default_compaction_window: Option<String>,
) -> Result<PiRuntimeSettings, String> {
    harness_settings::update_pi_runtime_settings(extra_extensions, default_compaction_window)
}

#[tauri::command]
pub fn get_pi_setup_state() -> Result<PiSetupState, String> {
    pi_setup::get_pi_setup_state()
}

#[tauri::command]
pub fn preview_pi_legacy_import() -> Result<PiLegacyImportPreview, String> {
    pi_setup::preview_legacy_import()
}

#[tauri::command]
pub fn get_pi_models_json() -> Result<String, String> {
    pi_setup::get_models_json()
}

#[tauri::command]
pub fn set_pi_provider_api_key(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
    api_key: String,
) -> Result<PiSetupState, String> {
    let result = pi_setup::set_provider_api_key(&provider_id, &api_key)?;
    state.log(
        "info",
        "pi.setup.api_key.saved",
        &format!(
            "Saved Orchestra-managed API key for provider {}",
            provider_id
        ),
    );
    let _ = app_events::emit_window_event(
        &app,
        "orchestra:pi-setup-change",
        &json!({ "reason": "pi.setup.api_key.saved" }),
    );
    Ok(result)
}

#[tauri::command]
pub fn remove_pi_provider_credential(
    app: AppHandle,
    state: State<'_, AppState>,
    provider_id: String,
) -> Result<PiSetupState, String> {
    let result = pi_setup::remove_provider_credential(&provider_id)?;
    pi_oauth::clear_finished_flow_for_provider(&app, &provider_id)?;
    state.log(
        "info",
        "pi.setup.credential.removed",
        &format!(
            "Removed Orchestra-managed Pi credential for provider {}",
            provider_id
        ),
    );
    let _ = app_events::emit_window_event(
        &app,
        "orchestra:pi-setup-change",
        &json!({ "reason": "pi.setup.credential.removed", "providerId": provider_id }),
    );
    Ok(result)
}

#[tauri::command]
pub fn save_pi_models_json(
    app: AppHandle,
    state: State<'_, AppState>,
    content: String,
) -> Result<PiSetupState, String> {
    let result = pi_setup::save_models_json(&content)?;
    state.log(
        "info",
        "pi.setup.models.saved",
        "Saved Orchestra-managed Pi models.json",
    );
    let _ = app_events::emit_window_event(
        &app,
        "orchestra:pi-setup-change",
        &json!({ "reason": "pi.setup.models.saved" }),
    );
    Ok(result)
}

#[tauri::command]
pub fn import_pi_legacy_config(
    app: AppHandle,
    state: State<'_, AppState>,
    replace_existing: Option<bool>,
) -> Result<PiSetupState, String> {
    let result = pi_setup::import_legacy_config(replace_existing.unwrap_or(false))?;
    state.log(
        "info",
        "pi.setup.legacy.imported",
        "Imported legacy ~/.pi/agent config into Orchestra-managed Pi storage",
    );
    let _ = app_events::emit_window_event(
        &app,
        "orchestra:pi-setup-change",
        &json!({ "reason": "pi.setup.legacy.imported" }),
    );
    Ok(result)
}

#[tauri::command]
pub fn dismiss_pi_legacy_import(
    app: AppHandle,
    state: State<'_, AppState>,
) -> Result<PiSetupState, String> {
    let result = pi_setup::dismiss_legacy_import()?;
    state.log(
        "info",
        "pi.setup.legacy.dismissed",
        "Dismissed the legacy Pi import prompt for Orchestra-managed Pi setup",
    );
    let _ = app_events::emit_window_event(
        &app,
        "orchestra:pi-setup-change",
        &json!({ "reason": "pi.setup.legacy.dismissed" }),
    );
    Ok(result)
}

#[tauri::command]
pub fn get_pi_oauth_flow_state() -> Result<Option<PiOAuthFlowState>, String> {
    pi_oauth::get_flow_state()
}

#[tauri::command]
pub fn start_pi_oauth_flow(
    app: AppHandle,
    provider_id: String,
    method_id: Option<String>,
) -> Result<PiOAuthFlowState, String> {
    pi_oauth::start_flow(app, &provider_id, method_id.as_deref())
}

#[tauri::command]
pub fn submit_pi_oauth_flow_input(
    app: AppHandle,
    value: String,
) -> Result<PiOAuthFlowState, String> {
    pi_oauth::submit_flow_input(app, &value)
}

#[tauri::command]
pub fn cancel_pi_oauth_flow(app: AppHandle) -> Result<Option<PiOAuthFlowState>, String> {
    pi_oauth::cancel_flow(app)
}

#[tauri::command]
pub fn dismiss_pi_oauth_flow(app: AppHandle) -> Result<Option<PiOAuthFlowState>, String> {
    pi_oauth::dismiss_flow(app)
}

#[tauri::command]
pub fn get_pi_executable_diagnostic(state: State<'_, AppState>) -> PiExecutableDiagnostic {
    let diagnostic = pi_runtime::current_pi_runtime_health();
    if let Some(error) = diagnostic.error_message.as_ref() {
        state.log(
            "error",
            "pi.runtime.resolve",
            &format!("Unable to resolve Pi runtime: {error}"),
        );
    }
    diagnostic
}

#[tauri::command]
pub fn get_pi_runtime_diagnostics() -> Result<PiRuntimeDiagnostics, String> {
    crate::services::pi_runtime::get_pi_runtime_diagnostics()
}

#[tauri::command]
pub fn import_legacy_pi_configuration(
    import_auth: bool,
    import_models: bool,
) -> Result<PiImportLegacyResult, String> {
    crate::services::pi_runtime::import_legacy_pi_configuration(import_auth, import_models)
}

#[derive(Debug, Clone, serde::Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DebugTaskWhipScenario {
    pub project_id: String,
    pub project_name: String,
    pub role_id: String,
    pub task_id: String,
    pub session_id: String,
}

#[tauri::command]
pub fn debug_seed_idle_task_whip_scenario() -> Result<DebugTaskWhipScenario, String> {
    let mut connection = database::open_connection()?;
    let task_prefix_suffix = uuid::Uuid::new_v4().simple().to_string();
    let project = projects::create_project(
        &mut connection,
        ProjectUpsertInput {
            name: format!("Whip Debug Project {}", uuid::Uuid::new_v4().simple()),
            description: Some("Seeded idle task whip debug scenario.".into()),
            task_prefix: format!("WD{}", &task_prefix_suffix[..4]).to_uppercase(),
        },
    )?;
    let role = roles::create_role(
        &mut connection,
        RoleUpsertInput {
            name: format!("Whip Worker {}", uuid::Uuid::new_v4().simple()),
            description: Some("Seeded role for automatic whip testing.".into()),
            system_prompt: Some(
                "You are a seeded test worker. Do not complete tasks automatically.".into(),
            ),
            provider: None,
            model: None,
            thinking_level: Some("medium".into()),
            capacity: 1,
            compaction_window: None,
            policy_ids: Vec::new(),
            direct_permissions: Vec::new(),
        },
    )?;
    let lane_id = format!("lane-{}", uuid::Uuid::new_v4().simple());
    let workflow = workflows::create_workflow(
        &mut connection,
        WorkflowUpsertInput {
            name: format!("Whip Debug Flow {}", uuid::Uuid::new_v4().simple()),
            description: Some("Single role lane for automatic whip testing.".into()),
            lanes: vec![WorkflowLaneInput {
                id: Some(lane_id.clone()),
                key: "implement".into(),
                name: "Implement".into(),
                description: None,
                order: Some(0),
                assigned_entity_type: "role".into(),
                assigned_entity_id: Some(role.slug.clone()),
                entry_prompt_template: Some(
                    "Stay assigned and wait for follow-up instructions.".into(),
                ),
                use_separate_worktree: false,
                require_user_approval_on_success: false,
                success_transition_type: "end".into(),
                success_target_lane_id: None,
                failure_transition_type: "end".into(),
                failure_target_lane_id: None,
            }],
        },
    )?;
    let task = tasks::create_task(
        &mut connection,
        Some(&project.id),
        TaskUpsertInput {
            title: "Seeded automatic whip task".into(),
            description: Some(
                "Task with an assigned idle role session that should be whipped automatically."
                    .into(),
            ),
            task_type: "task".into(),
            tags: Vec::new(),
            status: "in_progress".into(),
            priority: "P1".into(),
            workflow_id: Some(workflow.id.clone()),
            current_lane_id: Some(lane_id.clone()),
            assignee_type: "role".into(),
            assignee_id: Some(role.slug.clone()),
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: Some(10),
            archived: None,
        },
    )?;

    let context = crate::services::pi_sessions::session_context_for_project_id(&project.id)?;
    let runtime_cwd = context.project_root.join("seeded-whip-runtime");
    std::fs::create_dir_all(&runtime_cwd).map_err(|error| {
        format!(
            "Unable to create seeded whip runtime directory {}: {error}",
            runtime_cwd.display()
        )
    })?;
    let created_session = crate::services::pi_sessions::create_session_file(
        &runtime_cwd,
        &context.session_dir,
        Some("Seeded whip idle session"),
        false,
    )?;
    let session_id = created_session.record.id.clone();
    let now = crate::state::now_iso();
    let queue_entry_id = format!("queue-{}", uuid::Uuid::new_v4().simple());
    let role_instance_id = format!("instance-{}", uuid::Uuid::new_v4().simple());
    let assignment_id = format!("task-assignment-{}", uuid::Uuid::new_v4().simple());

    connection.execute(
        "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES (?1, ?2, ?3, 'running', ?4, ?5, ?6, NULL, NULL, ?7, ?7)",
        rusqlite::params![role_instance_id, role.id, role.name, queue_entry_id, session_id, runtime_cwd.display().to_string(), now.as_str()],
    ).map_err(|error| format!("Unable to seed role instance for task whip scenario: {error}"))?;
    connection.execute(
        "INSERT INTO role_queue_entries (id, role_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, title, summary, entry_prompt, assigned_instance_id, created_at, updated_at, started_at, completed_at) VALUES (?1, ?2, 'assigned', 'workflow_lane', ?3, ?4, ?5, ?6, NULL, ?7, ?8, ?9, ?9, ?9, NULL)",
        rusqlite::params![queue_entry_id, role.id, task.id, workflow.id, lane_id, format!("{} · {}", task.number, task.title), "Seeded whip prompt", role_instance_id, now.as_str()],
    ).map_err(|error| format!("Unable to seed role queue entry for task whip scenario: {error}"))?;
    connection.execute(
        "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 'role', ?5, 'active', ?6, ?7, ?8, ?9, ?10, 0, NULL, ?11, NULL, ?11, ?11)",
        rusqlite::params![assignment_id, task.id, workflow.id, lane_id, role.id, session_id, runtime_cwd.display().to_string(), queue_entry_id, role_instance_id, "Seeded idle assignment prompt", now.as_str()],
    ).map_err(|error| format!("Unable to seed task lane assignment for task whip scenario: {error}"))?;
    connection.execute(
        "INSERT INTO task_lane_runs (id, task_id, lane_id, session_id, result, notes, started_at, completed_at) VALUES (?1, ?2, ?3, ?4, 'needs_user', NULL, ?5, NULL)",
        rusqlite::params![format!("lane-run-{}", uuid::Uuid::new_v4().simple()), task.id, lane_id, session_id, now.as_str()],
    ).map_err(|error| format!("Unable to seed lane run for task whip scenario: {error}"))?;

    Ok(DebugTaskWhipScenario {
        project_id: project.id,
        project_name: project.name,
        role_id: role.id,
        task_id: task.id,
        session_id,
    })
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

#[tauri::command]
pub fn get_system_notification_environment_status() -> SystemNotificationEnvironmentStatus {
    system_notifications::get_environment_status()
}

#[tauri::command]
pub async fn get_system_notification_permission_state(
    state: State<'_, AppState>,
) -> Result<SystemNotificationPermissionState, String> {
    let result = tauri::async_runtime::spawn_blocking(system_notifications::get_permission_state)
        .await
        .map_err(|error| format!("Unable to join notification permission task: {error}"))?;

    if let Err(error) = &result {
        state.log(
            "error",
            "notifications.permission_state",
            &format!("Unable to read system notification permission state: {error}"),
        );
    }

    result
}

#[tauri::command]
pub async fn request_system_notification_permission(
    state: State<'_, AppState>,
) -> Result<SystemNotificationPermissionState, String> {
    let result = tauri::async_runtime::spawn_blocking(system_notifications::request_permission)
        .await
        .map_err(|error| format!("Unable to join notification permission request task: {error}"))?;

    match &result {
        Ok(permission) => state.log(
            "info",
            "notifications.permission_request",
            &format!(
                "System notification permission request resolved to {:?}",
                permission
            ),
        ),
        Err(error) => state.log(
            "error",
            "notifications.permission_request",
            &format!("Unable to request system notification permission: {error}"),
        ),
    }

    result
}

#[tauri::command]
pub async fn send_system_notification(
    state: State<'_, AppState>,
    request: SystemNotificationRequest,
) -> Result<bool, String> {
    let request_for_task = request.clone();
    let result =
        tauri::async_runtime::spawn_blocking(move || system_notifications::send(&request_for_task))
            .await
            .map_err(|error| {
                format!("Unable to join system notification delivery task: {error}")
            })?;

    match &result {
        Ok(true) => state.log(
            "info",
            "notifications.send",
            &format!("Delivered system notification {:?}", request.tag),
        ),
        Ok(false) => state.log(
            "info",
            "notifications.send",
            &format!(
                "System notification transport unavailable for {:?}",
                request.tag
            ),
        ),
        Err(error) => state.log(
            "error",
            "notifications.send",
            &format!(
                "Unable to deliver system notification {:?}: {error}",
                request.tag
            ),
        ),
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

fn collect_related_session_ids(
    logs: &[LogEntry],
    bridge_diagnostics: &BridgeDiagnostics,
) -> Vec<String> {
    let mut session_ids = BTreeSet::new();
    for entry in logs {
        collect_session_ids_from_text(&entry.message, &mut session_ids);
        collect_session_ids_from_text(&entry.target, &mut session_ids);
    }
    for client in &bridge_diagnostics.clients {
        if let Some(session_id) = &client.session_id {
            session_ids.insert(session_id.clone());
        }
    }
    for request in &bridge_diagnostics.recent_requests {
        if let Some(session_id) = &request.session_id {
            session_ids.insert(session_id.clone());
        }
    }
    session_ids.into_iter().collect()
}

fn collect_session_ids_from_text(text: &str, session_ids: &mut BTreeSet<String>) {
    for token in text
        .split(|ch: char| !(ch.is_ascii_hexdigit() || ch == '-'))
        .filter(|token| token.len() >= 32)
    {
        if uuid::Uuid::parse_str(token).is_ok() {
            session_ids.insert(token.to_string());
        }
    }
}

fn add_session_file_to_zip(
    zip: &mut ZipWriter<File>,
    options: FileOptions,
    session_id: &str,
) -> Result<bool, String> {
    let session_context = match find_session_context_for_session(session_id) {
        Ok(context) => context,
        Err(_) => return Ok(false),
    };
    let session_path = match get_session_path(&session_context.session_dir, session_id) {
        Ok(path) => path,
        Err(_) => return Ok(false),
    };
    let session_bytes = std::fs::read(&session_path).map_err(|error| {
        format!(
            "Unable to read session file {}: {error}",
            session_path.display()
        )
    })?;
    zip.start_file(format!("sessions/{session_id}.jsonl"), options)
        .map_err(|error| {
            format!(
                "Unable to add session {} to log bundle: {error}",
                session_id
            )
        })?;
    zip.write_all(&session_bytes).map_err(|error| {
        format!(
            "Unable to write session {} to log bundle: {error}",
            session_id
        )
    })?;
    Ok(true)
}

fn add_database_snapshot_to_zip(
    zip: &mut ZipWriter<File>,
    options: FileOptions,
    database_path: &Path,
) -> Result<(), String> {
    let snapshot_bytes = std::fs::read(database_path).map_err(|error| {
        format!(
            "Unable to read database snapshot {}: {error}",
            database_path.display()
        )
    })?;
    zip.start_file("orchestra.db", options)
        .map_err(|error| format!("Unable to add orchestra.db to log bundle: {error}"))?;
    zip.write_all(&snapshot_bytes)
        .map_err(|error| format!("Unable to write orchestra.db to log bundle: {error}"))?;
    Ok(())
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
