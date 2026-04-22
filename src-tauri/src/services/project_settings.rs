use std::{collections::HashMap, fs, path::Path};

use chrono::Utc;
use serde::{Deserialize, Serialize};

use crate::{
    models::{
        ProjectSessionPromptSettings, ProjectTaskAutomationSettings, ProjectWorkerOverlay,
        SessionPromptToken,
    },
    services::orchestra_paths::{default_orchestra_root, project_settings_path, sanitize_slug},
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredProjectSettings {
    #[serde(default)]
    agent_overlays: HashMap<String, StoredWorkerOverlay>,
    #[serde(default)]
    role_overlays: HashMap<String, StoredWorkerOverlay>,
    #[serde(default)]
    general: StoredGeneralSettings,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredGeneralSettings {
    task_session_context_template: Option<String>,
    #[serde(default = "default_auto_dispatch_on_blocker_completion")]
    auto_dispatch_on_blocker_completion: bool,
    updated_at: Option<String>,
}

impl Default for StoredGeneralSettings {
    fn default() -> Self {
        Self {
            task_session_context_template: None,
            auto_dispatch_on_blocker_completion: default_auto_dispatch_on_blocker_completion(),
            updated_at: None,
        }
    }
}

fn default_auto_dispatch_on_blocker_completion() -> bool {
    true
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkerOverlay {
    prompt: Option<String>,
    updated_at: Option<String>,
}

pub fn default_task_session_context_template() -> String {
    [
        "You are an agent working inside Orchestra on task {TASK.NUMBER} — {TASK.NAME}.",
        "",
        "Canonical task ID: {TASK.ID}",
        "Task slug: {TASK.SLUG}",
        "",
        "Orchestra is the project orchestration system. It tracks tasks, workflows, worker ownership, runtime sessions, comments, attachments, and transitions between steps of work. You are operating as a worker inside that system, so your job is not just to do good work — it is to keep Orchestra's state accurate as you work.",
        "",
        "Orchestra concepts you need to understand:\n- Task: the tracked unit of work you are responsible for right now. Tasks can have descriptions, comments, attachments, todos, subtasks, dependencies, and workflow history.\n- Workflow: the overall process definition attached to a task. A workflow contains ordered lanes and transition rules.\n- Lane: the current step of the workflow. Each lane has an owner type (user, role, or agent) and defines what should happen on success or failure.\n- Session: the running conversation/runtime for a worker. This session is the place where you reason, inspect task context, and decide how to move the task forward.\n- Transition: the explicit tool call that moves the task out of the current lane. You must always end your work by choosing the correct transition tool.",
        "",
        "Workflow: {WORKFLOW.NAME}",
        "Current lane: {LANE.NAME}",
        "Lane owner: {LANE.OWNER}",
        "Task status: {TASK.STATUS}",
        "Task assignee: {TASK.ASSIGNEE}",
        "Runtime cwd: {RUNTIME.CWD}",
        "",
        "As you do work - periodically comment on tasks to give an update on what you’re doing.",
        "",
        "{WORKER.CONTEXT}",
        "{TASK.DESCRIPTION}",
        "{TASK.BLOCKED_BY}",
        "{TASK.REPOSITORIES}",
        "{TASK.FILE_REFERENCES}",
        "{TASK.ATTACHMENTS}",
        "{TASK.TODOS}",
        "{TASK.COMMENTS}",
        "{LANE.INSTRUCTION}",
        "{ORCHESTRA.WORKING_RULES}",
        "{ORCHESTRA.TOOL_HELP}",
        "{ORCHESTRA.COMPLETION_RULES}",
    ]
    .join("\n")
}

pub fn available_session_prompt_tokens() -> Vec<SessionPromptToken> {
    vec![
        SessionPromptToken {
            token: "{TASK.ID}".into(),
            description: "Canonical Orchestra task id.".into(),
        },
        SessionPromptToken {
            token: "{TASK.NUMBER}".into(),
            description: "Human-readable task number such as <PROJECT_PREFIX>-42.".into(),
        },
        SessionPromptToken {
            token: "{TASK.SLUG}".into(),
            description: "Slugified task title for prompt customization.".into(),
        },
        SessionPromptToken {
            token: "{TASK.NAME}".into(),
            description: "Task title/name.".into(),
        },
        SessionPromptToken {
            token: "{TASK.STATUS}".into(),
            description: "Current task status.".into(),
        },
        SessionPromptToken {
            token: "{TASK.ASSIGNEE}".into(),
            description: "Current assignee label.".into(),
        },
        SessionPromptToken {
            token: "{TASK.DESCRIPTION}".into(),
            description: "Task description block when present.".into(),
        },
        SessionPromptToken {
            token: "{TASK.COMMENTS}".into(),
            description: "Recent task comments block.".into(),
        },
        SessionPromptToken {
            token: "{TASK.BLOCKED_BY}".into(),
            description: "Blocking tasks block.".into(),
        },
        SessionPromptToken {
            token: "{TASK.REPOSITORIES}".into(),
            description: "Task repositories block.".into(),
        },
        SessionPromptToken {
            token: "{TASK.FILE_REFERENCES}".into(),
            description: "Tracked project file references block.".into(),
        },
        SessionPromptToken {
            token: "{TASK.ATTACHMENTS}".into(),
            description: "Task attachments block.".into(),
        },
        SessionPromptToken {
            token: "{TASK.TODOS}".into(),
            description: "Task todo items block.".into(),
        },
        SessionPromptToken {
            token: "{WORKFLOW.NAME}".into(),
            description: "Workflow name.".into(),
        },
        SessionPromptToken {
            token: "{LANE.NAME}".into(),
            description: "Current lane name.".into(),
        },
        SessionPromptToken {
            token: "{LANE.OWNER}".into(),
            description: "Current lane owner type.".into(),
        },
        SessionPromptToken {
            token: "{LANE.INSTRUCTION}".into(),
            description: "Lane entry instruction block.".into(),
        },
        SessionPromptToken {
            token: "{WORKER.CONTEXT}".into(),
            description: "Worker-specific prompt context block including base and overlay prompts."
                .into(),
        },
        SessionPromptToken {
            token: "{RUNTIME.CWD}".into(),
            description: "Resolved task workspace cwd for the current lane.".into(),
        },
        SessionPromptToken {
            token: "{ORCHESTRA.WORKING_RULES}".into(),
            description: "Standard Orchestra working rules block.".into(),
        },
        SessionPromptToken {
            token: "{ORCHESTRA.TOOL_HELP}".into(),
            description: "Standard Orchestra task tool help block.".into(),
        },
        SessionPromptToken {
            token: "{ORCHESTRA.COMPLETION_RULES}".into(),
            description: "Standard Orchestra completion rules block.".into(),
        },
    ]
}

pub fn get_session_prompt_settings(
    project_slug: &str,
) -> Result<ProjectSessionPromptSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_session_prompt_settings_in(&orchestra_root, project_slug)
}

pub fn update_session_prompt_settings(
    project_slug: &str,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_session_prompt_settings_in(&orchestra_root, project_slug, template)
}

pub fn get_worker_overlay(
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
) -> Result<ProjectWorkerOverlay, String> {
    let orchestra_root = default_orchestra_root()?;
    get_worker_overlay_in(&orchestra_root, project_slug, worker_type, worker_slug)
}

pub fn get_task_automation_settings(
    project_slug: &str,
) -> Result<ProjectTaskAutomationSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_task_automation_settings_in(&orchestra_root, project_slug)
}

pub fn update_task_automation_settings(
    project_slug: &str,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_task_automation_settings_in(
        &orchestra_root,
        project_slug,
        auto_dispatch_on_blocker_completion,
    )
}

pub fn update_worker_overlay(
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
    prompt: Option<String>,
) -> Result<ProjectWorkerOverlay, String> {
    let orchestra_root = default_orchestra_root()?;
    update_worker_overlay_in(
        &orchestra_root,
        project_slug,
        worker_type,
        worker_slug,
        prompt,
    )
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

pub fn get_session_prompt_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<ProjectSessionPromptSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let settings = load_project_settings(orchestra_root, &normalized_project_slug)?;
    let default_template = default_task_session_context_template();
    Ok(ProjectSessionPromptSettings {
        project_slug: normalized_project_slug,
        template: settings
            .general
            .task_session_context_template
            .clone()
            .unwrap_or_else(|| default_template.clone()),
        default_template,
        available_tokens: available_session_prompt_tokens(),
        updated_at: settings.general.updated_at,
    })
}

pub fn update_session_prompt_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let mut settings = load_project_settings(orchestra_root, &normalized_project_slug)?;
    settings.general.task_session_context_template = normalize_optional_string(template);
    settings.general.updated_at = Some(Utc::now().to_rfc3339());
    save_project_settings(orchestra_root, &normalized_project_slug, &settings)?;
    get_session_prompt_settings_in(orchestra_root, &normalized_project_slug)
}

pub fn get_task_automation_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<ProjectTaskAutomationSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let settings = load_project_settings(orchestra_root, &normalized_project_slug)?;
    Ok(ProjectTaskAutomationSettings {
        project_slug: normalized_project_slug,
        auto_dispatch_on_blocker_completion: settings.general.auto_dispatch_on_blocker_completion,
        updated_at: settings.general.updated_at,
    })
}

pub fn update_task_automation_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let mut settings = load_project_settings(orchestra_root, &normalized_project_slug)?;
    settings.general.auto_dispatch_on_blocker_completion = auto_dispatch_on_blocker_completion;
    settings.general.updated_at = Some(Utc::now().to_rfc3339());
    save_project_settings(orchestra_root, &normalized_project_slug, &settings)?;
    get_task_automation_settings_in(orchestra_root, &normalized_project_slug)
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

    overlay_map_mut(&mut settings, &normalized_worker_type)
        .insert(normalized_worker_slug.clone(), overlay.clone());
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

    let content = fs::read_to_string(&path).map_err(|error| {
        format!(
            "Unable to read project settings {}: {error}",
            path.display()
        )
    })?;
    serde_json::from_str(&content).map_err(|error| {
        format!(
            "Unable to parse project settings {}: {error}",
            path.display()
        )
    })
}

fn save_project_settings(
    orchestra_root: &Path,
    project_slug: &str,
    settings: &StoredProjectSettings,
) -> Result<(), String> {
    let path = project_settings_path(orchestra_root, project_slug);
    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create project settings directory {}: {error}",
                parent.display()
            )
        })?;
    }

    let content = serde_json::to_string_pretty(settings)
        .map_err(|error| format!("Unable to serialize project settings: {error}"))?;
    fs::write(&path, content).map_err(|error| {
        format!(
            "Unable to write project settings {}: {error}",
            path.display()
        )
    })
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
    fn stores_and_loads_session_prompt_settings() {
        let root = unique_temp_dir("project-session-prompt-settings");

        let saved = update_session_prompt_settings_in(
            &root,
            "Orchestra",
            Some("Task {TASK.ID} {TASK.NAME}".into()),
        )
        .expect("session prompt settings should save");
        assert_eq!(saved.project_slug, "orchestra");
        assert_eq!(saved.template, "Task {TASK.ID} {TASK.NAME}");
        assert!(saved
            .available_tokens
            .iter()
            .any(|token| token.token == "{TASK.ID}"));

        let loaded = get_session_prompt_settings_in(&root, "Orchestra")
            .expect("session prompt settings should load");
        assert_eq!(loaded.template, "Task {TASK.ID} {TASK.NAME}");
        assert!(loaded.default_template.contains("{TASK.NUMBER}"));
        assert!(loaded
            .default_template
            .contains("As you do work - periodically comment on tasks to give an update on what you’re doing."));
    }

    #[test]
    fn stores_and_loads_agent_and_role_overlays() {
        let root = unique_temp_dir("project-settings");

        let agent = update_worker_overlay_in(
            &root,
            "Orchestra",
            "agent",
            "Data",
            Some("Use td and keep commits small.".into()),
        )
        .expect("agent overlay should save");
        assert_eq!(agent.project_slug, "orchestra");
        assert_eq!(agent.worker_slug, "data");
        assert_eq!(
            agent.prompt.as_deref(),
            Some("Use td and keep commits small.")
        );

        let role = update_worker_overlay_in(
            &root,
            "Orchestra",
            "role",
            "Reviewer",
            Some("Prefer concise findings.".into()),
        )
        .expect("role overlay should save");
        assert_eq!(role.worker_slug, "reviewer");

        let loaded_agent = get_worker_overlay_in(&root, "Orchestra", "agent", "Data")
            .expect("agent overlay should load");
        assert_eq!(
            loaded_agent.prompt.as_deref(),
            Some("Use td and keep commits small.")
        );

        let loaded_role = get_worker_overlay_in(&root, "Orchestra", "role", "Reviewer")
            .expect("role overlay should load");
        assert_eq!(
            loaded_role.prompt.as_deref(),
            Some("Prefer concise findings.")
        );
    }
}
