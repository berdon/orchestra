use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use serde_json::{Map, Value};

use crate::{
    models::{
        PiLegacyImportPreview, PiLegacyImportState, PiPackageDiagnostics,
        PiProviderAuthMethodSummary, PiProviderSetupSummary, PiSetupIssue, PiSetupMetadata,
        PiSetupState,
    },
    services::{
        harness_settings,
        orchestra_paths::{
            default_orchestra_root, legacy_pi_agent_dir, orchestra_pi_settings_path,
            pi_agent_dir as orchestra_pi_agent_dir,
        },
        pi_package_sources,
    },
};

struct BuiltInProviderAuthMethodCatalogEntry {
    id: &'static str,
    label: &'static str,
    kind: &'static str,
    is_default: bool,
}

struct BuiltInProviderCatalogEntry {
    id: &'static str,
    name: &'static str,
    auth_modes: &'static [&'static str],
    uses_callback_server: bool,
    oauth_methods: &'static [BuiltInProviderAuthMethodCatalogEntry],
}

const BROWSER_OAUTH_METHOD: BuiltInProviderAuthMethodCatalogEntry =
    BuiltInProviderAuthMethodCatalogEntry {
        id: "browser_oauth",
        label: "Browser sign-in",
        kind: "browser",
        is_default: true,
    };

const DEVICE_CODE_METHOD: BuiltInProviderAuthMethodCatalogEntry =
    BuiltInProviderAuthMethodCatalogEntry {
        id: "device_code",
        label: "Device code auth",
        kind: "device_code",
        is_default: true,
    };

const BUILT_IN_PROVIDER_CATALOG: &[BuiltInProviderCatalogEntry] = &[
    BuiltInProviderCatalogEntry {
        id: "anthropic",
        name: "Anthropic",
        auth_modes: &["api_key", "oauth"],
        uses_callback_server: true,
        oauth_methods: &[BROWSER_OAUTH_METHOD],
    },
    BuiltInProviderCatalogEntry {
        id: "openai",
        name: "OpenAI",
        auth_modes: &["api_key"],
        uses_callback_server: false,
        oauth_methods: &[],
    },
    BuiltInProviderCatalogEntry {
        id: "openai-codex",
        name: "OpenAI Codex",
        auth_modes: &["oauth"],
        uses_callback_server: true,
        oauth_methods: &[BROWSER_OAUTH_METHOD],
    },
    BuiltInProviderCatalogEntry {
        id: "github-copilot",
        name: "GitHub Copilot",
        auth_modes: &["oauth"],
        uses_callback_server: false,
        oauth_methods: &[DEVICE_CODE_METHOD],
    },
    BuiltInProviderCatalogEntry {
        id: "google",
        name: "Google",
        auth_modes: &["api_key"],
        uses_callback_server: false,
        oauth_methods: &[],
    },
    BuiltInProviderCatalogEntry {
        id: "google-gemini-cli",
        name: "Google Gemini CLI",
        auth_modes: &["oauth"],
        uses_callback_server: true,
        oauth_methods: &[BROWSER_OAUTH_METHOD],
    },
    BuiltInProviderCatalogEntry {
        id: "google-antigravity",
        name: "Google Antigravity",
        auth_modes: &["oauth"],
        uses_callback_server: true,
        oauth_methods: &[BROWSER_OAUTH_METHOD],
    },
];

fn provider_catalog_entry(provider_id: &str) -> Option<&'static BuiltInProviderCatalogEntry> {
    BUILT_IN_PROVIDER_CATALOG
        .iter()
        .find(|entry| entry.id == provider_id)
}

fn display_name_for_provider(provider_id: &str) -> String {
    provider_catalog_entry(provider_id)
        .map(|entry| entry.name.to_string())
        .unwrap_or_else(|| {
            provider_id
                .split(['-', '_'])
                .filter(|segment| !segment.is_empty())
                .map(|segment| {
                    let mut chars = segment.chars();
                    match chars.next() {
                        Some(first) => {
                            format!("{}{}", first.to_ascii_uppercase(), chars.as_str())
                        }
                        None => String::new(),
                    }
                })
                .collect::<Vec<_>>()
                .join(" ")
        })
}

fn auth_modes_for_provider(provider_id: &str) -> Vec<String> {
    provider_catalog_entry(provider_id)
        .map(|entry| {
            entry
                .auth_modes
                .iter()
                .map(|mode| (*mode).to_string())
                .collect()
        })
        .unwrap_or_else(|| vec!["api_key".into()])
}

fn uses_callback_server(provider_id: &str) -> bool {
    provider_catalog_entry(provider_id)
        .map(|entry| entry.uses_callback_server)
        .unwrap_or(false)
}

fn oauth_methods_for_provider(provider_id: &str) -> Option<Vec<PiProviderAuthMethodSummary>> {
    provider_catalog_entry(provider_id).and_then(|entry| {
        if entry.oauth_methods.is_empty() {
            return None;
        }

        Some(
            entry
                .oauth_methods
                .iter()
                .map(|method| PiProviderAuthMethodSummary {
                    id: method.id.to_string(),
                    label: method.label.to_string(),
                    kind: method.kind.to_string(),
                    is_default: method.is_default,
                })
                .collect(),
        )
    })
}

fn orchestra_pi_paths() -> Result<(PathBuf, PathBuf, PathBuf, PathBuf), String> {
    let orchestra_root = default_orchestra_root()?;
    let agent_dir = orchestra_pi_agent_dir(&orchestra_root);
    Ok((
        agent_dir.clone(),
        agent_dir.join("auth.json"),
        agent_dir.join("models.json"),
        orchestra_pi_settings_path(&orchestra_root),
    ))
}

fn parse_json_object(path: &Path) -> Result<Option<Map<String, Value>>, String> {
    if !path.exists() {
        return Ok(None);
    }

    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read {}: {error}", path.display()))?;
    let parsed: Value = serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse {}: {error}", path.display()))?;
    parsed
        .as_object()
        .cloned()
        .map(Some)
        .ok_or_else(|| format!("{} must contain a top-level JSON object", path.display()))
}

fn ensure_parent_dir(path: &Path) -> Result<(), String> {
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create parent directory {}: {error}",
                parent.display()
            )
        })?;
        set_restrictive_permissions(parent, 0o700)?;
    }
    Ok(())
}

fn write_restricted_file(path: &Path, content: &str) -> Result<(), String> {
    ensure_parent_dir(path)?;
    let temp_path = path.with_extension(format!(
        "{}.tmp",
        Utc::now().timestamp_nanos_opt().unwrap_or_default()
    ));
    fs::write(&temp_path, content)
        .map_err(|error| format!("Unable to write {}: {error}", temp_path.display()))?;
    set_restrictive_permissions(&temp_path, 0o600)?;
    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "Unable to move {} into place at {}: {error}",
            temp_path.display(),
            path.display()
        )
    })?;
    set_restrictive_permissions(path, 0o600)?;
    Ok(())
}

fn copy_restricted_file(source: &Path, destination: &Path) -> Result<(), String> {
    let content = fs::read_to_string(source)
        .map_err(|error| format!("Unable to read {}: {error}", source.display()))?;
    write_restricted_file(destination, &content)
}

fn set_restrictive_permissions(path: &Path, mode: u32) -> Result<(), String> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;

        let permissions = fs::Permissions::from_mode(mode);
        fs::set_permissions(path, permissions)
            .map_err(|error| format!("Unable to set permissions on {}: {error}", path.display()))?;
    }

    #[cfg(not(unix))]
    {
        let _ = (path, mode);
    }

    Ok(())
}

fn setup_metadata() -> Result<PiSetupMetadata, String> {
    harness_settings::get_pi_setup_metadata()
}

fn save_setup_metadata(
    imported_at: Option<String>,
    dismissed_legacy_import_at: Option<String>,
) -> Result<PiSetupMetadata, String> {
    harness_settings::update_pi_setup_metadata(imported_at, dismissed_legacy_import_at)
}

pub fn preview_legacy_import() -> Result<PiLegacyImportPreview, String> {
    let legacy_agent_dir = legacy_pi_agent_dir()?;
    let auth_path = legacy_agent_dir.join("auth.json");
    let models_path = legacy_agent_dir.join("models.json");
    Ok(PiLegacyImportPreview {
        legacy_agent_dir: legacy_agent_dir.display().to_string(),
        auth_path: auth_path.display().to_string(),
        models_path: models_path.display().to_string(),
        auth_exists: auth_path.exists(),
        models_exists: models_path.exists(),
        can_import: auth_path.exists() || models_path.exists(),
        warning: None,
    })
}

pub fn get_models_json() -> Result<String, String> {
    let (_, _, models_path, _) = orchestra_pi_paths()?;
    if !models_path.exists() {
        return Ok("{\n  \"providers\": {}\n}\n".into());
    }

    fs::read_to_string(&models_path)
        .map_err(|error| format!("Unable to read {}: {error}", models_path.display()))
}

pub fn save_models_json(content: &str) -> Result<PiSetupState, String> {
    let trimmed = content.trim();
    let normalized = if trimmed.is_empty() {
        "{\n  \"providers\": {}\n}\n".to_string()
    } else {
        content.to_string()
    };

    let parsed: Value = serde_json::from_str(&normalized)
        .map_err(|error| format!("models.json is not valid JSON: {error}"))?;
    if !parsed.is_object() {
        return Err("models.json must contain a top-level JSON object.".into());
    }

    let (_, _, models_path, _) = orchestra_pi_paths()?;
    write_restricted_file(&models_path, &normalized)?;
    get_pi_setup_state()
}

pub fn set_provider_api_key(provider_id: &str, api_key: &str) -> Result<PiSetupState, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider id is required.".into());
    }

    let api_key = api_key.trim();
    if api_key.is_empty() {
        return Err("API key is required.".into());
    }

    let (_, auth_path, _, _) = orchestra_pi_paths()?;
    let mut auth = parse_json_object(&auth_path)?.unwrap_or_default();
    auth.insert(
        provider_id.to_string(),
        serde_json::json!({ "type": "api_key", "key": api_key }),
    );
    write_restricted_file(
        &auth_path,
        &serde_json::to_string_pretty(&Value::Object(auth))
            .map_err(|error| format!("Unable to serialize auth.json: {error}"))?,
    )?;
    get_pi_setup_state()
}

pub fn remove_provider_credential(provider_id: &str) -> Result<PiSetupState, String> {
    let provider_id = provider_id.trim();
    if provider_id.is_empty() {
        return Err("Provider id is required.".into());
    }

    let (_, auth_path, _, _) = orchestra_pi_paths()?;
    let mut auth = parse_json_object(&auth_path)?.unwrap_or_default();
    auth.remove(provider_id);
    write_restricted_file(
        &auth_path,
        &serde_json::to_string_pretty(&Value::Object(auth))
            .map_err(|error| format!("Unable to serialize auth.json: {error}"))?,
    )?;
    get_pi_setup_state()
}

pub fn dismiss_legacy_import() -> Result<PiSetupState, String> {
    let metadata = setup_metadata()?;
    save_setup_metadata(metadata.imported_at, Some(Utc::now().to_rfc3339()))?;
    get_pi_setup_state()
}

pub fn import_legacy_config(replace_existing: bool) -> Result<PiSetupState, String> {
    let preview = preview_legacy_import()?;
    if !preview.can_import {
        return Err("No legacy Pi configuration was found in ~/.pi/agent.".into());
    }

    let (agent_dir, auth_path, models_path, _) = orchestra_pi_paths()?;
    fs::create_dir_all(&agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi agent directory {}: {error}",
            agent_dir.display()
        )
    })?;
    set_restrictive_permissions(&agent_dir, 0o700)?;

    if !replace_existing && (auth_path.exists() || models_path.exists()) {
        return Err(
            "Orchestra already has Pi auth/model files. Use replace import to overwrite them."
                .into(),
        );
    }

    let legacy_agent_dir = PathBuf::from(&preview.legacy_agent_dir);
    if preview.auth_exists {
        copy_restricted_file(&legacy_agent_dir.join("auth.json"), &auth_path)?;
    }
    if preview.models_exists {
        copy_restricted_file(&legacy_agent_dir.join("models.json"), &models_path)?;
    }

    let metadata = setup_metadata()?;
    save_setup_metadata(
        Some(Utc::now().to_rfc3339()),
        metadata.dismissed_legacy_import_at,
    )?;
    get_pi_setup_state()
}

pub fn get_pi_setup_state() -> Result<PiSetupState, String> {
    let (agent_dir, auth_path, models_path, settings_path) = orchestra_pi_paths()?;
    let legacy_preview = preview_legacy_import()?;
    let metadata = setup_metadata()?;

    let mut issues = Vec::new();
    let mut warnings = Vec::new();
    let auth = match parse_json_object(&auth_path) {
        Ok(value) => value,
        Err(error) => {
            issues.push(PiSetupIssue {
                code: "auth_json_invalid".into(),
                message: error,
                provider_id: None,
                model_id: None,
                source_kind: None,
                source_path: None,
                source_entries: None,
            });
            None
        }
    };
    let models = match parse_json_object(&models_path) {
        Ok(value) => value,
        Err(error) => {
            issues.push(PiSetupIssue {
                code: "models_json_invalid".into(),
                message: error,
                provider_id: None,
                model_id: None,
                source_kind: None,
                source_path: None,
                source_entries: None,
            });
            None
        }
    };

    let auth_map = auth.unwrap_or_default();
    let oauth_providers = auth_map
        .iter()
        .filter_map(|(provider_id, credential)| {
            credential
                .get("type")
                .and_then(Value::as_str)
                .filter(|credential_type| *credential_type == "oauth")
                .map(|_| provider_id.clone())
        })
        .collect::<BTreeSet<_>>();

    let available_models_probe =
        match pi_package_sources::resolve_available_models_with_package_diagnostics() {
            Ok(result) => Some(result),
            Err(error) => {
                if settings_path.exists() {
                    issues.push(PiSetupIssue {
                        code: "settings_json_invalid".into(),
                        message: error,
                        provider_id: None,
                        model_id: None,
                        source_kind: None,
                        source_path: Some(settings_path.display().to_string()),
                        source_entries: None,
                    });
                } else if models_path.exists() {
                    issues.push(PiSetupIssue {
                        code: "models_json_invalid".into(),
                        message: format!(
                            "Pi could not load Orchestra-managed models from {}: {error}",
                            models_path.display()
                        ),
                        provider_id: None,
                        model_id: None,
                        source_kind: None,
                        source_path: Some(models_path.display().to_string()),
                        source_entries: None,
                    });
                } else {
                    warnings.push(PiSetupIssue {
                        code: "no_available_models".into(),
                        message: format!("No Pi models are currently available: {error}"),
                        provider_id: None,
                        model_id: None,
                        source_kind: None,
                        source_path: None,
                        source_entries: None,
                    });
                }
                None
            }
        };

    let package_diagnostics = available_models_probe
        .as_ref()
        .map(|result| result.package_diagnostics.clone())
        .unwrap_or_else(PiPackageDiagnostics::default);
    let available_models = available_models_probe
        .as_ref()
        .map(|result| result.models.clone())
        .unwrap_or_default();

    if issues.is_empty() && package_diagnostics.blocking {
        issues.push(package_source_issue_from_diagnostics(&package_diagnostics));
    }

    if issues.is_empty() && available_models.is_empty() {
        warnings.push(PiSetupIssue {
            code: "no_available_models".into(),
            message: "No Pi models are configured yet. Connect a provider or import an existing Pi setup in Settings → Harness.".into(),
            provider_id: None,
            model_id: None,
            source_kind: None,
            source_path: None,
            source_entries: None,
        });
    }

    let mut provider_ids = BTreeSet::new();
    provider_ids.extend(
        BUILT_IN_PROVIDER_CATALOG
            .iter()
            .map(|entry| entry.id.to_string()),
    );
    provider_ids.extend(auth_map.keys().cloned());
    provider_ids.extend(available_models.iter().map(|model| model.provider.clone()));
    if let Some(models_object) = models.as_ref() {
        if let Some(provider_object) = models_object.get("providers").and_then(Value::as_object) {
            provider_ids.extend(provider_object.keys().cloned());
        }
    }

    let available_providers = provider_ids
        .into_iter()
        .map(|provider_id| {
            let model_count = available_models
                .iter()
                .filter(|model| model.provider == provider_id)
                .count();
            PiProviderSetupSummary {
                id: provider_id.clone(),
                name: display_name_for_provider(&provider_id),
                auth_modes: auth_modes_for_provider(&provider_id),
                connected: auth_map.contains_key(&provider_id),
                using_oauth: oauth_providers.contains(&provider_id),
                model_count,
                uses_callback_server: uses_callback_server(&provider_id),
                oauth_methods: oauth_methods_for_provider(&provider_id),
            }
        })
        .collect::<Vec<_>>();

    let can_import_legacy = legacy_preview.can_import;
    let has_orchestra_config = auth_path.exists() || models_path.exists() || settings_path.exists();
    let status = if !issues.is_empty() {
        "invalid"
    } else if !available_models.is_empty() {
        "ready"
    } else if can_import_legacy
        && !has_orchestra_config
        && metadata.imported_at.is_none()
        && metadata.dismissed_legacy_import_at.is_none()
    {
        "legacy_import_available"
    } else {
        "needs_setup"
    };

    Ok(PiSetupState {
        status: status.into(),
        agent_dir: agent_dir.display().to_string(),
        auth_path: auth_path.display().to_string(),
        models_path: models_path.display().to_string(),
        settings_path: settings_path.display().to_string(),
        legacy_agent_dir: Some(legacy_preview.legacy_agent_dir),
        available_providers,
        available_models,
        issues,
        warnings,
        import_state: PiLegacyImportState {
            can_import_legacy,
            imported_at: metadata.imported_at,
            dismissed_at: metadata.dismissed_legacy_import_at,
        },
        package_diagnostics,
    })
}

fn package_source_issue_from_diagnostics(diagnostics: &PiPackageDiagnostics) -> PiSetupIssue {
    let primary_source = diagnostics.sources.iter().find(|source| source.active);
    PiSetupIssue {
        code: "package_sources_require_bun".into(),
        message: diagnostics.message.clone(),
        provider_id: None,
        model_id: None,
        source_kind: primary_source.map(|source| source.source_kind.clone()),
        source_path: primary_source.map(|source| source.source_path.clone()),
        source_entries: primary_source.map(|source| source.entries.clone()),
    }
}

pub fn require_pi_setup_ready() -> Result<PiSetupState, String> {
    let state = get_pi_setup_state()?;
    if state.status == "ready" {
        return Ok(state);
    }

    Err(block_message_for_state(&state))
}

pub fn block_message_for_state(state: &PiSetupState) -> String {
    if let Some(issue) = state.issues.first() {
        match issue.code.as_str() {
            "auth_json_invalid" => {
                return format!(
                    "Pi auth is invalid. Fix {} in Settings → Harness before running Pi-backed work.",
                    state.auth_path
                );
            }
            "models_json_invalid" => {
                return format!(
                    "Pi models are invalid. Fix {} in Settings → Harness before running Pi-backed work.",
                    state.models_path
                );
            }
            "settings_json_invalid" => {
                return format!(
                    "Pi settings are invalid. Fix {} in Settings → Harness before running Pi-backed work.",
                    state.settings_path
                );
            }
            "package_sources_require_bun" => {
                return issue.message.clone();
            }
            _ => {}
        }
    }

    if state.status == "legacy_import_available" {
        return "Import your existing ~/.pi/agent setup or connect a provider in Settings → Harness before running Pi-backed work.".into();
    }

    "No Pi models are configured yet. Connect a provider or import an existing Pi setup in Settings → Harness before running Pi-backed work.".into()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::models::{PiLegacyImportState, PiSetupState};

    fn setup_state_with_issue(code: &str, auth_path: &str, models_path: &str) -> PiSetupState {
        PiSetupState {
            status: "invalid".into(),
            agent_dir: "/tmp/orchestra/runtime/pi/agent".into(),
            auth_path: auth_path.into(),
            models_path: models_path.into(),
            settings_path: "/tmp/orchestra/runtime/pi/agent/settings.json".into(),
            legacy_agent_dir: Some("/Users/test/.pi/agent".into()),
            available_providers: Vec::new(),
            available_models: Vec::new(),
            issues: vec![crate::models::PiSetupIssue {
                code: code.into(),
                message: "invalid".into(),
                provider_id: None,
                model_id: None,
                source_kind: None,
                source_path: None,
                source_entries: None,
            }],
            warnings: Vec::new(),
            import_state: PiLegacyImportState {
                can_import_legacy: false,
                imported_at: None,
                dismissed_at: None,
            },
            package_diagnostics: PiPackageDiagnostics::default(),
        }
    }

    #[test]
    fn provider_display_names_are_humanized() {
        assert_eq!(display_name_for_provider("anthropic"), "Anthropic");
        assert_eq!(display_name_for_provider("custom-openai"), "Custom Openai");
    }

    #[test]
    fn block_message_points_to_invalid_auth_file() {
        let state = setup_state_with_issue(
            "auth_json_invalid",
            "/tmp/orchestra/runtime/pi/agent/auth.json",
            "/tmp/orchestra/runtime/pi/agent/models.json",
        );

        let message = block_message_for_state(&state);
        assert!(message.contains("auth.json"));
        assert!(message.contains("Settings → Harness"));
    }

    #[test]
    fn block_message_points_to_invalid_models_file() {
        let state = setup_state_with_issue(
            "models_json_invalid",
            "/tmp/orchestra/runtime/pi/agent/auth.json",
            "/tmp/orchestra/runtime/pi/agent/models.json",
        );

        let message = block_message_for_state(&state);
        assert!(message.contains("models.json"));
        assert!(message.contains("Settings → Harness"));
    }

    #[test]
    fn block_message_returns_package_source_bun_issue_verbatim() {
        let mut state = setup_state_with_issue(
            "package_sources_require_bun",
            "/tmp/orchestra/runtime/pi/agent/auth.json",
            "/tmp/orchestra/runtime/pi/agent/models.json",
        );
        state.issues[0].message = "Harness could not load package-based model sources because Bun is not available on PATH used for Orchestra subprocesses. Detected source: /tmp/orchestra/runtime/pi/agent/settings.json [npm:pi-subagents].".into();

        let message = block_message_for_state(&state);
        assert!(message.contains("Bun is not available"));
        assert!(message.contains("settings.json"));
        assert!(message.contains("npm:pi-subagents"));
    }

    #[test]
    fn block_message_mentions_legacy_import_when_available() {
        let state = PiSetupState {
            status: "legacy_import_available".into(),
            agent_dir: "/tmp/orchestra/runtime/pi/agent".into(),
            auth_path: "/tmp/orchestra/runtime/pi/agent/auth.json".into(),
            models_path: "/tmp/orchestra/runtime/pi/agent/models.json".into(),
            settings_path: "/tmp/orchestra/runtime/pi/agent/settings.json".into(),
            legacy_agent_dir: Some("/Users/test/.pi/agent".into()),
            available_providers: Vec::new(),
            available_models: Vec::new(),
            issues: Vec::new(),
            warnings: Vec::new(),
            import_state: PiLegacyImportState {
                can_import_legacy: true,
                imported_at: None,
                dismissed_at: None,
            },
            package_diagnostics: PiPackageDiagnostics::default(),
        };

        let message = block_message_for_state(&state);
        assert!(message.contains("~/.pi/agent"));
        assert!(message.contains("Settings → Harness"));
    }
}
