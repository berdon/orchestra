use crate::{models::ProjectWorkerOverlay, services::project_settings};

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
