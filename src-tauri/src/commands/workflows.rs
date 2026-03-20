use tauri::State;

use crate::{
    models::{WorkflowDefinition, WorkflowSummary, WorkflowUpsertInput, WorkflowValidationResult},
    services::{database, workflows},
    state::AppState,
};

#[tauri::command]
pub fn list_workflows(include_archived: Option<bool>) -> Result<Vec<WorkflowSummary>, String> {
    let connection = database::open_connection()?;
    workflows::list_workflows(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_workflow(workflow_id: String) -> Result<WorkflowDefinition, String> {
    let connection = database::open_connection()?;
    workflows::get_workflow(&connection, &workflow_id)
}

#[tauri::command]
pub fn validate_workflow(input: WorkflowUpsertInput) -> Result<WorkflowValidationResult, String> {
    let connection = database::open_connection()?;
    workflows::validate_workflow(&connection, &input)
}

#[tauri::command]
pub fn create_workflow(
    state: State<'_, AppState>,
    input: WorkflowUpsertInput,
) -> Result<WorkflowDefinition, String> {
    let mut connection = database::open_connection()?;
    let workflow = workflows::create_workflow(&mut connection, input)?;
    state.log(
        "info",
        "workflow.created",
        &format!("Created workflow {}", workflow.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "create_workflow",
        None,
        None,
        &workflow.id,
        "success",
    );
    Ok(workflow)
}

#[tauri::command]
pub fn update_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
    input: WorkflowUpsertInput,
) -> Result<WorkflowDefinition, String> {
    let mut connection = database::open_connection()?;
    let workflow = workflows::update_workflow(&mut connection, &workflow_id, input)?;
    state.log(
        "info",
        "workflow.updated",
        &format!("Updated workflow {}", workflow.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "update_workflow",
        None,
        None,
        &workflow_id,
        "success",
    );
    Ok(workflow)
}

#[tauri::command]
pub fn duplicate_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
    new_name: Option<String>,
) -> Result<WorkflowDefinition, String> {
    let mut connection = database::open_connection()?;
    let workflow = workflows::duplicate_workflow(&mut connection, &workflow_id, new_name)?;
    state.log(
        "info",
        "workflow.duplicated",
        &format!("Duplicated workflow {} from {}", workflow.id, workflow_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "duplicate_workflow",
        None,
        None,
        &workflow_id,
        "success",
    );
    Ok(workflow)
}

#[tauri::command]
pub fn archive_workflow(
    state: State<'_, AppState>,
    workflow_id: String,
) -> Result<WorkflowDefinition, String> {
    let connection = database::open_connection()?;
    let workflow = workflows::archive_workflow(&connection, &workflow_id)?;
    state.log(
        "info",
        "workflow.archived",
        &format!("Archived workflow {}", workflow.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "archive_workflow",
        None,
        None,
        &workflow_id,
        "success",
    );
    Ok(workflow)
}
