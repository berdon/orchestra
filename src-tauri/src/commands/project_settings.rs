use tauri::async_runtime::spawn_blocking;

use crate::{
    models::{
        ProjectSecretUpsertInput, ProjectSecretsState, ProjectSessionPromptSettings,
        ProjectSourceControlSettings, ProjectTaskAutomationSettings, ProjectWorkerOverlay,
    },
    services::{database, project_secrets, project_settings, projects},
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
pub async fn get_session_prompt_settings(
    project_slug: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    spawn_blocking(move || {
        project_settings::get_session_prompt_settings(&resolve_project_slug(project_slug)?)
    })
    .await
    .map_err(|error| format!("Unable to load session prompt settings: {error}"))?
}

#[tauri::command]
pub async fn update_session_prompt_settings(
    project_slug: Option<String>,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    spawn_blocking(move || {
        project_settings::update_session_prompt_settings(&resolve_project_slug(project_slug)?, template)
    })
    .await
    .map_err(|error| format!("Unable to update session prompt settings: {error}"))?
}

#[tauri::command]
pub async fn get_worker_overlay(
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
) -> Result<ProjectWorkerOverlay, String> {
    spawn_blocking(move || {
        project_settings::get_worker_overlay(
            &resolve_project_slug(project_slug)?,
            &worker_type,
            &worker_slug,
        )
    })
    .await
    .map_err(|error| format!("Unable to load worker overlay: {error}"))?
}

#[tauri::command]
pub async fn get_task_automation_settings(
    project_slug: Option<String>,
) -> Result<ProjectTaskAutomationSettings, String> {
    spawn_blocking(move || {
        project_settings::get_task_automation_settings(&resolve_project_slug(project_slug)?)
    })
    .await
    .map_err(|error| format!("Unable to load task automation settings: {error}"))?
}

#[tauri::command]
pub async fn update_task_automation_settings(
    project_slug: Option<String>,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    spawn_blocking(move || {
        project_settings::update_task_automation_settings(
            &resolve_project_slug(project_slug)?,
            auto_dispatch_on_blocker_completion,
        )
    })
    .await
    .map_err(|error| format!("Unable to update task automation settings: {error}"))?
}

#[tauri::command]
pub async fn get_project_source_control_settings(
    project_slug: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    spawn_blocking(move || {
        project_settings::get_project_source_control_settings(&resolve_project_slug(project_slug)?)
    })
    .await
    .map_err(|error| format!("Unable to load project source control settings: {error}"))?
}

#[tauri::command]
pub async fn update_project_source_control_settings(
    project_slug: Option<String>,
    git_user_name_template: Option<String>,
    git_email_template: Option<String>,
) -> Result<ProjectSourceControlSettings, String> {
    spawn_blocking(move || {
        project_settings::update_project_source_control_settings(
            &resolve_project_slug(project_slug)?,
            git_user_name_template,
            git_email_template,
        )
    })
    .await
    .map_err(|error| format!("Unable to update project source control settings: {error}"))?
}

#[tauri::command]
pub async fn update_worker_overlay(
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
    prompt: Option<String>,
) -> Result<ProjectWorkerOverlay, String> {
    spawn_blocking(move || {
        project_settings::update_worker_overlay(
            &resolve_project_slug(project_slug)?,
            &worker_type,
            &worker_slug,
            prompt,
        )
    })
    .await
    .map_err(|error| format!("Unable to update worker overlay: {error}"))?
}

#[tauri::command]
pub async fn get_project_secrets(project_slug: Option<String>) -> Result<ProjectSecretsState, String> {
    spawn_blocking(move || {
        project_secrets::get_project_secrets(&resolve_project_slug(project_slug)?)
    })
    .await
    .map_err(|error| format!("Unable to load project secrets: {error}"))?
}

#[tauri::command]
pub async fn create_project_secret(
    project_slug: Option<String>,
    input: ProjectSecretUpsertInput,
) -> Result<ProjectSecretsState, String> {
    spawn_blocking(move || {
        project_secrets::create_project_secret(&resolve_project_slug(project_slug)?, input)
    })
    .await
    .map_err(|error| format!("Unable to create project secret: {error}"))?
}

#[tauri::command]
pub async fn update_project_secret(
    project_slug: Option<String>,
    input: ProjectSecretUpsertInput,
) -> Result<ProjectSecretsState, String> {
    spawn_blocking(move || {
        project_secrets::update_project_secret(&resolve_project_slug(project_slug)?, input)
    })
    .await
    .map_err(|error| format!("Unable to update project secret: {error}"))?
}

#[tauri::command]
pub async fn delete_project_secret(
    project_slug: Option<String>,
    secret_key: String,
) -> Result<ProjectSecretsState, String> {
    spawn_blocking(move || {
        project_secrets::delete_project_secret(&resolve_project_slug(project_slug)?, &secret_key)
    })
    .await
    .map_err(|error| format!("Unable to delete project secret: {error}"))?
}
