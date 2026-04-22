use std::{
    env, fs,
    path::{Path, PathBuf},
    process::Command,
};

use crate::{
    models::{
        PiAddOnPolicyStatus, PiAuthStatus, PiImportLegacyResult, PiRuntimeDiagnostics,
        PiRuntimeStatus,
    },
    services::{
        harness_settings,
        orchestra_paths::{
            default_orchestra_root, orchestra_pi_agent_dir, orchestra_pi_auth_path,
            orchestra_pi_models_path, orchestra_pi_settings_path,
        },
        pi_sessions,
    },
};

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

pub fn is_packaged_mode() -> bool {
    env::var("ORCHESTRA_PROJECT_ROOT")
        .map(|value| value.trim().is_empty())
        .unwrap_or(true)
}

pub fn resolve_pi_runtime_context(
    preferred: Option<&Path>,
) -> Result<ResolvedPiRuntimeContext, String> {
    let orchestra_root = default_orchestra_root()?;
    let packaged_mode = is_packaged_mode();
    let runtime_source = if packaged_mode { "bundled" } else { "external" }.to_string();
    let executable_path = pi_sessions::resolve_pi_executable(preferred)
        .map_err(|error| classify_runtime_resolution_error(packaged_mode, &error))?;

    Ok(ResolvedPiRuntimeContext {
        executable_path,
        runtime_source,
        packaged_mode,
        pi_agent_dir: orchestra_pi_agent_dir(&orchestra_root),
        pi_auth_path: orchestra_pi_auth_path(&orchestra_root),
        pi_models_path: orchestra_pi_models_path(&orchestra_root),
        pi_settings_path: orchestra_pi_settings_path(&orchestra_root),
        orchestra_root,
    })
}

pub fn ensure_pi_agent_dir(agent_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra PI agent directory {}: {error}",
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

pub fn get_pi_runtime_diagnostics() -> Result<PiRuntimeDiagnostics, String> {
    let orchestra_root = default_orchestra_root()?;
    let packaged_mode = is_packaged_mode();
    let runtime_source = if packaged_mode { "bundled" } else { "external" }.to_string();
    let agent_dir = orchestra_pi_agent_dir(&orchestra_root);
    let auth_path = orchestra_pi_auth_path(&orchestra_root);
    let models_path = orchestra_pi_models_path(&orchestra_root);
    let settings_path = orchestra_pi_settings_path(&orchestra_root);
    let legacy_agent_dir = legacy_pi_agent_dir();
    let migration = harness_settings::get_pi_migration_state(&orchestra_root)?;
    let runtime_resolution = pi_sessions::resolve_pi_executable(None);
    let runtime = match runtime_resolution {
        Ok(path) => PiRuntimeStatus {
            available: true,
            source: runtime_source.clone(),
            packaged_mode,
            resolved_path: Some(path.display().to_string()),
            error: None,
            message: if packaged_mode {
                format!("Bundled PI runtime resolved at {}.", path.display())
            } else {
                format!("PI runtime resolved at {}.", path.display())
            },
        },
        Err(error) => PiRuntimeStatus {
            available: false,
            source: runtime_source.clone(),
            packaged_mode,
            resolved_path: None,
            error: Some(classify_runtime_resolution_error(packaged_mode, &error)),
            message: if packaged_mode {
                "Bundled PI runtime unavailable.".into()
            } else {
                "PI runtime unavailable.".into()
            },
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
            "Orchestra PI auth is not configured yet. Import legacy auth/models from {} into {}.",
            legacy_agent_dir
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "~/.pi/agent".into()),
            agent_dir.display()
        )
    } else {
        format!(
            "Orchestra PI auth is not configured yet. Orchestra now uses {} instead of ~/.pi/agent.",
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
                "Packaged mode allows only explicit local filesystem paths for extra PI runtime extensions.".into()
            } else {
                "Development mode allows free-form PI extension entries.".into()
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
    let agent_dir = orchestra_pi_agent_dir(&orchestra_root);
    ensure_pi_agent_dir(&agent_dir)?;
    let legacy_agent_dir = legacy_pi_agent_dir()
        .ok_or_else(|| "No legacy PI agent directory was found at ~/.pi/agent".to_string())?;

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
        format!("Bundled PI runtime unavailable. {error}")
    } else {
        format!("PI runtime unavailable. {error}")
    }
}
