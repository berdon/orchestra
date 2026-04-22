use std::{fs, path::Path};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    models::PiRuntimeSettings,
    services::{
        orchestra_paths::{default_orchestra_root, orchestra_settings_path},
        pi_runtime,
        session_compaction::{normalize_compaction_window_spec, DEFAULT_COMPACTION_WINDOW},
    },
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredHarnessSettings {
    #[serde(default)]
    harness: StoredHarnessSection,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredHarnessSection {
    #[serde(default)]
    pi: StoredPiRuntimeSettings,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredPiRuntimeSettings {
    #[serde(default)]
    extra_extensions: Vec<String>,
    default_compaction_window: Option<String>,
    updated_at: Option<String>,
    #[serde(default)]
    migration: PiMigrationStateRecord,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PiMigrationStateRecord {
    pub legacy_agent_dir: Option<String>,
    pub auth_imported_at: Option<String>,
    pub models_imported_at: Option<String>,
    pub dismissed_at: Option<String>,
    pub last_detected_at: Option<String>,
}

pub fn get_pi_runtime_settings() -> Result<PiRuntimeSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_pi_runtime_settings_in(&orchestra_root)
}

pub fn update_pi_runtime_settings(
    extra_extensions: Vec<String>,
    default_compaction_window: Option<String>,
) -> Result<PiRuntimeSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_pi_runtime_settings_in(&orchestra_root, extra_extensions, default_compaction_window)
}

pub fn get_pi_runtime_settings_in(orchestra_root: &Path) -> Result<PiRuntimeSettings, String> {
    let settings = load_harness_settings(orchestra_root)?;
    Ok(PiRuntimeSettings {
        extra_extensions: settings.harness.pi.extra_extensions,
        default_compaction_window: normalize_compaction_window_spec(
            settings.harness.pi.default_compaction_window,
        )?
        .unwrap_or_else(|| DEFAULT_COMPACTION_WINDOW.to_string()),
        updated_at: settings.harness.pi.updated_at,
    })
}

pub fn update_pi_runtime_settings_in(
    orchestra_root: &Path,
    extra_extensions: Vec<String>,
    default_compaction_window: Option<String>,
) -> Result<PiRuntimeSettings, String> {
    let mut settings = load_harness_settings(orchestra_root)?;
    let normalized_extensions = normalize_extensions(extra_extensions);
    validate_packaged_mode_extensions(&normalized_extensions)?;
    settings.harness.pi.extra_extensions = normalized_extensions;
    settings.harness.pi.default_compaction_window =
        normalize_compaction_window_spec(default_compaction_window)?;
    settings.harness.pi.updated_at = Some(Utc::now().to_rfc3339());
    save_harness_settings(orchestra_root, &settings)?;
    get_pi_runtime_settings_in(orchestra_root)
}

pub fn resolve_spawn_extra_extensions(
    extra_extensions: Vec<String>,
) -> Result<Vec<String>, String> {
    let normalized = normalize_extensions(extra_extensions);
    validate_packaged_mode_extensions(&normalized)?;
    Ok(normalized)
}

pub fn blocked_packaged_mode_extensions(extra_extensions: &[String]) -> Vec<String> {
    blocked_packaged_mode_extensions_for_mode(pi_runtime::is_packaged_mode(), extra_extensions)
}

pub fn get_pi_migration_state(orchestra_root: &Path) -> Result<PiMigrationStateRecord, String> {
    Ok(load_harness_settings(orchestra_root)?.harness.pi.migration)
}

pub fn record_legacy_pi_import(
    orchestra_root: &Path,
    legacy_agent_dir: &Path,
    imported_auth: bool,
    imported_models: bool,
) -> Result<(), String> {
    let mut settings = load_harness_settings(orchestra_root)?;
    let now = Utc::now().to_rfc3339();
    settings.harness.pi.migration.legacy_agent_dir = Some(legacy_agent_dir.display().to_string());
    settings.harness.pi.migration.last_detected_at = Some(now.clone());
    if imported_auth {
        settings.harness.pi.migration.auth_imported_at = Some(now.clone());
    }
    if imported_models {
        settings.harness.pi.migration.models_imported_at = Some(now.clone());
    }
    save_harness_settings(orchestra_root, &settings)
}

fn normalize_extensions(extra_extensions: Vec<String>) -> Vec<String> {
    let mut normalized = Vec::new();
    for extension in extra_extensions {
        let trimmed = extension.trim();
        if trimmed.is_empty() {
            continue;
        }
        if normalized.iter().any(|existing| existing == trimmed) {
            continue;
        }
        normalized.push(trimmed.to_string());
    }
    normalized
}

fn validate_packaged_mode_extensions(extra_extensions: &[String]) -> Result<(), String> {
    let blocked = blocked_packaged_mode_extensions(extra_extensions);
    if blocked.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Packaged Orchestra only supports explicit local filesystem paths for extra PI runtime extensions. Unsupported entries: {}. Use absolute paths, ./relative paths, ../relative paths, or ~/ paths instead of npm:/git:/URL/package shorthand.",
        blocked.join(", ")
    ))
}

fn blocked_packaged_mode_extensions_for_mode(
    packaged_mode: bool,
    extra_extensions: &[String],
) -> Vec<String> {
    if !packaged_mode {
        return Vec::new();
    }

    extra_extensions
        .iter()
        .filter(|entry| !is_explicit_local_extension_path(entry))
        .cloned()
        .collect()
}

fn is_explicit_local_extension_path(value: &str) -> bool {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return false;
    }

    if is_non_path_extension_source(trimmed) {
        return false;
    }

    if std::path::Path::new(trimmed).is_absolute() {
        return true;
    }

    trimmed.starts_with("./")
        || trimmed.starts_with("../")
        || trimmed.starts_with("~/")
        || trimmed.starts_with(".\\")
        || trimmed.starts_with("..\\")
        || trimmed.starts_with("~\\")
        || is_windows_drive_path(trimmed)
        || trimmed.contains('/')
        || trimmed.contains('\\')
}

fn is_non_path_extension_source(value: &str) -> bool {
    if value.starts_with("npm:") || value.starts_with("git:") {
        return true;
    }

    if is_windows_drive_path(value) {
        return false;
    }

    let Some((scheme, _rest)) = value.split_once(':') else {
        return false;
    };
    !scheme.is_empty()
        && scheme
            .chars()
            .next()
            .is_some_and(|ch| ch.is_ascii_alphabetic())
        && scheme
            .chars()
            .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '+' | '-' | '.'))
}

fn is_windows_drive_path(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() >= 3
        && bytes[0].is_ascii_alphabetic()
        && bytes[1] == b':'
        && (bytes[2] == b'/' || bytes[2] == b'\\')
}

fn load_harness_settings(orchestra_root: &Path) -> Result<StoredHarnessSettings, String> {
    let path = orchestra_settings_path(orchestra_root);
    if !path.exists() {
        return Ok(StoredHarnessSettings::default());
    }

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Unable to read harness settings {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Unable to parse harness settings {}: {error}",
            path.display()
        )
    })
}

fn save_harness_settings(
    orchestra_root: &Path,
    settings: &StoredHarnessSettings,
) -> Result<(), String> {
    let path = orchestra_settings_path(orchestra_root);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create harness settings directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Unable to serialize harness settings: {error}"))?;
    fs::write(&path, content).map_err(|error| {
        format!(
            "Unable to write harness settings {}: {error}",
            path.display()
        )
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix)
    }

    #[test]
    fn stores_and_loads_pi_runtime_settings() {
        let root = unique_temp_dir("harness-settings");

        let saved = update_pi_runtime_settings_in(
            &root,
            vec![
                " ./extensions/custom.ts ".into(),
                "../extensions/other.ts".into(),
                "./extensions/custom.ts".into(),
                "".into(),
            ],
            Some(" 12% ".into()),
        )
        .expect("pi runtime settings should save");

        assert_eq!(
            saved.extra_extensions,
            vec![
                "./extensions/custom.ts".to_string(),
                "../extensions/other.ts".to_string()
            ]
        );
        assert_eq!(saved.default_compaction_window, "12%");
        assert!(saved.updated_at.is_some());

        let loaded = get_pi_runtime_settings_in(&root).expect("pi runtime settings should load");
        assert_eq!(loaded.extra_extensions, saved.extra_extensions);
        assert_eq!(loaded.default_compaction_window, "12%");
    }

    #[test]
    fn rejects_non_path_extensions_in_packaged_mode() {
        let blocked = blocked_packaged_mode_extensions_for_mode(
            true,
            &[
                "npm:pi-example".to_string(),
                "git:https://example.com/pkg.git".to_string(),
                "https://example.com/pkg.tgz".to_string(),
                "./extensions/local.ts".to_string(),
            ],
        );

        assert_eq!(
            blocked,
            vec![
                "npm:pi-example".to_string(),
                "git:https://example.com/pkg.git".to_string(),
                "https://example.com/pkg.tgz".to_string(),
            ]
        );
    }
}
