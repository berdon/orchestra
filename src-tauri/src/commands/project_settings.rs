use crate::{
    models::{
        ProjectSessionPromptSettings, ProjectSourceControlSettings, ProjectTaskAutomationSettings,
        ProjectWorkerOverlay,
    },
    services::{database, project_settings, projects},
};

fn resolve_project_slug(project_slug: Option<String>) -> Result<String, String> {
    let connection = database::open_connection()?;
    projects::require_requested_or_default_project_slug(
        &connection,
        project_slug.as_deref(),
        "Create a project first before editing project settings.",
    )
}

#[tauri::command]
pub fn get_session_prompt_settings(
    project_slug: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    project_settings::get_session_prompt_settings(&resolve_project_slug(project_slug)?)
}

#[tauri::command]
pub fn update_session_prompt_settings(
    project_slug: Option<String>,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    project_settings::update_session_prompt_settings(&resolve_project_slug(project_slug)?, template)
}

#[tauri::command]
pub fn get_worker_overlay(
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
) -> Result<ProjectWorkerOverlay, String> {
    project_settings::get_worker_overlay(
        &resolve_project_slug(project_slug)?,
        &worker_type,
        &worker_slug,
    )
}

#[tauri::command]
pub fn get_task_automation_settings(
    project_slug: Option<String>,
) -> Result<ProjectTaskAutomationSettings, String> {
    project_settings::get_task_automation_settings(&resolve_project_slug(project_slug)?)
}

#[tauri::command]
pub fn update_task_automation_settings(
    project_slug: Option<String>,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    project_settings::update_task_automation_settings(
        &resolve_project_slug(project_slug)?,
        auto_dispatch_on_blocker_completion,
    )
}

#[tauri::command]
pub fn get_project_source_control_settings(
    project_slug: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    project_settings::get_project_source_control_settings(&resolve_project_slug(project_slug)?)
}

#[tauri::command]
pub fn update_project_source_control_settings(
    project_slug: Option<String>,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    project_settings::update_project_source_control_settings(
        &resolve_project_slug(project_slug)?,
        git_user_name_template,
        git_email_template,
    )
}

#[tauri::command]
pub fn update_worker_overlay(
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
    prompt: Option<String>,
) -> Result<ProjectWorkerOverlay, String> {
    project_settings::update_worker_overlay(
        &resolve_project_slug(project_slug)?,
        &worker_type,
        &worker_slug,
        prompt,
    )
}
