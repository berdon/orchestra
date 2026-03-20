use tauri::{AppHandle, State};

use crate::{
    models::{
        TaskAttachment, TaskAttachmentInput, TaskComment, TaskCommentInput, TaskDependency,
        TaskDetail, TaskSummary, TaskUpsertInput,
    },
    services::{database, pi_sessions, task_attachments, task_runtime, tasks},
    state::AppState,
};

#[tauri::command]
pub fn list_tasks(project_id: Option<String>, include_archived: Option<bool>) -> Result<Vec<TaskSummary>, String> {
    let connection = database::open_connection()?;
    tasks::list_tasks(&connection, project_id.as_deref().unwrap_or("orchestra"), include_archived.unwrap_or(false))
}

#[tauri::command]
pub fn get_task(task_id: String) -> Result<TaskDetail, String> {
    let connection = database::open_connection()?;
    tasks::get_task(&connection, &task_id)
}

#[tauri::command]
pub fn get_task_context(task_id: String) -> Result<TaskDetail, String> {
    let connection = database::open_connection()?;
    tasks::get_task_context(&connection, &task_id)
}

#[tauri::command]
pub fn create_task(
    state: State<'_, AppState>,
    project_id: Option<String>,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::create_task(&mut connection, project_id.as_deref(), input)?;
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
pub fn create_subtask(
    state: State<'_, AppState>,
    parent_task_id: String,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::create_subtask(&mut connection, &parent_task_id, input)?;
    state.log("info", "task.created", &format!("Created subtask {}", task.id));
    state.log_authorized_action(
        "auth.audit",
        "create_subtask",
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

#[tauri::command]
pub async fn comment_on_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: TaskCommentInput,
) -> Result<TaskComment, String> {
    let context = tauri::async_runtime::spawn_blocking(move || pi_sessions::detect_session_context(None))
        .await
        .map_err(|error| format!("Unable to join task comment context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let comment = tasks::add_task_comment(&mut connection, &task_id, input)?;
    if let Some(active_assignment) = task_runtime::get_active_lane_assignment(&connection, &task_id)? {
        task_runtime::queue_comment_delivery(&connection, &active_assignment, &comment)?;
        if active_assignment.worker_type == "agent" {
            if let Some(agent_id) = active_assignment.worker_id.as_deref() {
                let _ = crate::services::agent_dispatch::dispatch_agent_queue(
                    app.clone(),
                    &state,
                    &context.project_root,
                    &context.session_dir,
                    agent_id,
                )?;
            }
        } else {
            task_runtime::maybe_interrupt_with_comment(
                app,
                &state,
                context.session_dir.clone(),
                &active_assignment,
                &comment,
            )?;
        }
    }
    state.log("info", "task.commented", &format!("Added comment {} to task {}", comment.id, task_id));
    state.log_authorized_action(
        "auth.audit",
        "comment_on_task",
        None,
        None,
        &comment.id,
        "success",
    );
    Ok(comment)
}

#[tauri::command]
pub fn add_task_dependency(
    state: State<'_, AppState>,
    blocker_task_id: String,
    blocked_task_id: String,
) -> Result<TaskDependency, String> {
    let mut connection = database::open_connection()?;
    let dependency = tasks::add_task_dependency(&mut connection, &blocker_task_id, &blocked_task_id)?;
    state.log(
        "info",
        "task.dependency.added",
        &format!("Added dependency {} -> {}", blocker_task_id, blocked_task_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "add_task_dependency",
        None,
        None,
        &dependency.id,
        "success",
    );
    Ok(dependency)
}

#[tauri::command]
pub fn remove_task_dependency(
    state: State<'_, AppState>,
    dependency_id: String,
) -> Result<TaskDependency, String> {
    let connection = database::open_connection()?;
    let dependency = tasks::remove_task_dependency(&connection, &dependency_id)?;
    state.log(
        "info",
        "task.dependency.removed",
        &format!("Removed dependency {}", dependency_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "remove_task_dependency",
        None,
        None,
        &dependency_id,
        "success",
    );
    Ok(dependency)
}

#[tauri::command]
pub fn add_task_attachment(
    state: State<'_, AppState>,
    task_id: String,
    input: TaskAttachmentInput,
) -> Result<TaskAttachment, String> {
    let mut connection = database::open_connection()?;
    let attachment = task_attachments::add_task_attachment(&mut connection, &task_id, input)?;
    state.log(
        "info",
        "task.attachment.added",
        &format!("Added attachment {} to task {}", attachment.id, task_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "add_task_attachment",
        None,
        None,
        &attachment.id,
        "success",
    );
    Ok(attachment)
}

#[tauri::command]
pub fn remove_task_attachment(
    state: State<'_, AppState>,
    attachment_id: String,
) -> Result<TaskAttachment, String> {
    let connection = database::open_connection()?;
    let attachment = task_attachments::remove_task_attachment(&connection, &attachment_id)?;
    state.log(
        "info",
        "task.attachment.removed",
        &format!("Removed attachment {}", attachment_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "remove_task_attachment",
        None,
        None,
        &attachment_id,
        "success",
    );
    Ok(attachment)
}

#[tauri::command]
pub async fn dispatch_task_lane(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let context = tauri::async_runtime::spawn_blocking(move || pi_sessions::detect_session_context(None))
        .await
        .map_err(|error| format!("Unable to join task dispatch context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let assignment = task_runtime::dispatch_task_lane(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
    )?;
    task_runtime::start_assignment_run(app, &state, context.session_dir.clone(), &assignment)?;
    let task = tasks::get_task_context(&connection, &task_id)?;
    state.log("info", "task.dispatch", &format!("Dispatched task lane for task {}", task_id));
    Ok(task)
}

#[tauri::command]
pub async fn complete_lane_as_success(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    complete_lane_command(app, state, task_id, notes, "success").await
}

#[tauri::command]
pub async fn complete_lane_as_failure(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    complete_lane_command(app, state, task_id, notes, "failure").await
}

#[tauri::command]
pub async fn request_user_intervention(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    complete_lane_command(app, state, task_id, notes, "needs_user").await
}

async fn complete_lane_command(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
    outcome: &str,
) -> Result<TaskDetail, String> {
    let context = tauri::async_runtime::spawn_blocking(move || pi_sessions::detect_session_context(None))
        .await
        .map_err(|error| format!("Unable to join lane completion context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let mut task = match outcome {
        "success" => task_runtime::complete_lane_as_success(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &task_id,
            notes,
            None,
        )?,
        "failure" => task_runtime::complete_lane_as_failure(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &task_id,
            notes,
            None,
        )?,
        _ => task_runtime::request_user_intervention(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &task_id,
            notes,
            None,
        )?,
    };

    if let Some(next_assignment) = task_runtime::maybe_auto_dispatch_task(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
    )? {
        task_runtime::start_assignment_run(app, &state, context.session_dir.clone(), &next_assignment)?;
        task = tasks::get_task_context(&connection, &task_id)?;
    }

    state.log("info", "task.transition", &format!("Completed task lane {} with outcome {}", task_id, outcome));
    Ok(task)
}
