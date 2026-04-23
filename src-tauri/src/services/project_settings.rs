use std::{
    collections::{BTreeSet, HashMap},
    fs,
    path::Path,
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::{
    models::{
        ProjectSessionPromptSettings, ProjectSourceControlSettings, ProjectTaskAutomationSettings,
        ProjectWorkerOverlay, SessionPromptToken, SourceControlSettings,
    },
    services::{
        database,
        orchestra_paths::{
            default_orchestra_root, orchestra_database_path, project_settings_path, sanitize_slug,
        },
        projects,
    },
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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct StoredWorkerOverlay {
    prompt: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
struct ProjectRuntimeSettingsRecord {
    task_session_context_template: Option<String>,
    auto_dispatch_on_blocker_completion: bool,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
    updated_at: Option<String>,
}

impl Default for ProjectRuntimeSettingsRecord {
    fn default() -> Self {
        Self {
            task_session_context_template: None,
            auto_dispatch_on_blocker_completion: default_auto_dispatch_on_blocker_completion(),
            git_user_name_template: None,
            git_email_template: None,
            updated_at: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct SourceControlSettingsRecord {
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone, Default)]
pub struct SourceControlTemplateContext {
    pub role_slug: Option<String>,
    pub agent_slug: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum SourceControlFieldOrigin {
    ProjectOverride,
    GlobalDefault,
    Unset,
}

impl SourceControlFieldOrigin {
    fn label(self) -> &'static str {
        match self {
            Self::ProjectOverride => "project override",
            Self::GlobalDefault => "global default",
            Self::Unset => "unset",
        }
    }
}

#[derive(Debug, Clone)]
pub struct ResolvedSourceControlSettings {
    pub git_user_name: Option<String>,
    pub git_email: Option<String>,
    git_user_name_origin: SourceControlFieldOrigin,
    git_email_origin: SourceControlFieldOrigin,
}

impl Default for ResolvedSourceControlSettings {
    fn default() -> Self {
        Self {
            git_user_name: None,
            git_email: None,
            git_user_name_origin: SourceControlFieldOrigin::Unset,
            git_email_origin: SourceControlFieldOrigin::Unset,
        }
    }
}

impl ResolvedSourceControlSettings {
    pub fn git_user_name_origin_label(&self) -> &'static str {
        self.git_user_name_origin.label()
    }

    pub fn git_email_origin_label(&self) -> &'static str {
        self.git_email_origin.label()
    }
}

fn default_auto_dispatch_on_blocker_completion() -> bool {
    true
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
        "{SOURCE_CONTROL.CONTEXT}",
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
            token: "{SOURCE_CONTROL.CONTEXT}".into(),
            description: "Rendered block summarizing the effective git identity for the current project and worker context.".into(),
        },
        SessionPromptToken {
            token: "{SOURCE_CONTROL.GIT.USER_NAME}".into(),
            description: "Resolved git user.name value after project/global precedence and {role}/{agent} substitution.".into(),
        },
        SessionPromptToken {
            token: "{SOURCE_CONTROL.GIT.EMAIL}".into(),
            description: "Resolved git user.email value after project/global precedence and {role}/{agent} substitution.".into(),
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

pub fn get_source_control_settings() -> Result<SourceControlSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_source_control_settings_in(&orchestra_root)
}

pub fn get_source_control_settings_in(
    orchestra_root: &Path,
) -> Result<SourceControlSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    get_source_control_settings_with_connection(&connection)
}

pub fn update_source_control_settings(
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<SourceControlSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_source_control_settings_in(&orchestra_root, git_user_name_template, git_email_template)
}

pub fn update_source_control_settings_in(
    orchestra_root: &Path,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<SourceControlSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    update_source_control_settings_with_connection(
        &connection,
        git_user_name_template,
        git_email_template,
    )
}

pub fn get_session_prompt_settings(
    project_slug: &str,
) -> Result<ProjectSessionPromptSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_session_prompt_settings_in(&orchestra_root, project_slug)
}

pub fn get_session_prompt_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<ProjectSessionPromptSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    get_session_prompt_settings_with_connection(&connection, Some(orchestra_root), project_slug)
}

pub(crate) fn get_session_prompt_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
) -> Result<ProjectSessionPromptSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let runtime_settings = get_or_import_project_runtime_settings(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )?;
    let default_template = default_task_session_context_template();
    Ok(ProjectSessionPromptSettings {
        project_slug: normalized_project_slug,
        template: runtime_settings
            .task_session_context_template
            .unwrap_or_else(|| default_template.clone()),
        default_template,
        available_tokens: available_session_prompt_tokens(),
        updated_at: runtime_settings.updated_at,
    })
}

pub fn update_session_prompt_settings(
    project_slug: &str,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_session_prompt_settings_in(&orchestra_root, project_slug, template)
}

pub fn update_session_prompt_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    update_session_prompt_settings_with_connection(
        &connection,
        Some(orchestra_root),
        project_slug,
        template,
    )
}

pub(crate) fn update_session_prompt_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let project_id = require_project_id_by_slug(connection, &normalized_project_slug)?;
    let mut runtime_settings = get_or_import_project_runtime_settings(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )?;
    runtime_settings.task_session_context_template = normalize_optional_string(template);
    runtime_settings.updated_at = Some(Utc::now().to_rfc3339());
    upsert_project_runtime_settings(connection, &project_id, &runtime_settings)?;
    get_session_prompt_settings_with_connection(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )
}

pub fn get_task_automation_settings(
    project_slug: &str,
) -> Result<ProjectTaskAutomationSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_task_automation_settings_in(&orchestra_root, project_slug)
}

pub fn get_task_automation_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<ProjectTaskAutomationSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    get_task_automation_settings_with_connection(&connection, Some(orchestra_root), project_slug)
}

pub(crate) fn get_task_automation_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
) -> Result<ProjectTaskAutomationSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let runtime_settings = get_or_import_project_runtime_settings(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )?;
    Ok(ProjectTaskAutomationSettings {
        project_slug: normalized_project_slug,
        auto_dispatch_on_blocker_completion: runtime_settings.auto_dispatch_on_blocker_completion,
        updated_at: runtime_settings.updated_at,
    })
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

pub fn update_task_automation_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    update_task_automation_settings_with_connection(
        &connection,
        Some(orchestra_root),
        project_slug,
        auto_dispatch_on_blocker_completion,
    )
}

pub(crate) fn update_task_automation_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let project_id = require_project_id_by_slug(connection, &normalized_project_slug)?;
    let mut runtime_settings = get_or_import_project_runtime_settings(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )?;
    runtime_settings.auto_dispatch_on_blocker_completion = auto_dispatch_on_blocker_completion;
    runtime_settings.updated_at = Some(Utc::now().to_rfc3339());
    upsert_project_runtime_settings(connection, &project_id, &runtime_settings)?;
    get_task_automation_settings_with_connection(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )
}

pub fn get_project_source_control_settings(
    project_slug: &str,
) -> Result<ProjectSourceControlSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    get_project_source_control_settings_in(&orchestra_root, project_slug)
}

pub fn get_project_source_control_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
) -> Result<ProjectSourceControlSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    get_project_source_control_settings_with_connection(
        &connection,
        Some(orchestra_root),
        project_slug,
    )
}

pub(crate) fn get_project_source_control_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
) -> Result<ProjectSourceControlSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let runtime_settings = get_or_import_project_runtime_settings(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )?;
    Ok(ProjectSourceControlSettings {
        project_slug: normalized_project_slug,
        git_user_name_template: runtime_settings.git_user_name_template,
        git_email_template: runtime_settings.git_email_template,
        updated_at: runtime_settings.updated_at,
    })
}

pub fn update_project_source_control_settings(
    project_slug: &str,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    let orchestra_root = default_orchestra_root()?;
    update_project_source_control_settings_in(
        &orchestra_root,
        project_slug,
        git_user_name_template,
        git_email_template,
    )
}

pub fn update_project_source_control_settings_in(
    orchestra_root: &Path,
    project_slug: &str,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    let connection = open_root_connection(orchestra_root)?;
    update_project_source_control_settings_with_connection(
        &connection,
        Some(orchestra_root),
        project_slug,
        git_user_name_template,
        git_email_template,
    )
}

pub(crate) fn update_project_source_control_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let project_id = require_project_id_by_slug(connection, &normalized_project_slug)?;
    let mut runtime_settings = get_or_import_project_runtime_settings(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )?;
    runtime_settings.git_user_name_template = normalize_and_validate_source_control_template(
        git_user_name_template,
        "project git user.name template",
    )?;
    runtime_settings.git_email_template = normalize_and_validate_source_control_template(
        git_email_template,
        "project git email template",
    )?;
    runtime_settings.updated_at = Some(Utc::now().to_rfc3339());
    upsert_project_runtime_settings(connection, &project_id, &runtime_settings)?;
    get_project_source_control_settings_with_connection(
        connection,
        orchestra_root,
        &normalized_project_slug,
    )
}

pub fn get_worker_overlay(
    project_slug: &str,
    worker_type: &str,
    worker_slug: &str,
) -> Result<ProjectWorkerOverlay, String> {
    let orchestra_root = default_orchestra_root()?;
    get_worker_overlay_in(&orchestra_root, project_slug, worker_type, worker_slug)
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
    let settings = load_legacy_project_settings(orchestra_root, &normalized_project_slug)?;
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
    let mut settings = load_legacy_project_settings(orchestra_root, &normalized_project_slug)?;
    let overlay = StoredWorkerOverlay {
        prompt: normalize_optional_string(prompt),
        updated_at: Some(Utc::now().to_rfc3339()),
    };

    overlay_map_mut(&mut settings, &normalized_worker_type)
        .insert(normalized_worker_slug.clone(), overlay.clone());
    save_legacy_project_settings(orchestra_root, &normalized_project_slug, &settings)?;

    Ok(ProjectWorkerOverlay {
        project_slug: normalized_project_slug,
        worker_type: normalized_worker_type,
        worker_slug: normalized_worker_slug,
        prompt: overlay.prompt,
        updated_at: overlay.updated_at,
    })
}

pub(crate) fn resolve_effective_source_control_settings_with_connection(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: Option<&str>,
    context: &SourceControlTemplateContext,
) -> Result<ResolvedSourceControlSettings, String> {
    let global_settings = load_source_control_settings_record(connection)?;
    let project_settings = if let Some(project_slug) = project_slug {
        Some(get_or_import_project_runtime_settings(
            connection,
            orchestra_root,
            &sanitize_slug(project_slug),
        )?)
    } else {
        None
    };
    Ok(resolve_effective_source_control_settings_from_records(
        &global_settings,
        project_settings.as_ref(),
        context,
    ))
}

pub fn render_source_control_context_block(settings: &ResolvedSourceControlSettings) -> String {
    let user_name_line = settings
        .git_user_name
        .as_deref()
        .map(|value| {
            format!(
                "- git user.name: {} ({})",
                value,
                settings.git_user_name_origin_label()
            )
        })
        .unwrap_or_else(|| "- git user.name: not configured".into());
    let email_line = settings
        .git_email
        .as_deref()
        .map(|value| {
            format!(
                "- git user.email: {} ({})",
                value,
                settings.git_email_origin_label()
            )
        })
        .unwrap_or_else(|| "- git user.email: not configured".into());

    format!(
        "Source control identity:\n{}\n{}",
        user_name_line, email_line
    )
}

fn get_source_control_settings_with_connection(
    connection: &Connection,
) -> Result<SourceControlSettings, String> {
    let settings = load_source_control_settings_record(connection)?;
    Ok(SourceControlSettings {
        git_user_name_template: settings.git_user_name_template,
        git_email_template: settings.git_email_template,
        updated_at: settings.updated_at,
    })
}

pub(crate) fn update_source_control_settings_with_connection(
    connection: &Connection,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<SourceControlSettings, String> {
    let settings = SourceControlSettingsRecord {
        git_user_name_template: normalize_and_validate_source_control_template(
            git_user_name_template,
            "global git user.name template",
        )?,
        git_email_template: normalize_and_validate_source_control_template(
            git_email_template,
            "global git email template",
        )?,
        updated_at: Some(Utc::now().to_rfc3339()),
    };
    upsert_source_control_settings(connection, &settings)?;
    get_source_control_settings_with_connection(connection)
}

fn get_or_import_project_runtime_settings(
    connection: &Connection,
    orchestra_root: Option<&Path>,
    project_slug: &str,
) -> Result<ProjectRuntimeSettingsRecord, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    let project_id = require_project_id_by_slug(connection, &normalized_project_slug)?;
    if let Some(existing) = load_project_runtime_settings(connection, &project_id)? {
        return Ok(existing);
    }

    if let Some(orchestra_root) = orchestra_root {
        let legacy = load_legacy_project_settings(orchestra_root, &normalized_project_slug)?;
        let has_legacy_runtime_values = legacy.general.task_session_context_template.is_some()
            || legacy.general.updated_at.is_some()
            || legacy.general.auto_dispatch_on_blocker_completion
                != default_auto_dispatch_on_blocker_completion();
        if has_legacy_runtime_values {
            let imported = ProjectRuntimeSettingsRecord {
                task_session_context_template: normalize_optional_string(
                    legacy.general.task_session_context_template,
                ),
                auto_dispatch_on_blocker_completion: legacy
                    .general
                    .auto_dispatch_on_blocker_completion,
                git_user_name_template: None,
                git_email_template: None,
                updated_at: legacy.general.updated_at,
            };
            upsert_project_runtime_settings(connection, &project_id, &imported)?;
            return Ok(imported);
        }
    }

    Ok(ProjectRuntimeSettingsRecord::default())
}

fn require_project_id_by_slug(
    connection: &Connection,
    project_slug: &str,
) -> Result<String, String> {
    let normalized_project_slug = sanitize_slug(project_slug);
    projects::get_project_by_slug(connection, &normalized_project_slug)?
        .map(|project| project.id)
        .ok_or_else(|| format!("Project slug {} was not found", normalized_project_slug))
}

fn load_project_runtime_settings(
    connection: &Connection,
    project_id: &str,
) -> Result<Option<ProjectRuntimeSettingsRecord>, String> {
    connection
        .query_row(
            r#"
            SELECT
                task_session_context_template,
                auto_dispatch_on_blocker_completion,
                git_user_name_template,
                git_email_template,
                updated_at
            FROM project_runtime_settings
            WHERE project_id = ?1
            "#,
            [project_id],
            |row| {
                Ok(ProjectRuntimeSettingsRecord {
                    task_session_context_template: row.get(0)?,
                    auto_dispatch_on_blocker_completion: row.get::<_, i64>(1)? != 0,
                    git_user_name_template: row.get(2)?,
                    git_email_template: row.get(3)?,
                    updated_at: row.get(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to query runtime settings for project {}: {error}",
                project_id
            )
        })
}

fn upsert_project_runtime_settings(
    connection: &Connection,
    project_id: &str,
    settings: &ProjectRuntimeSettingsRecord,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO project_runtime_settings (
                project_id,
                task_session_context_template,
                auto_dispatch_on_blocker_completion,
                git_user_name_template,
                git_email_template,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6)
            ON CONFLICT(project_id) DO UPDATE SET
                task_session_context_template = excluded.task_session_context_template,
                auto_dispatch_on_blocker_completion = excluded.auto_dispatch_on_blocker_completion,
                git_user_name_template = excluded.git_user_name_template,
                git_email_template = excluded.git_email_template,
                updated_at = excluded.updated_at
            "#,
            params![
                project_id,
                settings.task_session_context_template.as_deref(),
                if settings.auto_dispatch_on_blocker_completion {
                    1
                } else {
                    0
                },
                settings.git_user_name_template.as_deref(),
                settings.git_email_template.as_deref(),
                settings.updated_at.as_deref(),
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to save runtime settings for project {}: {error}",
                project_id
            )
        })?;
    Ok(())
}

fn load_source_control_settings_record(
    connection: &Connection,
) -> Result<SourceControlSettingsRecord, String> {
    connection
        .query_row(
            r#"
            SELECT git_user_name_template, git_email_template, updated_at
            FROM source_control_settings
            WHERE id = 1
            "#,
            [],
            |row| {
                Ok(SourceControlSettingsRecord {
                    git_user_name_template: row.get(0)?,
                    git_email_template: row.get(1)?,
                    updated_at: row.get(2)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query source control settings: {error}"))
        .map(|settings| settings.unwrap_or_default())
}

fn upsert_source_control_settings(
    connection: &Connection,
    settings: &SourceControlSettingsRecord,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            INSERT INTO source_control_settings (
                id,
                git_user_name_template,
                git_email_template,
                updated_at
            )
            VALUES (1, ?1, ?2, ?3)
            ON CONFLICT(id) DO UPDATE SET
                git_user_name_template = excluded.git_user_name_template,
                git_email_template = excluded.git_email_template,
                updated_at = excluded.updated_at
            "#,
            params![
                settings.git_user_name_template.as_deref(),
                settings.git_email_template.as_deref(),
                settings.updated_at.as_deref(),
            ],
        )
        .map_err(|error| format!("Unable to save source control settings: {error}"))?;
    Ok(())
}

fn resolve_effective_source_control_settings_from_records(
    global_settings: &SourceControlSettingsRecord,
    project_settings: Option<&ProjectRuntimeSettingsRecord>,
    context: &SourceControlTemplateContext,
) -> ResolvedSourceControlSettings {
    let (user_name_template, user_name_origin) = effective_source_control_template(
        project_settings.and_then(|settings| settings.git_user_name_template.clone()),
        global_settings.git_user_name_template.clone(),
    );
    let (email_template, email_origin) = effective_source_control_template(
        project_settings.and_then(|settings| settings.git_email_template.clone()),
        global_settings.git_email_template.clone(),
    );

    ResolvedSourceControlSettings {
        git_user_name: user_name_template
            .as_deref()
            .and_then(|template| resolve_source_control_template(template, context)),
        git_email: email_template
            .as_deref()
            .and_then(|template| resolve_source_control_template(template, context)),
        git_user_name_origin: user_name_origin,
        git_email_origin: email_origin,
    }
}

fn effective_source_control_template(
    project_template: Option<String>,
    global_template: Option<String>,
) -> (Option<String>, SourceControlFieldOrigin) {
    if let Some(template) =
        project_template.and_then(|value| normalize_optional_string(Some(value)))
    {
        return (Some(template), SourceControlFieldOrigin::ProjectOverride);
    }
    if let Some(template) = global_template.and_then(|value| normalize_optional_string(Some(value)))
    {
        return (Some(template), SourceControlFieldOrigin::GlobalDefault);
    }
    (None, SourceControlFieldOrigin::Unset)
}

fn resolve_source_control_template(
    template: &str,
    context: &SourceControlTemplateContext,
) -> Option<String> {
    let resolved = template
        .replace("{role}", context.role_slug.as_deref().unwrap_or(""))
        .replace("{agent}", context.agent_slug.as_deref().unwrap_or(""));
    let trimmed = resolved.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed.to_string())
    }
}

fn normalize_and_validate_source_control_template(
    value: Option<String>,
    field_label: &str,
) -> Result<Option<String>, String> {
    let normalized = normalize_optional_string(value);
    validate_source_control_template(normalized.as_deref(), field_label)?;
    Ok(normalized)
}

fn validate_source_control_template(
    template: Option<&str>,
    field_label: &str,
) -> Result<(), String> {
    let Some(template) = template else {
        return Ok(());
    };
    let unknown_variables = unknown_source_control_variables(template);
    if unknown_variables.is_empty() {
        return Ok(());
    }
    Err(format!(
        "Unknown template variables in {}: {}. Supported variables: {{role}}, {{agent}}.",
        field_label,
        unknown_variables.into_iter().collect::<Vec<_>>().join(", ")
    ))
}

fn unknown_source_control_variables(template: &str) -> BTreeSet<String> {
    let mut unknown_variables = BTreeSet::new();
    let mut remaining = template;

    while let Some(start) = remaining.find('{') {
        let after_start = &remaining[start + 1..];
        let Some(end) = after_start.find('}') else {
            break;
        };
        let candidate = &after_start[..end];
        if !candidate.is_empty() && !matches!(candidate, "role" | "agent") {
            unknown_variables.insert(format!("{{{candidate}}}"));
        }
        remaining = &after_start[end + 1..];
    }

    unknown_variables
}

fn open_root_connection(orchestra_root: &Path) -> Result<Connection, String> {
    database::open_connection_at(&orchestra_database_path(orchestra_root))
}

fn load_legacy_project_settings(
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

fn save_legacy_project_settings(
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

    fn connection_with_project(project_slug: &str) -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        crate::services::database::apply_migrations(&connection).expect("apply migrations");
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', ?1, 'Project', NULL, 'PRJ', NULL, ?2, ?2)",
                params![sanitize_slug(project_slug), now],
            )
            .expect("project should insert");
        connection
    }

    #[test]
    fn stores_and_loads_global_source_control_settings() {
        let connection = connection_with_project("orchestra");

        let saved = update_source_control_settings_with_connection(
            &connection,
            Some("Orchestra {role}".into()),
            Some("orchestra+{role}{agent}@example.com".into()),
        )
        .expect("source control settings should save");
        assert_eq!(
            saved.git_user_name_template.as_deref(),
            Some("Orchestra {role}")
        );
        assert_eq!(
            saved.git_email_template.as_deref(),
            Some("orchestra+{role}{agent}@example.com")
        );

        let loaded = get_source_control_settings_with_connection(&connection)
            .expect("source control settings should load");
        assert_eq!(
            loaded.git_user_name_template.as_deref(),
            Some("Orchestra {role}")
        );
        assert_eq!(
            loaded.git_email_template.as_deref(),
            Some("orchestra+{role}{agent}@example.com")
        );
    }

    #[test]
    fn stores_and_loads_project_runtime_settings_from_database() {
        let connection = connection_with_project("orchestra");

        let prompt_settings = update_session_prompt_settings_with_connection(
            &connection,
            None,
            "orchestra",
            Some("Task {TASK.ID}".into()),
        )
        .expect("session prompt settings should save");
        assert_eq!(prompt_settings.template, "Task {TASK.ID}");

        let automation =
            update_task_automation_settings_with_connection(&connection, None, "orchestra", false)
                .expect("automation settings should save");
        assert!(!automation.auto_dispatch_on_blocker_completion);

        let source_control = update_project_source_control_settings_with_connection(
            &connection,
            None,
            "orchestra",
            Some("Project {role}".into()),
            Some("project+{role}{agent}@example.com".into()),
        )
        .expect("project source control settings should save");
        assert_eq!(
            source_control.git_user_name_template.as_deref(),
            Some("Project {role}")
        );
        assert_eq!(
            source_control.git_email_template.as_deref(),
            Some("project+{role}{agent}@example.com")
        );

        let reloaded_prompt =
            get_session_prompt_settings_with_connection(&connection, None, "orchestra")
                .expect("session prompt settings should reload");
        assert_eq!(reloaded_prompt.template, "Task {TASK.ID}");
        assert!(reloaded_prompt
            .available_tokens
            .iter()
            .any(|token| token.token == "{SOURCE_CONTROL.CONTEXT}"));

        let reloaded_automation =
            get_task_automation_settings_with_connection(&connection, None, "orchestra")
                .expect("automation settings should reload");
        assert!(!reloaded_automation.auto_dispatch_on_blocker_completion);

        let reloaded_source_control =
            get_project_source_control_settings_with_connection(&connection, None, "orchestra")
                .expect("project source control settings should reload");
        assert_eq!(
            reloaded_source_control.git_user_name_template.as_deref(),
            Some("Project {role}")
        );
        assert_eq!(
            reloaded_source_control.git_email_template.as_deref(),
            Some("project+{role}{agent}@example.com")
        );
    }

    #[test]
    fn imports_legacy_project_runtime_settings_into_database() {
        let root = unique_temp_dir("legacy-project-runtime-settings");
        let connection = database::open_connection_at(&orchestra_database_path(&root))
            .expect("database should open");
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should insert");
        save_legacy_project_settings(
            &root,
            "orchestra",
            &StoredProjectSettings {
                agent_overlays: HashMap::new(),
                role_overlays: HashMap::new(),
                general: StoredGeneralSettings {
                    task_session_context_template: Some("Legacy {TASK.ID}".into()),
                    auto_dispatch_on_blocker_completion: false,
                    updated_at: Some(now.clone()),
                },
            },
        )
        .expect("legacy settings should save");

        let prompt_settings = get_session_prompt_settings_in(&root, "orchestra")
            .expect("legacy prompt settings should import");
        assert_eq!(prompt_settings.template, "Legacy {TASK.ID}");

        let automation = get_task_automation_settings_in(&root, "orchestra")
            .expect("legacy automation settings should import");
        assert!(!automation.auto_dispatch_on_blocker_completion);

        let runtime_settings = load_project_runtime_settings(&connection, "project-1")
            .expect("runtime settings should query")
            .expect("runtime settings row should exist");
        assert_eq!(
            runtime_settings.task_session_context_template.as_deref(),
            Some("Legacy {TASK.ID}")
        );
        assert!(!runtime_settings.auto_dispatch_on_blocker_completion);
    }

    #[test]
    fn resolves_effective_source_control_settings_with_precedence_and_context() {
        let connection = connection_with_project("orchestra");
        update_source_control_settings_with_connection(
            &connection,
            Some("Global {role}".into()),
            Some("global+{role}{agent}@example.com".into()),
        )
        .expect("global settings should save");
        update_project_source_control_settings_with_connection(
            &connection,
            None,
            "orchestra",
            None,
            Some("project+{role}{agent}@example.com".into()),
        )
        .expect("project settings should save");

        let role_context = resolve_effective_source_control_settings_with_connection(
            &connection,
            None,
            Some("orchestra"),
            &SourceControlTemplateContext {
                role_slug: Some("architect".into()),
                agent_slug: None,
            },
        )
        .expect("role context should resolve");
        assert_eq!(
            role_context.git_user_name.as_deref(),
            Some("Global architect")
        );
        assert_eq!(
            role_context.git_email.as_deref(),
            Some("project+architect@example.com")
        );
        assert_eq!(role_context.git_user_name_origin_label(), "global default");
        assert_eq!(role_context.git_email_origin_label(), "project override");

        let agent_context = resolve_effective_source_control_settings_with_connection(
            &connection,
            None,
            Some("orchestra"),
            &SourceControlTemplateContext {
                role_slug: None,
                agent_slug: Some("reviewer".into()),
            },
        )
        .expect("agent context should resolve");
        assert_eq!(agent_context.git_user_name.as_deref(), Some("Global"));
        assert_eq!(
            agent_context.git_email.as_deref(),
            Some("project+reviewer@example.com")
        );
    }

    #[test]
    fn rejects_unknown_source_control_template_variables() {
        let connection = connection_with_project("orchestra");

        let global_error = update_source_control_settings_with_connection(
            &connection,
            Some("Bad {team}".into()),
            None,
        )
        .expect_err("unknown global variables should fail");
        assert!(global_error.contains("{team}"));

        let project_error = update_project_source_control_settings_with_connection(
            &connection,
            None,
            "orchestra",
            None,
            Some("Bad {worker}@example.com".into()),
        )
        .expect_err("unknown project variables should fail");
        assert!(project_error.contains("{worker}"));

        let resolved = resolve_source_control_template(
            "Legacy {role} {worker}",
            &SourceControlTemplateContext {
                role_slug: Some("architect".into()),
                agent_slug: None,
            },
        );
        assert_eq!(resolved.as_deref(), Some("Legacy architect {worker}"));
    }

    #[test]
    fn stores_and_loads_agent_and_role_overlays() {
        let root = unique_temp_dir("project-settings-overlays");

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
