use std::{fs, path::Path};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    models::PiRuntimeSettings,
    services::orchestra_paths::{default_orchestra_root, orchestra_settings_path},
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
    updated_at: Option<String>,
}

pub fn get_pi_runtime_settings() -> Result<PiRuntimeSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_pi_runtime_settings_in(&orchestra_root)
}

pub fn update_pi_runtime_settings(
    extra_extensions: Vec<String>,
) -> Result<PiRuntimeSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_pi_runtime_settings_in(&orchestra_root, extra_extensions)
}

pub fn get_pi_runtime_settings_in(orchestra_root: &Path) -> Result<PiRuntimeSettings, String> {
    let settings = load_harness_settings(orchestra_root)?;
    Ok(PiRuntimeSettings {
        extra_extensions: settings.harness.pi.extra_extensions,
        updated_at: settings.harness.pi.updated_at,
    })
}

pub fn update_pi_runtime_settings_in(
    orchestra_root: &Path,
    extra_extensions: Vec<String>,
) -> Result<PiRuntimeSettings, String> {
    let mut settings = load_harness_settings(orchestra_root)?;
    settings.harness.pi.extra_extensions = normalize_extensions(extra_extensions);
    settings.harness.pi.updated_at = Some(Utc::now().to_rfc3339());
    save_harness_settings(orchestra_root, &settings)?;
    get_pi_runtime_settings_in(orchestra_root)
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
                "npm:pi-example".into(),
                " ./extensions/custom.ts ".into(),
                "npm:pi-example".into(),
                "".into(),
            ],
        )
        .expect("pi runtime settings should save");

        assert_eq!(
            saved.extra_extensions,
            vec![
                "npm:pi-example".to_string(),
                "./extensions/custom.ts".to_string()
            ]
        );
        assert!(saved.updated_at.is_some());

        let loaded = get_pi_runtime_settings_in(&root).expect("pi runtime settings should load");
        assert_eq!(loaded.extra_extensions, saved.extra_extensions);
    }
}
