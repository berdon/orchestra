use tauri::State;

use crate::{
    models::{TaskDetail, TaskSummary, TaskUpsertInput},
    services::{database, tasks},
    state::AppState,
};

#[tauri::command]
pub fn list_tasks(include_archived: Option<bool>) -> Result<Vec<TaskSummary>, String> {
    let connection = database::open_connection()?;
    tasks::list_tasks(&connection, include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_task(task_id: String) -> Result<TaskDetail, String> {
    let connection = database::open_connection()?;
    tasks::get_task(&connection, &task_id)
}

#[tauri::command]
pub fn create_task(
    state: State<'_, AppState>,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::create_task(&mut connection, input)?;
    state.log("info", "task.created", &format!("Created task {}", task.id));
    state.log_authorized_action(
        "auth.audit",
        "create_task",
        None,
        None,
        &task.id,
        "success",
    );
    Ok(task)
}

#[tauri::command]
pub fn update_task(
    state: State<'_, AppState>,
    task_id: String,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::update_task(&mut connection, &task_id, input)?;
    state.log("info", "task.updated", &format!("Updated task {}", task.id));
    state.log_authorized_action(
        "auth.audit",
        "update_task",
        None,
        None,
        &task_id,
        "success",
    );
    Ok(task)
}
