use tauri::State;

use crate::{
    models::{ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryRecord, RepositoryUpsertInput},
    services::{database, projects},
    state::AppState,
};

#[tauri::command]
pub fn list_projects() -> Result<Vec<ProjectSummary>, String> {
    let connection = database::open_connection()?;
    projects::list_projects(&connection)
}

#[tauri::command]
pub fn get_project(project_id: String) -> Result<ProjectDetail, String> {
    let connection = database::open_connection()?;
    projects::get_project(&connection, &project_id)
}

#[tauri::command]
pub fn create_project(
    state: State<'_, AppState>,
    input: ProjectUpsertInput,
) -> Result<ProjectDetail, String> {
    let mut connection = database::open_connection()?;
    let project = projects::create_project(&mut connection, input)?;
    state.log("info", "project.created", &format!("Created project {}", project.id));
    Ok(project)
}

#[tauri::command]
pub fn update_project(
    state: State<'_, AppState>,
    project_id: String,
    input: ProjectUpsertInput,
) -> Result<ProjectDetail, String> {
    let connection = database::open_connection()?;
    let project = projects::update_project(&connection, &project_id, input)?;
    state.log("info", "project.updated", &format!("Updated project {}", project.id));
    Ok(project)
}

#[tauri::command]
pub fn list_repositories(project_id: Option<String>) -> Result<Vec<RepositoryRecord>, String> {
    let connection = database::open_connection()?;
    projects::list_repositories(&connection, project_id.as_deref())
}

#[tauri::command]
pub fn create_repository(
    state: State<'_, AppState>,
    project_id: String,
    input: RepositoryUpsertInput,
) -> Result<RepositoryRecord, String> {
    let connection = database::open_connection()?;
    let repository = projects::create_repository(&connection, &project_id, input)?;
    state.log("info", "repository.created", &format!("Created repository {}", repository.id));
    Ok(repository)
}

#[tauri::command]
pub fn update_repository(
    state: State<'_, AppState>,
    repository_id: String,
    input: RepositoryUpsertInput,
) -> Result<RepositoryRecord, String> {
    let connection = database::open_connection()?;
    let repository = projects::update_repository(&connection, &repository_id, input)?;
    state.log("info", "repository.updated", &format!("Updated repository {}", repository.id));
    Ok(repository)
}

#[tauri::command]
pub fn set_project_default_repository(
    state: State<'_, AppState>,
    project_id: String,
    repository_id: Option<String>,
) -> Result<ProjectDetail, String> {
    let connection = database::open_connection()?;
    let project = projects::set_project_default_repository(&connection, &project_id, repository_id.as_deref())?;
    state.log("info", "project.updated", &format!("Updated default repository for project {}", project.id));
    Ok(project)
}
