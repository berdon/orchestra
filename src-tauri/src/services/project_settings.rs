use std::{collections::HashMap, fs, path::Path};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    models::ProjectWorkerOverlay,
    services::orchestra_paths::{default_orchestra_root, project_settings_path, sanitize_slug},
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProjectSettings {
    #[serde(default)]
    agent_overlays: HashMap<String, StoredWorkerOverlay>,
    #[serde(default)]
    role_overlays: HashMap<String, StoredWorkerOverlay>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkerOverlay {
    prompt: Option<String>,
    updated_at: Option<String>,
}

pub fn get_worker_overlay(
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
) -> Result<ProjectWorkerOverlay, String> {
    let orchestra_root = default_orchestra_root()?;
    get_worker_overlay_in(&orchestra_root, project_slug, worker_type, worker_slug)
}

pub fn update_worker_overlay(
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
    prompt: Option<String>,
) -> Result<ProjectWorkerOverlay, String> {
    let orchestra_root = default_orchestra_root()?;
    update_worker_overlay_in(&orchestra_root, project_slug, worker_type, worker_slug, prompt)
}

pub fn get_worker_overlay_in(
    orchestra_root: &Path,
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
) -> Result<ProjectWorkerOverlay, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let normalized_worker_slug = sanitize_slug(worker_slug);
    let normalized_worker_type = normalize_worker_type(worker_type)?;
    let settings = load_project_settings(orchestra_root, &normalized_project_slug)?;
    let overlay = overlay_map(&settings, &normalized_worker_type)
        .get(&normalized_worker_slug)
        .cloned()
        .unwrap_or_default();

    Ok(ProjectWorkerOverlay {
        project_slug: normalized_project_slug,
        worker_type: normalized_worker_type,
        worker_slug: normalized_worker_slug,
        prompt: overlay.prompt,
        updated_at: overlay.updated_at,
    })
}

pub fn update_worker_overlay_in(
    orchestra_root: &Path,
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
    prompt: Option<String>,
) -> Result<ProjectWorkerOverlay, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let normalized_worker_slug = sanitize_slug(worker_slug);
    let normalized_worker_type = normalize_worker_type(worker_type)?;
    let mut settings = load_project_settings(orchestra_root, &normalized_project_slug)?;
    let overlay = StoredWorkerOverlay {
        prompt: normalize_optional_string(prompt),
        updated_at: Some(Utc::now().to_rfc3339()),
    };

    overlay_map_mut(&mut settings, &normalized_worker_type).insert(normalized_worker_slug.clone(), overlay.clone());
    save_project_settings(orchestra_root, &normalized_project_slug, &settings)?;

    Ok(ProjectWorkerOverlay {
        project_slug: normalized_project_slug,
        worker_type: normalized_worker_type,
        worker_slug: normalized_worker_slug,
        prompt: overlay.prompt,
        updated_at: overlay.updated_at,
    })
}

fn load_project_settings(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<StoredProjectSettings, String> {
    let path = project_settings_path(orchestra_root, project_slug);
    if !path.exists() {
        return Ok(StoredProjectSettings::default());
    }

    let content = fs::read_to_string(&path)
        .map_err(|error| format!("Unable to read project settings {}: {error}", path.display()))?;
    serde_json::from_str(&content)
        .map_err(|error| format!("Unable to parse project settings {}: {error}", path.display()))
}

fn save_project_settings(
    orchestra_root: &Path,
    project_slug: &str,
    settings: &StoredProjectSettings,
) -> Result<(), String> {
    let path = project_settings_path(orchestra_root, project_slug);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| format!("Unable to create project settings directory {}: {error}", parent.display()))?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Unable to serialize project settings: {error}"))?;
    fs::write(&path, content)
        .map_err(|error| format!("Unable to write project settings {}: {error}", path.display()))
}

fn overlay_map<'a>(
    settings: &'a StoredProjectSettings,
    worker_type: &str,
) -> &'a HashMap<String, StoredWorkerOverlay> {
    match worker_type {
        "agent" => &settings.agent_overlays,
        "role" => &settings.role_overlays,
        _ => unreachable!(),
    }
}

fn overlay_map_mut<'a>(
    settings: &'a mut StoredProjectSettings,
    worker_type: &str,
) -> &'a mut HashMap<String, StoredWorkerOverlay> {
    match worker_type {
        "agent" => &mut settings.agent_overlays,
        "role" => &mut settings.role_overlays,
        _ => unreachable!(),
    }
}

fn normalize_worker_type(worker_type: &str) -> Result<String, String> {
    let normalized = worker_type.trim().to_lowercase();
    if matches!(normalized.as_str(), "agent" | "role") {
        Ok(normalized)
    } else {
        Err("Worker type must be one of: agent, role.".into())
    }
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, path::PathBuf, time::{SystemTime, UNIX_EPOCH}};

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
    fn stores_and_loads_agent_and_role_overlays() {
        let root = unique_temp_dir("project-settings");

        let agent = update_worker_overlay_in(&root, "Orchestra", "agent", "Data", Some("Use td and keep commits small.".into()))
            .expect("agent overlay should save");
        assert_eq!(agent.project_slug, "orchestra");
        assert_eq!(agent.worker_slug, "data");
        assert_eq!(agent.prompt.as_deref(), Some("Use td and keep commits small."));

        let role = update_worker_overlay_in(&root, "Orchestra", "role", "Reviewer", Some("Prefer concise findings.".into()))
            .expect("role overlay should save");
        assert_eq!(role.worker_slug, "reviewer");

        let loaded_agent = get_worker_overlay_in(&root, "Orchestra", "agent", "Data")
            .expect("agent overlay should load");
        assert_eq!(loaded_agent.prompt.as_deref(), Some("Use td and keep commits small."));

        let loaded_role = get_worker_overlay_in(&root, "Orchestra", "role", "Reviewer")
            .expect("role overlay should load");
        assert_eq!(loaded_role.prompt.as_deref(), Some("Prefer concise findings."));
    }
}
