use serde_json::json;
use tauri::State;

use crate::{
    models::{
        ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryRecord, RepositoryRemoteInput,
        RepositoryUpsertInput,
    },
    services::{database, domain_events, pi_sessions, projects},
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
    state.log(
        "info",
        "project.created",
        &format!("Created project {}", project.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(project.id.clone()),
            topic: "project.created".into(),
            entity_type: "project".into(),
            entity_id: Some(project.id.clone()),
            payload: json!({ "projectId": project.id.clone(), "slug": project.slug.clone(), "name": project.name.clone() }),
        },
    );
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
    state.log(
        "info",
        "project.updated",
        &format!("Updated project {}", project.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(project.id.clone()),
            topic: "project.updated".into(),
            entity_type: "project".into(),
            entity_id: Some(project.id.clone()),
            payload: json!({ "projectId": project.id.clone(), "slug": project.slug.clone(), "name": project.name.clone() }),
        },
    );
    Ok(project)
}

#[tauri::command]
pub fn delete_project(
    state: State<'_, AppState>,
    project_id: String,
) -> Result<ProjectDetail, String> {
    let connection = database::open_connection()?;
    let project = projects::get_project(&connection, &project_id)?;
    let context = pi_sessions::detect_session_context(Some(&project.slug))?;
    let session_ids =
        pi_sessions::list_sessions(&context.session_dir, &std::collections::HashSet::new())?
            .into_iter()
            .map(|session| session.id)
            .collect::<Vec<_>>();
    for session_id in &session_ids {
        if let Some(runtime) = state.remove_session_runtime(session_id)? {
            runtime.shutdown();
        }
        state.clear_session_tracking(session_id)?;
    }
    let deleted = projects::delete_project(&connection, &project_id)?;
    state.log(
        "info",
        "project.deleted",
        &format!("Deleted project {}", deleted.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(deleted.id.clone()),
            topic: "project.deleted".into(),
            entity_type: "project".into(),
            entity_id: Some(deleted.id.clone()),
            payload: json!({ "projectId": deleted.id.clone(), "slug": deleted.slug.clone(), "name": deleted.name.clone() }),
        },
    );
    Ok(deleted)
}

#[tauri::command]
pub fn list_repositories(project_id: Option<String>) -> Result<Vec<RepositoryRecord>, String> {
    let connection = database::open_connection()?;
    projects::list_repositories(&connection, project_id.as_deref())
}

#[tauri::command]
pub fn get_repository(repository_id: String) -> Result<RepositoryRecord, String> {
    let connection = database::open_connection()?;
    projects::get_repository(&connection, &repository_id)
}

#[tauri::command]
pub fn create_repository(
    state: State<'_, AppState>,
    project_id: String,
    input: RepositoryUpsertInput,
) -> Result<RepositoryRecord, String> {
    let connection = database::open_connection()?;
    let repository = projects::create_repository(&connection, &project_id, input)?;
    state.log(
        "info",
        "repository.created",
        &format!("Created repository {}", repository.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(repository.project_id.clone()),
            topic: "repository.created".into(),
            entity_type: "repository".into(),
            entity_id: Some(repository.id.clone()),
            payload: json!({ "repositoryId": repository.id.clone(), "projectId": repository.project_id.clone(), "name": repository.name.clone() }),
        },
    );
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
    state.log(
        "info",
        "repository.updated",
        &format!("Updated repository {}", repository.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(repository.project_id.clone()),
            topic: "repository.updated".into(),
            entity_type: "repository".into(),
            entity_id: Some(repository.id.clone()),
            payload: json!({ "repositoryId": repository.id.clone(), "projectId": repository.project_id.clone(), "name": repository.name.clone() }),
        },
    );
    Ok(repository)
}

#[tauri::command]
pub fn delete_repository(
    state: State<'_, AppState>,
    repository_id: String,
) -> Result<RepositoryRecord, String> {
    let connection = database::open_connection()?;
    let repository = projects::delete_repository(&connection, &repository_id)?;
    state.log(
        "info",
        "repository.deleted",
        &format!("Deleted repository {}", repository.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(repository.project_id.clone()),
            topic: "repository.deleted".into(),
            entity_type: "repository".into(),
            entity_id: Some(repository.id.clone()),
            payload: json!({ "repositoryId": repository.id.clone(), "projectId": repository.project_id.clone(), "name": repository.name.clone() }),
        },
    );
    Ok(repository)
}

#[tauri::command]
pub fn attach_repository_remote(
    state: State<'_, AppState>,
    repository_id: String,
    input: RepositoryRemoteInput,
) -> Result<RepositoryRecord, String> {
    let connection = database::open_connection()?;
    let repository = projects::attach_repository_remote(&connection, &repository_id, input)?;
    state.log(
        "info",
        "repository.updated",
        &format!("Attached remote for repository {}", repository.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(repository.project_id.clone()),
            topic: "repository.updated".into(),
            entity_type: "repository".into(),
            entity_id: Some(repository.id.clone()),
            payload: json!({ "repositoryId": repository.id.clone(), "projectId": repository.project_id.clone(), "name": repository.name.clone() }),
        },
    );
    Ok(repository)
}

#[tauri::command]
pub fn set_project_default_repository(
    state: State<'_, AppState>,
    project_id: String,
    repository_id: Option<String>,
) -> Result<ProjectDetail, String> {
    let connection = database::open_connection()?;
    let project = projects::set_project_default_repository(
        &connection,
        &project_id,
        repository_id.as_deref(),
    )?;
    state.log(
        "info",
        "project.updated",
        &format!("Updated default repository for project {}", project.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(project.id.clone()),
            topic: "project.updated".into(),
            entity_type: "project".into(),
            entity_id: Some(project.id.clone()),
            payload: json!({ "projectId": project.id.clone(), "slug": project.slug.clone(), "name": project.name.clone() }),
        },
    );
    Ok(project)
}
