use tauri::{AppHandle, State};

use crate::{
    models::{
        TaskAttachment, TaskAttachmentInput, TaskComment, TaskCommentInput, TaskDependency,
        TaskDetail, TaskFileReference, TaskFileReferenceInput, TaskRepository, TaskSummary,
        TaskUpsertInput,
    },
    services::{
        app_events, database, pi_sessions, task_attachments, task_file_references,
        task_repositories, task_runtime, tasks,
    },
    state::AppState,
};

fn emit_task_change(app: &AppHandle, reason: &str, task_ids: impl IntoIterator<Item = String>) {
    let _ = app_events::emit_task_change(app, reason.to_string(), task_ids);
}

fn emit_session_change(
    app: &AppHandle,
    reason: &str,
    session_ids: impl IntoIterator<Item = String>,
) {
    let _ = app_events::emit_session_change(app, reason.to_string(), session_ids);
}

fn session_context_for_task_id(task_id: &str) -> Result<pi_sessions::SessionContext, String> {
    let connection = database::open_connection()?;
    let task = tasks::get_task_context(&connection, task_id)?;
    pi_sessions::session_context_for_project_id(&task.project_id)
}

#[tauri::command]
pub fn list_tasks(
    project_id: Option<String>,
    include_archived: Option<bool>,
) -> Result<Vec<TaskSummary>, String> {
    let connection = database::open_connection()?;
    tasks::list_tasks(
        &connection,
        project_id.as_deref().unwrap_or("orchestra"),
        include_archived.unwrap_or(false),
    )
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
pub fn list_task_comments(task_id: String) -> Result<Vec<TaskComment>, String> {
    let connection = database::open_connection()?;
    tasks::list_task_comments(&connection, &task_id)
}

#[tauri::command]
pub fn list_task_repositories(task_id: String) -> Result<Vec<TaskRepository>, String> {
    let connection = database::open_connection()?;
    let task = tasks::get_task(&connection, &task_id)?;
    task_repositories::load_task_repositories(
        &connection,
        &task_id,
        task.active_lane_assignment
            .as_ref()
            .and_then(|assignment| assignment.runtime_cwd.as_deref()),
    )
}

#[tauri::command]
pub fn list_task_file_references(task_id: String) -> Result<Vec<TaskFileReference>, String> {
    let connection = database::open_connection()?;
    let task = tasks::get_task(&connection, &task_id)?;
    task_file_references::load_task_file_references(
        &connection,
        &task_id,
        task.active_lane_assignment
            .as_ref()
            .and_then(|assignment| assignment.runtime_cwd.as_deref()),
    )
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: Option<String>,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::create_task(&mut connection, project_id.as_deref(), input)?;
    state.log("info", "task.created", &format!("Created task {}", task.id));
    state.log_authorized_action("auth.audit", "create_task", None, None, &task.id, "success");
    emit_task_change(&app, "task.created", [task.id.clone()]);
    Ok(task)
}

#[tauri::command]
pub fn create_subtask(
    app: AppHandle,
    state: State<'_, AppState>,
    parent_task_id: String,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::create_subtask(&mut connection, &parent_task_id, input)?;
    state.log(
        "info",
        "task.created",
        &format!("Created subtask {}", task.id),
    );
    state.log_authorized_action(
        "auth.audit",
        "create_subtask",
        None,
        None,
        &task.id,
        "success",
    );
    emit_task_change(&app, "task.created", [task.id.clone(), parent_task_id]);
    Ok(task)
}

#[tauri::command]
pub fn update_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::update_task(&mut connection, &task_id, input)?;
    state.log("info", "task.updated", &format!("Updated task {}", task.id));
    state.log_authorized_action("auth.audit", "update_task", None, None, &task_id, "success");
    emit_task_change(&app, "task.updated", [task.id.clone()]);
    Ok(task)
}

#[tauri::command]
pub fn delete_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let task = tasks::delete_task(&mut connection, &task_id)?;
    state.log("info", "task.deleted", &format!("Deleted task {}", task.id));
    state.log_authorized_action("auth.audit", "delete_task", None, None, &task_id, "success");
    emit_task_change(&app, "task.deleted", [task.id.clone()]);
    Ok(task)
}

#[tauri::command]
pub async fn comment_on_task(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: TaskCommentInput,
) -> Result<TaskComment, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        session_context_for_task_id(&task_id_for_context)
    })
    .await
    .map_err(|error| format!("Unable to join task comment context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let comment = tasks::add_task_comment(&mut connection, &task_id, input)?;
    if let Some(active_assignment) =
        task_runtime::get_active_lane_assignment(&connection, &task_id)?
    {
        task_runtime::notify_active_assignment_of_unread_comments(
            app.clone(),
            &state,
            context.session_dir.clone(),
            &active_assignment,
            &comment,
        )?;
        if let Some(session_id) = active_assignment.session_id.clone() {
            emit_session_change(&app, "task.comment.unread", [session_id]);
        }
    }
    state.log(
        "info",
        "task.commented",
        &format!("Added comment {} to task {}", comment.id, task_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "comment_on_task",
        None,
        None,
        &comment.id,
        "success",
    );
    emit_task_change(
        &app,
        if comment.interrupt_agent {
            "task.comment.interrupt_requested"
        } else {
            "task.commented"
        },
        [task_id],
    );
    Ok(comment)
}

#[tauri::command]
pub fn add_task_dependency(
    app: AppHandle,
    state: State<'_, AppState>,
    blocker_task_id: String,
    blocked_task_id: String,
) -> Result<TaskDependency, String> {
    let mut connection = database::open_connection()?;
    let dependency =
        tasks::add_task_dependency(&mut connection, &blocker_task_id, &blocked_task_id)?;
    state.log(
        "info",
        "task.dependency.added",
        &format!(
            "Added dependency {} -> {}",
            blocker_task_id, blocked_task_id
        ),
    );
    state.log_authorized_action(
        "auth.audit",
        "add_task_dependency",
        None,
        None,
        &dependency.id,
        "success",
    );
    emit_task_change(
        &app,
        "task.dependency.added",
        [blocker_task_id, blocked_task_id],
    );
    Ok(dependency)
}

#[tauri::command]
pub fn remove_task_dependency(
    app: AppHandle,
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
    emit_task_change(
        &app,
        "task.dependency.removed",
        [
            dependency.blocker_task_id.clone(),
            dependency.blocked_task_id.clone(),
        ],
    );
    Ok(dependency)
}

#[tauri::command]
pub fn add_task_file_reference(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: TaskFileReferenceInput,
) -> Result<TaskFileReference, String> {
    let mut connection = database::open_connection()?;
    let reference =
        task_file_references::add_task_file_reference(&mut connection, &task_id, input)?;
    state.log(
        "info",
        "task.file_reference.added",
        &format!("Added file reference {} to task {}", reference.id, task_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "add_task_file_reference",
        None,
        None,
        &reference.id,
        "success",
    );
    emit_task_change(&app, "task.file_reference.added", [task_id]);
    Ok(reference)
}

#[tauri::command]
pub fn remove_task_file_reference(
    app: AppHandle,
    state: State<'_, AppState>,
    reference_id: String,
) -> Result<TaskFileReference, String> {
    let connection = database::open_connection()?;
    let reference = task_file_references::remove_task_file_reference(&connection, &reference_id)?;
    state.log(
        "info",
        "task.file_reference.removed",
        &format!("Removed file reference {}", reference_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "remove_task_file_reference",
        None,
        None,
        &reference_id,
        "success",
    );
    emit_task_change(
        &app,
        "task.file_reference.removed",
        [reference.task_id.clone()],
    );
    Ok(reference)
}

#[tauri::command]
pub fn add_task_attachment(
    app: AppHandle,
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
    emit_task_change(&app, "task.attachment.added", [task_id]);
    Ok(attachment)
}

#[tauri::command]
pub fn remove_task_attachment(
    app: AppHandle,
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
    emit_task_change(
        &app,
        "task.attachment.removed",
        [attachment.task_id.clone()],
    );
    Ok(attachment)
}

#[tauri::command]
pub async fn dispatch_task_lane(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        session_context_for_task_id(&task_id_for_context)
    })
    .await
    .map_err(|error| format!("Unable to join task dispatch context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let assignment = task_runtime::dispatch_task_lane(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
    )?;
    task_runtime::start_assignment_run(
        app.clone(),
        &state,
        context.session_dir.clone(),
        &assignment,
    )?;
    if let Some(session_id) = assignment.session_id.clone() {
        emit_session_change(&app, "task.dispatch", [session_id]);
    }
    let task = tasks::get_task_context(&connection, &task_id)?;
    state.log(
        "info",
        "task.dispatch",
        &format!("Dispatched task lane for task {}", task_id),
    );
    emit_task_change(&app, "task.dispatch", [task.id.clone()]);
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

#[tauri::command]
pub async fn approve_lane_completion(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || session_context_for_task_id(&task_id_for_context))
        .await
        .map_err(|error| format!("Unable to join lane approval context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let mut task = task_runtime::approve_pending_lane_completion(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
    )?;

    if let Some(next_assignment) = task_runtime::maybe_auto_dispatch_task(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
    )? {
        task_runtime::start_assignment_run(
            app.clone(),
            &state,
            context.session_dir.clone(),
            &next_assignment,
        )?;
        if let Some(session_id) = next_assignment.session_id.clone() {
            emit_session_change(&app, "task.transition.next_assignment", [session_id]);
        }
        task = tasks::get_task_context(&connection, &task_id)?;
    }

    state.log(
        "info",
        "task.transition",
        &format!("Approved pending lane completion for task {}", task_id),
    );
    emit_task_change(&app, "task.transition.approved_success", [task.id.clone()]);
    Ok(task)
}

#[tauri::command]
pub async fn send_lane_back_for_work(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || session_context_for_task_id(&task_id_for_context))
        .await
        .map_err(|error| format!("Unable to join lane rework context task: {error}"))??;
    let connection = database::open_connection()?;
    let assignment = task_runtime::send_lane_back_for_work(&connection, &task_id)?;
    let follow_up_prompt = task_runtime::lane_rework_follow_up_prompt();
    task_runtime::start_assignment_follow_up(
        app.clone(),
        &state,
        context.session_dir.clone(),
        &assignment,
        &follow_up_prompt,
    )?;
    if let Some(session_id) = assignment.session_id.clone() {
        emit_session_change(&app, "task.transition.rework", [session_id]);
    }
    let task = tasks::get_task_context(&connection, &task_id)?;
    state.log(
        "info",
        "task.transition",
        &format!("Sent task {} back to the current lane session for more work", task_id),
    );
    emit_task_change(&app, "task.transition.needs_work", [task.id.clone()]);
    Ok(task)
}

async fn complete_lane_command(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
    outcome: &str,
) -> Result<TaskDetail, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        session_context_for_task_id(&task_id_for_context)
    })
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
        task_runtime::start_assignment_run(
            app.clone(),
            &state,
            context.session_dir.clone(),
            &next_assignment,
        )?;
        if let Some(session_id) = next_assignment.session_id.clone() {
            emit_session_change(&app, "task.transition.next_assignment", [session_id]);
        }
        task = tasks::get_task_context(&connection, &task_id)?;
    }

    state.log(
        "info",
        "task.transition",
        &format!("Completed task lane {} with outcome {}", task_id, outcome),
    );
    emit_task_change(
        &app,
        &format!("task.transition.{outcome}"),
        [task.id.clone()],
    );
    Ok(task)
}
