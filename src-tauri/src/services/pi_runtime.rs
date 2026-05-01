use std::{
    collections::{HashMap, HashSet},
    env, fs,
    path::{Path, PathBuf},
    process::Command,
    sync::{Mutex, OnceLock},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};
use tauri::{path::BaseDirectory, AppHandle, Manager};

use crate::{
    models::{
        PiAddOnPolicyStatus, PiAuthStatus, PiImportLegacyResult, PiRuntimeDiagnostics,
        PiRuntimeHealth, PiRuntimeStatus,
    },
    services::{
        harness_settings,
        orchestra_paths::{
            default_orchestra_root, orchestra_pi_auth_path, orchestra_pi_models_path,
            orchestra_pi_settings_path, pi_agent_dir,
        },
    },
};

static APP_HANDLE: OnceLock<AppHandle> = OnceLock::new();
static BUNDLED_RUNTIME_CACHE: OnceLock<
    Mutex<HashMap<String, Result<Option<ResolvedPiRuntime>, PiRuntimeHealth>>>,
> = OnceLock::new();

fn bundled_runtime_cache(
) -> &'static Mutex<HashMap<String, Result<Option<ResolvedPiRuntime>, PiRuntimeHealth>>> {
    BUNDLED_RUNTIME_CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

#[derive(Debug, Clone)]
pub struct ResolvedPiRuntime {
    pub source: String,
    pub mode: String,
    pub executable_path: PathBuf,
    pub package_dir: Option<PathBuf>,
    pub bundled_bun_path: Option<PathBuf>,
    pub agent_dir: PathBuf,
    pub version: Option<String>,
    pub built_at: Option<String>,
    pub manifest_path: Option<PathBuf>,
}

#[derive(Debug, Clone)]
pub struct ResolvedPiRuntimeContext {
    pub executable_path: PathBuf,
    pub runtime_source: String,
    pub packaged_mode: bool,
    pub orchestra_root: PathBuf,
    pub pi_agent_dir: PathBuf,
    pub pi_auth_path: PathBuf,
    pub pi_models_path: PathBuf,
    pub pi_settings_path: PathBuf,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum RuntimeMode {
    Development,
    Packaged,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledPiRuntimeManifest {
    schema_version: u32,
    source: String,
    platform: String,
    arch: String,
    package_name: String,
    package_version: String,
    runtime_version: Option<String>,
    orchestra_pack_version: u32,
    executable_relative_path: String,
    package_dir_relative_path: String,
    #[serde(default)]
    bundled_bun_relative_path: Option<String>,
    #[serde(default)]
    notice_relative_path: Option<String>,
    #[serde(default)]
    sbom_relative_path: Option<String>,
    #[serde(default)]
    files: Vec<BundledPiRuntimeManifestFile>,
    built_at: Option<String>,
    notes: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
struct BundledPiRuntimeManifestFile {
    path: String,
    sha256: String,
    #[serde(default)]
    executable: bool,
}

pub fn register_app_handle(app: AppHandle) {
    let _ = APP_HANDLE.set(app);
}

pub fn is_packaged_mode() -> bool {
    runtime_mode() == RuntimeMode::Packaged
}

pub fn resolve_pi_runtime_context(
    preferred: Option<&Path>,
) -> Result<ResolvedPiRuntimeContext, String> {
    let orchestra_root = default_orchestra_root()?;
    let runtime = resolve_pi_runtime(preferred)?;
    Ok(ResolvedPiRuntimeContext {
        executable_path: runtime.executable_path,
        runtime_source: runtime.source,
        packaged_mode: runtime.mode == RuntimeMode::Packaged.as_str(),
        pi_agent_dir: runtime.agent_dir,
        pi_auth_path: orchestra_pi_auth_path(&orchestra_root),
        pi_models_path: orchestra_pi_models_path(&orchestra_root),
        pi_settings_path: orchestra_pi_settings_path(&orchestra_root),
        orchestra_root,
    })
}

pub fn ensure_pi_agent_dir(agent_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi agent directory {}: {error}",
            agent_dir.display()
        )
    })
}

pub fn apply_pi_runtime_environment(
    command: &mut Command,
    context: &ResolvedPiRuntimeContext,
) -> Result<(), String> {
    ensure_pi_agent_dir(&context.pi_agent_dir)?;
    command.env("PI_CODING_AGENT_DIR", &context.pi_agent_dir);
    Ok(())
}

pub fn legacy_pi_agent_dir() -> Option<PathBuf> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| home.join(".pi").join("agent"))
        .filter(|path| path.exists())
}

pub fn current_pi_runtime_health() -> PiRuntimeHealth {
    match resolve_pi_runtime_internal(None) {
        Ok(runtime) => runtime.health(),
        Err(health) => health,
    }
}

pub fn resolve_pi_runtime(preferred: Option<&Path>) -> Result<ResolvedPiRuntime, String> {
    resolve_pi_runtime_internal(preferred).map_err(|health| {
        health
            .error_message
            .unwrap_or_else(|| "Unable to resolve a usable Pi runtime".into())
    })
}

pub fn apply_runtime_environment(
    command: &mut Command,
    runtime: &ResolvedPiRuntime,
    agent_dir_override: Option<&Path>,
) {
    command.env_remove("PI_PACKAGE_DIR");
    for (key, value) in runtime_environment_variables(runtime, agent_dir_override) {
        command.env(key, value);
    }
}

pub fn runtime_environment_variables(
    runtime: &ResolvedPiRuntime,
    agent_dir_override: Option<&Path>,
) -> Vec<(String, String)> {
    let agent_dir = agent_dir_override.unwrap_or(&runtime.agent_dir);
    let npm_prefix_dir = runtime_managed_npm_prefix_dir(agent_dir);
    let npm_prefix = npm_prefix_dir.display().to_string();
    let mut environment = vec![
        (
            "PI_CODING_AGENT_DIR".to_string(),
            agent_dir.display().to_string(),
        ),
        ("NPM_CONFIG_PREFIX".to_string(), npm_prefix.clone()),
        ("npm_config_prefix".to_string(), npm_prefix),
    ];

    if runtime.source == "bundled" {
        if let Some(package_dir) = runtime.package_dir.as_ref() {
            environment.push((
                "PI_PACKAGE_DIR".to_string(),
                package_dir.display().to_string(),
            ));
        }
    }

    if runtime.bundled_bun_path.is_some() {
        if let Some(path_value) = resolve_effective_subprocess_path(Some(runtime)) {
            environment.push(("PATH".to_string(), path_value));
        }
    }

    environment
}

pub fn resolve_effective_subprocess_path(runtime: Option<&ResolvedPiRuntime>) -> Option<String> {
    let mut directories = runtime
        .and_then(|resolved| resolved.bundled_bun_path.as_ref())
        .and_then(|path| path.parent())
        .map(|directory| vec![directory.to_path_buf()])
        .unwrap_or_default();
    let base_path = resolve_user_shell_path()
        .or_else(|| env::var("PATH").ok())
        .unwrap_or_default();
    directories.extend(env::split_paths(&base_path));

    if directories.is_empty() {
        return None;
    }

    let mut seen = HashSet::new();
    directories
        .retain(|directory| !directory.as_os_str().is_empty() && seen.insert(directory.clone()));

    env::join_paths(directories)
        .ok()
        .map(|value| value.to_string_lossy().into_owned())
}

fn runtime_managed_npm_prefix_dir(agent_dir: &Path) -> PathBuf {
    agent_dir.parent().unwrap_or(agent_dir).join("npm")
}

pub fn user_shell() -> Result<PathBuf, String> {
    user_shell_candidates().into_iter().next().ok_or_else(|| {
        "Unable to locate a usable login shell for Orchestra subprocesses".to_string()
    })
}

pub fn resolve_user_shell_environment() -> Option<HashMap<String, String>> {
    for shell in user_shell_candidates() {
        let Ok(output) = run_shell_command(&shell, "env -0") else {
            continue;
        };
        if !output.status.success() {
            continue;
        }
        let parsed = parse_shell_environment(&output.stdout);
        if !parsed.is_empty() {
            return Some(parsed);
        }
    }

    None
}

pub fn resolve_user_shell_path() -> Option<String> {
    resolve_user_shell_environment().and_then(|environment| environment.get("PATH").cloned())
}

pub fn apply_user_shell_environment(command: &mut Command) {
    if let Some(environment) = resolve_user_shell_environment() {
        command.env_clear();
        for (key, value) in environment {
            command.env(key, value);
        }
    }
}

pub fn get_pi_runtime_diagnostics() -> Result<PiRuntimeDiagnostics, String> {
    let orchestra_root = default_orchestra_root()?;
    let packaged_mode = is_packaged_mode();
    let agent_dir = pi_agent_dir(&orchestra_root);
    ensure_pi_agent_dir(&agent_dir)?;
    let auth_path = orchestra_pi_auth_path(&orchestra_root);
    let models_path = orchestra_pi_models_path(&orchestra_root);
    let settings_path = orchestra_pi_settings_path(&orchestra_root);
    let legacy_agent_dir = legacy_pi_agent_dir();
    let migration = harness_settings::get_pi_migration_state(&orchestra_root)?;
    let runtime_health = current_pi_runtime_health();

    let runtime = PiRuntimeStatus {
        available: runtime_health.status == "healthy",
        source: runtime_health.source.clone(),
        packaged_mode,
        resolved_path: runtime_health.resolved_path.clone(),
        error: runtime_health.error_message.clone(),
        message: if runtime_health.status == "healthy" {
            format!(
                "Pi runtime resolved from {} at {}.",
                runtime_health.source,
                runtime_health
                    .resolved_path
                    .as_deref()
                    .unwrap_or("<unknown>")
            )
        } else if packaged_mode {
            "Bundled Pi runtime unavailable.".into()
        } else {
            "Pi runtime unavailable.".into()
        },
    };

    let auth_exists = auth_path.exists();
    let models_exists = models_path.exists();
    let legacy_auth_available = legacy_agent_dir
        .as_ref()
        .map(|dir| dir.join("auth.json").exists())
        .unwrap_or(false);
    let legacy_models_available = legacy_agent_dir
        .as_ref()
        .map(|dir| dir.join("models.json").exists())
        .unwrap_or(false);
    let configured = auth_exists;
    let auth_message = if configured {
        if models_exists {
            format!(
                "Orchestra is using auth.json and models.json from {}.",
                agent_dir.display()
            )
        } else {
            format!(
                "Orchestra is using auth.json from {}. No Orchestra-managed models.json is present yet.",
                agent_dir.display()
            )
        }
    } else if legacy_auth_available || legacy_models_available {
        format!(
            "Orchestra Pi auth is not configured yet. Import legacy auth/models from {} into {}.",
            legacy_agent_dir
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "~/.pi/agent".into()),
            agent_dir.display()
        )
    } else {
        format!(
            "Orchestra Pi auth is not configured yet. Orchestra now uses {} instead of ~/.pi/agent.",
            agent_dir.display()
        )
    };
    let auth = PiAuthStatus {
        configured,
        agent_dir: agent_dir.display().to_string(),
        auth_path: auth_path.display().to_string(),
        models_path: models_path.display().to_string(),
        settings_path: settings_path.display().to_string(),
        auth_exists,
        models_exists,
        legacy_agent_dir: legacy_agent_dir
            .as_ref()
            .map(|path| path.display().to_string()),
        legacy_auth_available,
        legacy_models_available,
        auth_imported_at: migration.auth_imported_at,
        models_imported_at: migration.models_imported_at,
        message: auth_message,
    };

    let settings = harness_settings::get_pi_runtime_settings_in(&orchestra_root)?;
    let blocked_extensions =
        harness_settings::blocked_packaged_mode_extensions(&settings.extra_extensions);
    let add_ons = PiAddOnPolicyStatus {
        packaged_mode,
        allowed: blocked_extensions.is_empty(),
        extra_extensions: settings.extra_extensions.clone(),
        blocked_extensions: blocked_extensions.clone(),
        message: if blocked_extensions.is_empty() {
            if packaged_mode {
                "Packaged mode allows only explicit local filesystem paths for extra Pi runtime extensions.".into()
            } else {
                "Development mode allows free-form Pi extension entries.".into()
            }
        } else {
            format!(
                "Packaged Orchestra blocked unsupported extension entries: {}.",
                blocked_extensions.join(", ")
            )
        },
    };

    Ok(PiRuntimeDiagnostics {
        runtime,
        auth,
        add_ons,
    })
}

pub fn import_legacy_pi_configuration(
    import_auth: bool,
    import_models: bool,
) -> Result<PiImportLegacyResult, String> {
    let orchestra_root = default_orchestra_root()?;
    let agent_dir = pi_agent_dir(&orchestra_root);
    ensure_pi_agent_dir(&agent_dir)?;
    let legacy_agent_dir = legacy_pi_agent_dir()
        .ok_or_else(|| "No legacy Pi agent directory was found at ~/.pi/agent".to_string())?;

    let mut imported = Vec::new();
    let mut skipped = Vec::new();

    if import_auth {
        let source = legacy_agent_dir.join("auth.json");
        let destination = orchestra_pi_auth_path(&orchestra_root);
        if source.exists() {
            fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "Unable to import legacy auth.json from {} to {}: {error}",
                    source.display(),
                    destination.display()
                )
            })?;
            imported.push("auth.json".to_string());
        } else {
            skipped.push("auth.json (not found)".to_string());
        }
    }

    if import_models {
        let source = legacy_agent_dir.join("models.json");
        let destination = orchestra_pi_models_path(&orchestra_root);
        if source.exists() {
            fs::copy(&source, &destination).map_err(|error| {
                format!(
                    "Unable to import legacy models.json from {} to {}: {error}",
                    source.display(),
                    destination.display()
                )
            })?;
            imported.push("models.json".to_string());
        } else {
            skipped.push("models.json (not found)".to_string());
        }
    }

    if import_auth || import_models {
        harness_settings::record_legacy_pi_import(
            &orchestra_root,
            &legacy_agent_dir,
            imported.iter().any(|entry| entry == "auth.json"),
            imported.iter().any(|entry| entry == "models.json"),
        )?;
    }

    Ok(PiImportLegacyResult {
        imported,
        skipped,
        diagnostics: get_pi_runtime_diagnostics()?,
    })
}

pub fn classify_runtime_resolution_error(packaged_mode: bool, error: &str) -> String {
    if packaged_mode {
        format!("Bundled Pi runtime unavailable. {error}")
    } else {
        format!("Pi runtime unavailable. {error}")
    }
}

fn resolve_pi_runtime_internal(
    preferred: Option<&Path>,
) -> Result<ResolvedPiRuntime, PiRuntimeHealth> {
    let mode = runtime_mode();
    let mode_label = mode.as_str().to_string();
    let agent_dir = ensure_orchestra_pi_agent_dir().map_err(|error| {
        runtime_error(
            mode,
            "system",
            "runtime_storage_unavailable",
            error,
            None,
            None,
            None,
            Some(mode_label.clone()),
            None,
        )
    })?;

    if let Ok(value) = env::var("ORCHESTRA_PI_EXECUTABLE") {
        let candidate = PathBuf::from(value);
        if let Some(executable_path) = resolve_pi_candidate(&candidate) {
            return Ok(ResolvedPiRuntime {
                source: "override".into(),
                mode: mode_label,
                executable_path,
                package_dir: None,
                bundled_bun_path: None,
                agent_dir,
                version: None,
                built_at: None,
                manifest_path: None,
            });
        }

        return Err(runtime_error(
            mode,
            "override",
            "override_not_found",
            format!(
                "The ORCHESTRA_PI_EXECUTABLE override points to a missing Pi executable: {}",
                candidate.display()
            ),
            None,
            None,
            Some(&agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    match resolve_bundled_runtime(mode, &agent_dir) {
        Ok(Some(runtime)) => return Ok(runtime),
        Ok(None) => {}
        Err(error) => {
            if mode == RuntimeMode::Packaged {
                return Err(error);
            }
        }
    }

    if mode == RuntimeMode::Packaged {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_missing",
            "Packaged Orchestra could not find its bundled Pi runtime in app resources.".into(),
            None,
            None,
            Some(&agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    let executable_path = match resolve_system_pi(preferred) {
        Ok(path) => path,
        Err(searched) => {
            return Err(runtime_error(
                mode,
                "system",
                "system_runtime_not_found",
                format!(
                    "Unable to locate the pi executable in development mode. Checked: {}. Set ORCHESTRA_PI_EXECUTABLE to an explicit path if needed.",
                    searched_paths_summary(&searched)
                ),
                None,
                None,
                Some(&agent_dir),
                Some(mode_label),
                None,
            ));
        }
    };

    Ok(ResolvedPiRuntime {
        source: "system".into(),
        mode: mode.as_str().into(),
        executable_path,
        package_dir: None,
        bundled_bun_path: None,
        agent_dir,
        version: None,
        built_at: None,
        manifest_path: None,
    })
}

fn resolve_bundled_runtime(
    mode: RuntimeMode,
    agent_dir: &Path,
) -> Result<Option<ResolvedPiRuntime>, PiRuntimeHealth> {
    let Some(root) = bundled_runtime_root() else {
        return if mode == RuntimeMode::Packaged {
            Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_missing",
                "Packaged Orchestra could not resolve the bundled Pi runtime resource directory."
                    .into(),
                None,
                None,
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                None,
            ))
        } else {
            Ok(None)
        };
    };

    let cache_key = format!("{}:{}", mode.as_str(), root.display());
    if let Ok(cache) = bundled_runtime_cache().lock() {
        if let Some(cached) = cache.get(&cache_key).cloned() {
            return cached;
        }
    }

    let validated = validate_bundled_runtime_root(&root, mode, agent_dir).map(Some);
    if let Ok(mut cache) = bundled_runtime_cache().lock() {
        cache.insert(cache_key, validated.clone());
    }
    validated
}

fn validate_bundled_runtime_root(
    root: &Path,
    mode: RuntimeMode,
    agent_dir: &Path,
) -> Result<ResolvedPiRuntime, PiRuntimeHealth> {
    let manifest_path = root.join("manifest.json");
    if !manifest_path.exists() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_manifest_missing",
            format!(
                "Bundled Pi runtime manifest is missing: {}",
                manifest_path.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    let manifest_bytes = fs::read(&manifest_path).map_err(|error| {
        runtime_error(
            mode,
            "bundled",
            "bundled_runtime_manifest_invalid",
            format!(
                "Unable to read bundled Pi runtime manifest {}: {error}",
                manifest_path.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            None,
        )
    })?;
    let manifest: BundledPiRuntimeManifest =
        serde_json::from_slice(&manifest_bytes).map_err(|error| {
            runtime_error(
                mode,
                "bundled",
                "bundled_runtime_manifest_invalid",
                format!(
                    "Unable to parse bundled Pi runtime manifest {}: {error}",
                    manifest_path.display()
                ),
                None,
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                None,
            )
        })?;

    if manifest.schema_version != 1 {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_manifest_invalid",
            format!(
                "Bundled Pi runtime manifest schema {} is unsupported (expected 1).",
                manifest.schema_version
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            None,
        ));
    }

    if manifest.platform != expected_manifest_platform()
        || manifest.arch != expected_manifest_arch()
    {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_incompatible",
            format!(
                "Bundled Pi runtime targets {}/{} but Orchestra is running on {}/{}.",
                manifest.platform,
                manifest.arch,
                expected_manifest_platform(),
                expected_manifest_arch()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    let executable_path = root.join(&manifest.executable_relative_path);
    if !executable_path.exists() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_file_missing",
            format!(
                "Bundled Pi runtime executable is missing: {}",
                executable_path.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    if !is_executable(&executable_path) {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_unexecutable",
            format!(
                "Bundled Pi runtime executable is not runnable: {}",
                executable_path.display()
            ),
            Some(&executable_path),
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    let package_dir = root.join(&manifest.package_dir_relative_path);
    if !package_dir.exists() || !package_dir.is_dir() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_file_missing",
            format!(
                "Bundled Pi runtime package directory is missing: {}",
                package_dir.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    for (relative_path, description) in [
        ("dist/main.js", "runtime entrypoint"),
        (
            "dist/modes/interactive/theme/dark.json",
            "interactive dark theme asset",
        ),
    ] {
        let required_path = package_dir.join(relative_path);
        if !required_path.exists() {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_file_missing",
                format!(
                    "Bundled Pi runtime package directory is missing the required {description}: {}",
                    required_path.display()
                ),
                Some(&required_path),
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }
    }

    let bundled_bun_path = manifest
        .bundled_bun_relative_path
        .as_ref()
        .map(|relative_path| root.join(relative_path));
    if let Some(path) = bundled_bun_path.as_ref() {
        if !path.exists() {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_file_missing",
                format!("Bundled Bun executable is missing: {}", path.display()),
                None,
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }
        if !is_executable(path) {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_unexecutable",
                format!("Bundled Bun executable is not runnable: {}", path.display()),
                Some(path),
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }
    }

    for optional_path in [
        manifest.notice_relative_path.as_deref(),
        manifest.sbom_relative_path.as_deref(),
    ]
    .into_iter()
    .flatten()
    {
        let resolved_path = root.join(optional_path);
        if !resolved_path.exists() {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_file_missing",
                format!(
                    "Bundled Pi runtime manifest references a missing artifact: {}",
                    resolved_path.display()
                ),
                None,
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }
    }

    if manifest.files.is_empty() {
        return Err(runtime_error(
            mode,
            "bundled",
            "bundled_runtime_manifest_invalid",
            format!(
                "Bundled Pi runtime manifest {} does not include a verifiable file inventory.",
                manifest_path.display()
            ),
            None,
            Some(&manifest_path),
            Some(agent_dir),
            Some(mode.as_str().to_string()),
            Some(manifest.package_version.clone()),
        ));
    }

    for file in &manifest.files {
        let resolved_path = root.join(&file.path);
        if !resolved_path.exists() {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_file_missing",
                format!(
                    "Bundled Pi runtime manifest references a missing file: {}",
                    resolved_path.display()
                ),
                None,
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }

        if file.executable && !is_executable(&resolved_path) {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_unexecutable",
                format!(
                    "Bundled Pi runtime manifest requires an executable file, but it is not runnable: {}",
                    resolved_path.display()
                ),
                Some(&resolved_path),
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }

        let actual_sha256 = sha256_for_file(&resolved_path).map_err(|error| {
            runtime_error(
                mode,
                "bundled",
                "bundled_runtime_manifest_invalid",
                format!(
                    "Unable to hash bundled Pi runtime file {}: {error}",
                    resolved_path.display()
                ),
                Some(&resolved_path),
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            )
        })?;
        if !actual_sha256.eq_ignore_ascii_case(&file.sha256) {
            return Err(runtime_error(
                mode,
                "bundled",
                "bundled_runtime_checksum_mismatch",
                format!(
                    "Bundled Pi runtime file failed checksum verification: {} (expected {}, got {}).",
                    resolved_path.display(),
                    file.sha256,
                    actual_sha256,
                ),
                Some(&resolved_path),
                Some(&manifest_path),
                Some(agent_dir),
                Some(mode.as_str().to_string()),
                Some(manifest.package_version.clone()),
            ));
        }
    }

    let version = manifest
        .runtime_version
        .clone()
        .or_else(|| Some(manifest.package_version.clone()));
    let built_at = manifest.built_at.clone().or_else(|| {
        Some(format!(
            "pack:{} source:{}{}",
            manifest.orchestra_pack_version,
            manifest.source,
            manifest
                .notes
                .as_ref()
                .map(|value| format!(" ({value})"))
                .unwrap_or_default()
        ))
    });
    let _ = &manifest.package_name;

    Ok(ResolvedPiRuntime {
        source: "bundled".into(),
        mode: mode.as_str().into(),
        executable_path,
        package_dir: Some(package_dir),
        bundled_bun_path,
        agent_dir: agent_dir.to_path_buf(),
        version,
        built_at,
        manifest_path: Some(manifest_path),
    })
}

fn sha256_for_file(path: &Path) -> Result<String, String> {
    let bytes =
        fs::read(path).map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    Ok(format!("{:x}", Sha256::digest(bytes)))
}

fn bundled_runtime_root() -> Option<PathBuf> {
    if let Some(override_root) = env::var_os("ORCHESTRA_BUNDLED_PI_RUNTIME_ROOT") {
        let override_path = PathBuf::from(override_root);
        if !override_path.as_os_str().is_empty() {
            return Some(override_path);
        }
    }

    APP_HANDLE.get().and_then(|app| {
        app.path()
            .resolve("pi-runtime", BaseDirectory::Resource)
            .ok()
    })
}

fn resolve_system_pi(preferred: Option<&Path>) -> Result<PathBuf, Vec<String>> {
    let mut searched = Vec::new();

    if let Some(candidate) = preferred {
        if let Some(resolved) = resolve_pi_candidate(candidate) {
            return Ok(resolved);
        }
        searched.push(candidate.display().to_string());
    }

    if let Some(home) = env::var_os("HOME").map(PathBuf::from) {
        for candidate in [
            home.join(".npm-global/bin/pi"),
            home.join(".local/bin/pi"),
            home.join(".volta/bin/pi"),
            home.join(".pi/agent/bin/pi"),
            PathBuf::from("/opt/homebrew/bin/pi"),
        ] {
            if let Some(resolved) = resolve_pi_candidate(&candidate) {
                return Ok(resolved);
            }
            searched.push(candidate.display().to_string());
        }
    }

    if let Some(resolved) = resolve_pi_via_user_shell(&mut searched) {
        return Ok(resolved);
    }

    Err(searched)
}

fn resolve_pi_via_user_shell(searched: &mut Vec<String>) -> Option<PathBuf> {
    for shell in user_shell_candidates() {
        searched.push(format!("{} -lc 'command -v pi'", shell.display()));
        let Ok(output) = run_shell_command(&shell, "command -v pi") else {
            continue;
        };
        if !output.status.success() {
            continue;
        }

        let stdout = String::from_utf8_lossy(&output.stdout);
        for candidate in stdout
            .lines()
            .map(str::trim)
            .filter(|line| !line.is_empty())
        {
            if let Some(resolved) = resolve_pi_candidate(Path::new(candidate)) {
                return Some(resolved);
            }
        }
    }

    None
}

fn user_shell_candidates() -> Vec<PathBuf> {
    let mut shells = Vec::new();
    if let Ok(shell) = env::var("SHELL") {
        shells.push(PathBuf::from(shell));
    }
    shells.push(PathBuf::from("/bin/bash"));
    shells.push(PathBuf::from("/bin/zsh"));
    shells.push(PathBuf::from("/bin/sh"));

    let mut seen = HashSet::new();
    shells
        .into_iter()
        .filter(|shell| {
            let key = shell.display().to_string();
            seen.insert(key) && shell.exists()
        })
        .collect()
}

fn run_shell_command(shell: &Path, command: &str) -> Result<std::process::Output, std::io::Error> {
    if shell.file_name().and_then(|name| name.to_str()) == Some("fish") {
        Command::new(shell)
            .arg("-l")
            .arg("-c")
            .arg(command)
            .output()
    } else {
        Command::new(shell).arg("-lc").arg(command).output()
    }
}

fn parse_shell_environment(output: &[u8]) -> HashMap<String, String> {
    let mut environment = HashMap::new();
    for chunk in output.split(|byte| *byte == 0) {
        if chunk.is_empty() {
            continue;
        }
        let text = String::from_utf8_lossy(chunk);
        for line in text.lines() {
            if let Some((key, value)) = line.split_once('=') {
                if is_environment_key(key) {
                    environment.insert(key.to_string(), value.to_string());
                }
            }
        }
    }
    environment
}

fn is_environment_key(value: &str) -> bool {
    !value.is_empty()
        && value
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || ch == '_')
}

fn resolve_pi_candidate(candidate: &Path) -> Option<PathBuf> {
    if candidate.components().count() > 1 || candidate.is_absolute() {
        return candidate.exists().then(|| candidate.to_path_buf());
    }

    env::var_os("PATH").and_then(|path| {
        env::split_paths(&path)
            .map(|entry| entry.join(candidate))
            .find(|entry| entry.exists())
    })
}

fn ensure_orchestra_pi_agent_dir() -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let agent_dir = pi_agent_dir(&orchestra_root);
    fs::create_dir_all(&agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi agent directory {}: {error}",
            agent_dir.display()
        )
    })?;

    let npm_prefix_dir = runtime_managed_npm_prefix_dir(&agent_dir);
    fs::create_dir_all(&npm_prefix_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi npm prefix directory {}: {error}",
            npm_prefix_dir.display()
        )
    })?;

    if directory_is_empty(&agent_dir) {
        migrate_legacy_agent_dir(&agent_dir)?;
    }

    Ok(agent_dir)
}

fn migrate_legacy_agent_dir(destination: &Path) -> Result<(), String> {
    let Some(home) = env::var_os("HOME").map(PathBuf::from) else {
        return Ok(());
    };
    migrate_legacy_agent_dir_from(&home.join(".pi").join("agent"), destination)
}

fn migrate_legacy_agent_dir_from(
    legacy_agent_dir: &Path,
    destination: &Path,
) -> Result<(), String> {
    if !legacy_agent_dir.exists() {
        return Ok(());
    }

    for file_name in ["auth.json", "models.json"] {
        let source = legacy_agent_dir.join(file_name);
        let target = destination.join(file_name);
        if source.exists() && !target.exists() {
            fs::copy(&source, &target).map_err(|error| {
                format!(
                    "Unable to migrate legacy Pi agent file {} to {}: {error}",
                    source.display(),
                    target.display()
                )
            })?;
        }
    }

    Ok(())
}

fn directory_is_empty(path: &Path) -> bool {
    fs::read_dir(path)
        .map(|mut entries| entries.next().is_none())
        .unwrap_or(true)
}

fn expected_manifest_platform() -> &'static str {
    match env::consts::OS {
        "macos" => "darwin",
        "windows" => "windows",
        other => other,
    }
}

fn expected_manifest_arch() -> &'static str {
    match env::consts::ARCH {
        "x86_64" => "x64",
        "aarch64" => "arm64",
        other => other,
    }
}

fn runtime_mode() -> RuntimeMode {
    match option_env!("ORCHESTRA_TAURI_IS_DEV") {
        Some("false") => RuntimeMode::Packaged,
        _ => RuntimeMode::Development,
    }
}

fn is_executable(path: &Path) -> bool {
    if !path.is_file() {
        return false;
    }

    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        fs::metadata(path)
            .map(|metadata| metadata.permissions().mode() & 0o111 != 0)
            .unwrap_or(false)
    }

    #[cfg(not(unix))]
    {
        true
    }
}

fn runtime_error(
    mode: RuntimeMode,
    source: &str,
    error_kind: &str,
    error_message: String,
    resolved_path: Option<&Path>,
    manifest_path: Option<&Path>,
    agent_dir: Option<&Path>,
    mode_override: Option<String>,
    version: Option<String>,
) -> PiRuntimeHealth {
    PiRuntimeHealth {
        source: source.into(),
        mode: mode_override.unwrap_or_else(|| mode.as_str().into()),
        status: "runtime_error".into(),
        resolved_path: resolved_path.map(|path| path.display().to_string()),
        package_dir: None,
        agent_dir: agent_dir.map(|path| path.display().to_string()),
        version,
        built_at: None,
        manifest_path: manifest_path.map(|path| path.display().to_string()),
        error_kind: Some(error_kind.into()),
        error_message: Some(error_message),
    }
}

fn searched_paths_summary(paths: &[String]) -> String {
    if paths.is_empty() {
        "<none>".into()
    } else {
        paths.join(", ")
    }
}

impl RuntimeMode {
    fn as_str(self) -> &'static str {
        match self {
            Self::Development => "development",
            Self::Packaged => "packaged",
        }
    }
}

impl ResolvedPiRuntime {
    pub fn health(&self) -> PiRuntimeHealth {
        PiRuntimeHealth {
            source: self.source.clone(),
            mode: self.mode.clone(),
            status: "healthy".into(),
            resolved_path: Some(self.executable_path.display().to_string()),
            package_dir: self
                .package_dir
                .as_ref()
                .map(|path| path.display().to_string()),
            agent_dir: Some(self.agent_dir.display().to_string()),
            version: self.version.clone(),
            built_at: self.built_at.clone(),
            manifest_path: self
                .manifest_path
                .as_ref()
                .map(|path| path.display().to_string()),
            error_kind: None,
            error_message: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::{json, Value};
    use uuid::Uuid;

    fn make_temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("orchestra-pi-runtime-{name}-{}", Uuid::new_v4()));
        fs::create_dir_all(&dir).expect("temp dir should be created");
        dir
    }

    fn executable_relative_path() -> &'static str {
        if cfg!(windows) {
            "runtime/pi.exe"
        } else {
            "runtime/pi"
        }
    }

    fn write_file(path: &Path, content: &str) {
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).expect("parent should exist");
        }
        fs::write(path, content).expect("file should be written");
    }

    fn mark_executable(path: &Path) {
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path).expect("metadata").permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("permissions");
        }
    }

    fn write_fake_executable(path: &Path) {
        write_file(path, "#!/bin/sh\necho pi\n");
        mark_executable(path);
    }

    fn write_fake_bun_executable(path: &Path) {
        let script = if cfg!(windows) {
            "@echo off\r\necho bundled bun ok\r\n"
        } else {
            "#!/bin/sh\necho bundled bun ok\n"
        };
        write_file(path, script);
        mark_executable(path);
    }

    fn manifest_file_entry(root: &Path, relative_path: &str, executable: bool) -> Value {
        let file_path = root.join(relative_path);
        json!({
            "path": relative_path,
            "sha256": sha256_for_file(&file_path).expect("sha256 should compute"),
            "executable": executable,
        })
    }

    fn write_notice_and_sbom(root: &Path) {
        write_file(
            &root.join("THIRD_PARTY_NOTICES.txt"),
            "Bundled Pi runtime notices\n",
        );
        write_file(
            &root.join("sbom.cyclonedx.json"),
            "{\n  \"bomFormat\": \"CycloneDX\"\n}\n",
        );
    }

    fn write_minimal_runtime_package(root: &Path) {
        write_file(
            &root.join("runtime/dist/main.js"),
            "console.log('pi runtime');\n",
        );
        write_file(
            &root.join("runtime/dist/modes/interactive/theme/dark.json"),
            "{}\n",
        );
    }

    fn write_manifest(
        root: &Path,
        platform: &str,
        arch: &str,
        files: Vec<Value>,
        bundled_bun_relative_path: Option<&str>,
    ) {
        write_notice_and_sbom(root);
        write_minimal_runtime_package(root);
        let manifest = json!({
            "schemaVersion": 1,
            "source": "test",
            "platform": platform,
            "arch": arch,
            "packageName": "@mariozechner/pi-coding-agent",
            "packageVersion": "0.68.1",
            "runtimeVersion": "0.68.1",
            "orchestraPackVersion": 2,
            "executableRelativePath": executable_relative_path(),
            "packageDirRelativePath": "runtime",
            "bundledBunRelativePath": bundled_bun_relative_path,
            "noticeRelativePath": "THIRD_PARTY_NOTICES.txt",
            "sbomRelativePath": "sbom.cyclonedx.json",
            "files": files,
            "builtAt": "2026-04-22T00:00:00Z"
        });
        write_file(
            &root.join("manifest.json"),
            &format!(
                "{}\n",
                serde_json::to_string_pretty(&manifest).expect("manifest should serialize")
            ),
        );
    }

    #[test]
    fn validates_bundled_runtime_manifest() {
        let root = make_temp_dir("bundled-valid");
        let executable_path = root.join(executable_relative_path());
        write_fake_executable(&executable_path);
        write_notice_and_sbom(&root);
        let files = vec![
            manifest_file_entry(&root, executable_relative_path(), true),
            manifest_file_entry(&root, "THIRD_PARTY_NOTICES.txt", false),
        ];
        write_manifest(
            &root,
            expected_manifest_platform(),
            expected_manifest_arch(),
            files,
            None,
        );
        let agent_dir = make_temp_dir("agent-dir");

        let runtime = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect("bundled runtime should validate");

        assert_eq!(runtime.source, "bundled");
        assert_eq!(runtime.version.as_deref(), Some("0.68.1"));
        assert_eq!(
            runtime.package_dir.as_deref(),
            Some(root.join("runtime").as_path())
        );
    }

    #[test]
    fn rejects_missing_manifest_with_specific_error() {
        let root = make_temp_dir("bundled-missing-manifest");
        let agent_dir = make_temp_dir("agent-dir-missing-manifest");

        let error = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect_err("bundled runtime should fail without a manifest");

        assert_eq!(
            error.error_kind.as_deref(),
            Some("bundled_runtime_manifest_missing")
        );
    }

    #[test]
    fn rejects_invalid_manifest_json_with_specific_error() {
        let root = make_temp_dir("bundled-invalid-manifest-json");
        write_file(&root.join("manifest.json"), "{not json\n");
        let agent_dir = make_temp_dir("agent-dir-invalid-manifest-json");

        let error = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect_err("bundled runtime should fail with invalid manifest json");

        assert_eq!(
            error.error_kind.as_deref(),
            Some("bundled_runtime_manifest_invalid")
        );
    }

    #[test]
    fn rejects_missing_required_runtime_asset_with_specific_error() {
        let root = make_temp_dir("bundled-missing-runtime-asset");
        let executable_path = root.join(executable_relative_path());
        write_fake_executable(&executable_path);
        write_notice_and_sbom(&root);
        write_manifest(
            &root,
            expected_manifest_platform(),
            expected_manifest_arch(),
            vec![
                manifest_file_entry(&root, executable_relative_path(), true),
                manifest_file_entry(&root, "THIRD_PARTY_NOTICES.txt", false),
            ],
            None,
        );
        std::fs::remove_file(root.join("runtime/dist/modes/interactive/theme/dark.json"))
            .expect("dark theme should remove");
        let agent_dir = make_temp_dir("agent-dir-missing-runtime-asset");

        let error = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect_err("bundled runtime should fail without required assets");

        assert_eq!(
            error.error_kind.as_deref(),
            Some("bundled_runtime_file_missing")
        );
    }

    #[test]
    fn rejects_checksum_mismatch_with_specific_error() {
        let root = make_temp_dir("bundled-checksum-mismatch");
        let executable_path = root.join(executable_relative_path());
        write_fake_executable(&executable_path);
        write_file(
            &root.join("THIRD_PARTY_NOTICES.txt"),
            "Bundled Pi runtime notices\n",
        );
        write_file(
            &root.join("sbom.cyclonedx.json"),
            "{\n  \"bomFormat\": \"CycloneDX\"\n}\n",
        );
        write_manifest(
            &root,
            expected_manifest_platform(),
            expected_manifest_arch(),
            vec![
                json!({
                    "path": executable_relative_path(),
                    "sha256": "deadbeef",
                    "executable": true,
                }),
                manifest_file_entry(&root, "THIRD_PARTY_NOTICES.txt", false),
            ],
            None,
        );
        let agent_dir = make_temp_dir("agent-dir-checksum-mismatch");

        let error = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect_err("bundled runtime should fail checksum verification");

        assert_eq!(
            error.error_kind.as_deref(),
            Some("bundled_runtime_checksum_mismatch")
        );
    }

    #[test]
    fn rejects_incompatible_bundled_runtime() {
        let root = make_temp_dir("bundled-incompatible");
        let executable_path = root.join(executable_relative_path());
        let incompatible_arch = if expected_manifest_arch() == "x64" {
            "arm64"
        } else {
            "x64"
        };
        write_fake_executable(&executable_path);
        write_notice_and_sbom(&root);
        write_manifest(
            &root,
            expected_manifest_platform(),
            incompatible_arch,
            vec![
                manifest_file_entry(&root, executable_relative_path(), true),
                manifest_file_entry(&root, "THIRD_PARTY_NOTICES.txt", false),
            ],
            None,
        );
        let agent_dir = make_temp_dir("agent-dir-incompatible");

        let error = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect_err("bundled runtime should be rejected");

        assert_eq!(
            error.error_kind.as_deref(),
            Some("bundled_runtime_incompatible")
        );
    }

    #[test]
    fn runtime_environment_sets_agent_dir_package_dir_and_npm_prefix_for_bundled_runtime() {
        let runtime = ResolvedPiRuntime {
            source: "bundled".into(),
            mode: "packaged".into(),
            executable_path: PathBuf::from("/tmp/pi-runtime/runtime/pi"),
            package_dir: Some(PathBuf::from("/tmp/pi-runtime/runtime")),
            bundled_bun_path: Some(PathBuf::from("/tmp/pi-runtime/bun/bin/bun")),
            agent_dir: PathBuf::from("/tmp/orchestra/runtime/pi/agent"),
            version: Some("0.68.1".into()),
            built_at: Some("2026-04-22T00:00:00Z".into()),
            manifest_path: Some(PathBuf::from("/tmp/pi-runtime/manifest.json")),
        };

        let environment = runtime_environment_variables(&runtime, None);
        let map = environment.into_iter().collect::<HashMap<_, _>>();
        assert_eq!(
            map.get("PI_CODING_AGENT_DIR"),
            Some(&"/tmp/orchestra/runtime/pi/agent".to_string())
        );
        assert_eq!(
            map.get("NPM_CONFIG_PREFIX"),
            Some(&"/tmp/orchestra/runtime/pi/npm".to_string())
        );
        assert_eq!(
            map.get("npm_config_prefix"),
            Some(&"/tmp/orchestra/runtime/pi/npm".to_string())
        );
        assert_eq!(
            map.get("PI_PACKAGE_DIR"),
            Some(&"/tmp/pi-runtime/runtime".to_string())
        );
        let path_value = map
            .get("PATH")
            .expect("bundled bun path should be exported");
        let path_entries = env::split_paths(path_value)
            .map(|entry| entry.display().to_string())
            .collect::<Vec<_>>();
        assert_eq!(
            path_entries.first().map(String::as_str),
            Some("/tmp/pi-runtime/bun/bin")
        );
    }

    #[test]
    fn apply_runtime_environment_clears_inherited_package_dir_for_system_runtime() {
        let runtime = ResolvedPiRuntime {
            source: "system".into(),
            mode: "development".into(),
            executable_path: PathBuf::from("/opt/homebrew/bin/pi"),
            package_dir: None,
            bundled_bun_path: None,
            agent_dir: PathBuf::from("/tmp/orchestra/runtime/pi/agent"),
            version: None,
            built_at: None,
            manifest_path: None,
        };
        let mut command = Command::new("env");
        command.env("PI_PACKAGE_DIR", "/tmp/broken-runtime");

        apply_runtime_environment(&mut command, &runtime, None);

        let envs = command
            .get_envs()
            .map(|(key, value)| {
                (
                    key.to_string_lossy().into_owned(),
                    value.map(|value| value.to_string_lossy().into_owned()),
                )
            })
            .collect::<HashMap<_, _>>();
        assert_eq!(envs.get("PI_PACKAGE_DIR"), Some(&None));
    }

    #[test]
    fn validates_optional_bundled_bun_executable() {
        let root = make_temp_dir("bundled-valid-with-bun");
        let executable_path = root.join(executable_relative_path());
        let bundled_bun_relative_path = if cfg!(windows) {
            "bun/bin/bun.exe"
        } else {
            "bun/bin/bun"
        };
        let bundled_bun_path = root.join(bundled_bun_relative_path);
        write_fake_executable(&executable_path);
        write_fake_executable(&bundled_bun_path);
        write_notice_and_sbom(&root);
        let files = vec![
            manifest_file_entry(&root, executable_relative_path(), true),
            manifest_file_entry(&root, bundled_bun_relative_path, true),
            manifest_file_entry(&root, "THIRD_PARTY_NOTICES.txt", false),
        ];
        write_manifest(
            &root,
            expected_manifest_platform(),
            expected_manifest_arch(),
            files,
            Some(bundled_bun_relative_path),
        );
        let agent_dir = make_temp_dir("agent-dir-with-bun");

        let runtime = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect("bundled runtime with Bun should validate");

        assert_eq!(
            runtime.bundled_bun_path.as_deref(),
            Some(bundled_bun_path.as_path())
        );
    }

    #[test]
    fn packaged_runtime_environment_executes_bundled_bun_via_path() {
        let root = make_temp_dir("bundled-bun-executes");
        let executable_path = root.join(executable_relative_path());
        let bundled_bun_relative_path = if cfg!(windows) {
            "bun/bin/bun.cmd"
        } else {
            "bun/bin/bun"
        };
        let bundled_bun_path = root.join(bundled_bun_relative_path);
        write_fake_executable(&executable_path);
        write_fake_bun_executable(&bundled_bun_path);
        write_notice_and_sbom(&root);
        let files = vec![
            manifest_file_entry(&root, executable_relative_path(), true),
            manifest_file_entry(&root, bundled_bun_relative_path, true),
            manifest_file_entry(&root, "THIRD_PARTY_NOTICES.txt", false),
        ];
        write_manifest(
            &root,
            expected_manifest_platform(),
            expected_manifest_arch(),
            files,
            Some(bundled_bun_relative_path),
        );
        let agent_dir = make_temp_dir("agent-dir-bun-executes");
        let runtime = validate_bundled_runtime_root(&root, RuntimeMode::Packaged, &agent_dir)
            .expect("bundled runtime with executable Bun should validate");

        let mut command = if cfg!(windows) {
            let mut command = Command::new("cmd");
            command.args(["/C", "bun"]);
            command
        } else {
            let mut command = Command::new("sh");
            command.args(["-c", "bun"]);
            command
        };
        apply_runtime_environment(&mut command, &runtime, None);

        let output = command
            .output()
            .expect("packaged runtime subprocess should execute bundled Bun");
        let stdout = String::from_utf8_lossy(&output.stdout);
        let stderr = String::from_utf8_lossy(&output.stderr);

        assert!(
            output.status.success(),
            "expected bundled Bun subprocess to succeed; stdout={stdout:?} stderr={stderr:?}"
        );
        assert_eq!(stdout.trim(), "bundled bun ok");
    }

    #[test]
    fn legacy_migration_skips_settings_json() {
        let legacy_agent_dir = make_temp_dir("legacy-agent");
        let destination = make_temp_dir("orchestra-agent");
        write_file(&legacy_agent_dir.join("auth.json"), "{}\n");
        write_file(&legacy_agent_dir.join("models.json"), "{}\n");
        write_file(
            &legacy_agent_dir.join("settings.json"),
            "{\"packages\":[\"npm:test\"]}\n",
        );

        migrate_legacy_agent_dir_from(&legacy_agent_dir, &destination)
            .expect("legacy migration should succeed");

        assert!(destination.join("auth.json").exists());
        assert!(destination.join("models.json").exists());
        assert!(!destination.join("settings.json").exists());
    }
}
