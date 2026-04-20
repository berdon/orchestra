use crate::{
    models::{ProjectSessionPromptSettings, ProjectTaskAutomationSettings, ProjectWorkerOverlay},
    services::project_settings,
};

#[tauri::command]
pub fn get_session_prompt_settings(
    project_slug: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    project_settings::get_session_prompt_settings(project_slug.as_deref().unwrap_or("orchestra"))
}

#[tauri::command]
pub fn update_session_prompt_settings(
    project_slug: Option<String>,
    template: Option<String>,
) -> Result<ProjectSessionPromptSettings, String> {
    project_settings::update_session_prompt_settings(
        project_slug.as_deref().unwrap_or("orchestra"),
        template,
    )
}

#[tauri::command]
pub fn get_worker_overlay(
    project_slug: Option<String>,
    worker_type: String,
    worker_slug: String,
) -> Result<ProjectWorkerOverlay, String> {
    project_settings::get_worker_overlay(
        project_slug.as_deref().unwrap_or("orchestra"),
        &worker_type,
        &worker_slug,
    )
}

#[tauri::command]
pub fn get_task_automation_settings(
    project_slug: Option<String>,
) -> Result<ProjectTaskAutomationSettings, String> {
    project_settings::get_task_automation_settings(project_slug.as_deref().unwrap_or("orchestra"))
}

#[tauri::command]
pub fn update_task_automation_settings(
    project_slug: Option<String>,
    auto_dispatch_on_blocker_completion: bool,
) -> Result<ProjectTaskAutomationSettings, String> {
    project_settings::update_task_automation_settings(
        project_slug.as_deref().unwrap_or("orchestra"),
        auto_dispatch_on_blocker_completion,
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
        project_slug.as_deref().unwrap_or("orchestra"),
        &worker_type,
        &worker_slug,
        prompt,
    )
}
