use std::{
    collections::HashSet,
    time::{Duration, Instant},
};

use serde_json::json;
use tauri::{AppHandle, Manager, State};

use crate::{
    models::{
        TaskAttachment, TaskAttachmentInput, TaskComment, TaskCommentDeleteImpact,
        TaskCommentFileMentionCandidate, TaskCommentInput, TaskCommentUpdateInput, TaskDependency,
        TaskDetail, TaskFileReference, TaskFileReferenceInput, TaskPullRequestDetail,
        TaskRepository, TaskSummary, TaskTodo, TaskTodoInput, TaskUpsertInput,
    },
    services::{
        app_events, database, dispatcher, domain_events, pi_sessions, pi_setup, task_attachments,
        task_comment_file_mentions, task_file_references, task_pull_requests, task_repositories,
        task_runtime, tasks,
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

fn log_task_command_failure(state: &AppState, target: &str, task_id: &str, error: &str) {
    state.log(
        "error",
        target,
        &format!("Task {} failed: {}", task_id, error),
    );
}

fn record_task_domain_event(
    connection: &rusqlite::Connection,
    topic: &str,
    task: &TaskDetail,
    payload: serde_json::Value,
) {
    let _ = domain_events::record_event(
        connection,
        domain_events::DomainEventInput {
            project_id: Some(task.project_id.clone()),
            topic: topic.to_string(),
            entity_type: "task".to_string(),
            entity_id: Some(task.id.clone()),
            payload,
        },
    );
}

fn request_dispatcher_check_after_task_create(
    app: &AppHandle,
    state: &AppState,
    reason: &str,
    task_id: &str,
) {
    if let Err(error) = dispatcher::request_dispatcher_check(app, reason) {
        state.log(
            "warn",
            "dispatcher.tick.request_failed",
            &format!(
                "Failed to request dispatcher check after creating task {}: {}",
                task_id, error
            ),
        );
    }
}

fn stop_live_session_runtime_for_task_control(
    state: &AppState,
    session_id: &str,
) -> Result<bool, String> {
    let had_runtime = if let Some(runtime) = state.remove_session_runtime(session_id)? {
        runtime.abort_active_run();
        true
    } else {
        false
    };
    state.clear_active_session_run(session_id)?;
    Ok(had_runtime)
}

fn cleanup_blocked_task_runtime_claims(
    app: &AppHandle,
    state: &AppState,
    connection: &mut rusqlite::Connection,
    task_ids: impl IntoIterator<Item = String>,
    reason: &str,
) -> Result<Vec<String>, String> {
    let mut seen = HashSet::new();
    let mut cleaned_task_ids = Vec::new();

    for task_id in task_ids {
        if !seen.insert(task_id.clone()) {
            continue;
        }

        let Ok(task) = tasks::get_task_context(connection, &task_id) else {
            continue;
        };
        if task.status != "blocked" {
            continue;
        }
        let cleanup = task_runtime::clear_task_runtime_claims_preserving_status(
            connection,
            &task_id,
            Some("Task is blocked and no longer holds worker runtime or queue capacity.".into()),
        )?;
        if !cleanup.changed {
            continue;
        }

        let mut emitted_session_ids = HashSet::new();
        for assignment in &cleanup.assignments {
            if let Some(session_id) = assignment.session_id.as_deref() {
                stop_live_session_runtime_for_task_control(state, session_id)?;
                if emitted_session_ids.insert(session_id.to_string()) {
                    emit_session_change(app, reason, [session_id.to_string()]);
                }
                if assignment.worker_type == "role" {
                    crate::services::live_sessions::schedule_session_retirement(
                        app.clone(),
                        session_id.to_string(),
                        Duration::ZERO,
                        reason,
                    );
                }
            }
        }

        state.log(
            "info",
            reason,
            &format!(
                "Cleared blocked-task runtime claims for task {} ({} open assignment(s))",
                task_id,
                cleanup.assignments.len()
            ),
        );
        cleaned_task_ids.push(task_id);
    }

    Ok(cleaned_task_ids)
}

#[tauri::command]
pub fn list_tasks(
    project_id: Option<String>,
    include_archived: Option<bool>,
    tags: Option<Vec<String>>,
    tag_match: Option<String>,
    sort_by: Option<String>,
    sort_direction: Option<String>,
) -> Result<Vec<TaskSummary>, String> {
    let started_at = Instant::now();
    let requested_project_id = project_id.clone();
    let connection = database::open_connection()?;
    let Some(project_id) = crate::services::projects::resolve_requested_or_default_project_id(
        &connection,
        project_id.as_deref(),
    )?
    else {
        return Ok(Vec::new());
    };
    let query = tasks::TaskListQuery::from_raw(
        include_archived,
        tags,
        tag_match.as_deref(),
        sort_by.as_deref(),
        sort_direction.as_deref(),
    )?;
    let tasks = tasks::list_tasks_with_query(&connection, &project_id, query)?;
    tracing::info!(
        target: "startup.timing.rpc",
        "command=list_tasks duration_ms={:.1} requested_project_id={} resolved_project_id={} task_count={}",
        started_at.elapsed().as_secs_f64() * 1000.0,
        requested_project_id.as_deref().unwrap_or("<default>"),
        project_id,
        tasks.len(),
    );
    Ok(tasks)
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
pub fn mark_task_comments_read_for_user(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let connection = database::open_connection()?;
    tasks::mark_task_comments_read_for_user(&connection, &task_id, None)?;
    let task = tasks::get_task_context(&connection, &task_id)?;
    state.log(
        "info",
        "task.comment.user_read",
        &format!(
            "Marked non-user task comments read for user on task {}",
            task_id
        ),
    );
    state.log_authorized_action(
        "auth.audit",
        "mark_task_comments_read_for_user",
        None,
        None,
        &task_id,
        "success",
    );
    emit_task_change(&app, "task.comment.user_read", [task.id.clone()]);
    Ok(task)
}

#[tauri::command]
pub fn list_task_todos(task_id: String) -> Result<Vec<TaskTodo>, String> {
    let connection = database::open_connection()?;
    tasks::list_task_todos(&connection, &task_id)
}

#[tauri::command]
pub fn list_unfinished_task_todos(
    task_id: String,
    lane_id: Option<String>,
) -> Result<Vec<TaskTodo>, String> {
    let connection = database::open_connection()?;
    tasks::list_unfinished_task_todos(&connection, &task_id, lane_id.as_deref())
}

#[tauri::command]
pub fn add_task_todo(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    input: TaskTodoInput,
) -> Result<TaskTodo, String> {
    let connection = database::open_connection()?;
    let todo = tasks::add_task_todo(&connection, &task_id, input)?;
    state.log(
        "info",
        "task.todo.added",
        &format!(
            "Added task todo {} to task {} for lane {}",
            todo.id, task_id, todo.lane_id
        ),
    );
    state.log_authorized_action(
        "auth.audit",
        "add_task_todo",
        None,
        None,
        &todo.id,
        "success",
    );
    emit_task_change(&app, "task.todo.added", [task_id]);
    Ok(todo)
}

#[tauri::command]
pub fn mark_task_todo_finished(
    app: AppHandle,
    state: State<'_, AppState>,
    todo_id: String,
) -> Result<TaskTodo, String> {
    let connection = database::open_connection()?;
    let todo = tasks::mark_task_todo_finished(&connection, &todo_id)?;
    state.log(
        "info",
        "task.todo.finished",
        &format!("Marked task todo {} finished", todo_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "mark_task_todo_finished",
        None,
        None,
        &todo_id,
        "success",
    );
    emit_task_change(&app, "task.todo.finished", [todo.task_id.clone()]);
    Ok(todo)
}

#[tauri::command]
pub fn mark_task_todo_unfinished(
    app: AppHandle,
    state: State<'_, AppState>,
    todo_id: String,
) -> Result<TaskTodo, String> {
    let connection = database::open_connection()?;
    let todo = tasks::mark_task_todo_unfinished(&connection, &todo_id)?;
    state.log(
        "info",
        "task.todo.unfinished",
        &format!("Marked task todo {} unfinished", todo_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "mark_task_todo_unfinished",
        None,
        None,
        &todo_id,
        "success",
    );
    emit_task_change(&app, "task.todo.unfinished", [todo.task_id.clone()]);
    Ok(todo)
}

#[tauri::command]
pub fn delete_task_todo(
    app: AppHandle,
    state: State<'_, AppState>,
    todo_id: String,
) -> Result<TaskTodo, String> {
    let connection = database::open_connection()?;
    let todo = tasks::delete_task_todo(&connection, &todo_id)?;
    state.log(
        "info",
        "task.todo.deleted",
        &format!("Deleted task todo {}", todo_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "delete_task_todo",
        None,
        None,
        &todo_id,
        "success",
    );
    emit_task_change(&app, "task.todo.deleted", [todo.task_id.clone()]);
    Ok(todo)
}

#[tauri::command]
pub fn search_task_comment_file_mentions(
    task_id: String,
    query: String,
    limit: Option<usize>,
) -> Result<Vec<TaskCommentFileMentionCandidate>, String> {
    let connection = database::open_connection()?;
    task_comment_file_mentions::search_task_comment_file_mentions(
        &connection,
        &task_id,
        &query,
        limit,
    )
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
    let task_workspace_cwd = task
        .active_lane_assignment
        .as_ref()
        .map(|assignment| {
            task_runtime::resolve_assignment_workspace_cwd(
                &connection,
                assignment,
                &task_id,
                &task.project_id,
            )
        })
        .transpose()?
        .flatten();
    task_file_references::load_task_file_references(
        &connection,
        &task_id,
        task_workspace_cwd.as_deref(),
    )
}

#[tauri::command]
pub fn set_default_task_file_reference(reference_id: String) -> Result<TaskFileReference, String> {
    let mut connection = database::open_connection()?;
    task_file_references::set_task_file_reference_default(&mut connection, &reference_id)
}

#[tauri::command]
pub fn get_task_file_content(path: String) -> Result<String, String> {
    use std::fs;
    use std::path::Path;

    let file_path = Path::new(&path);
    if !file_path.exists() {
        return Err(format!("File does not exist: {path}"));
    }

    fs::read_to_string(&path).map_err(|error| format!("Unable to read file: {error}"))
}

#[tauri::command]
pub fn get_task_pull_request(task_id: String) -> Result<TaskPullRequestDetail, String> {
    let connection = database::open_connection()?;
    task_pull_requests::get_task_pull_request(&connection, &task_id)
}

#[tauri::command]
pub fn create_task(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: Option<String>,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let mut task = tasks::create_task(&mut connection, project_id.as_deref(), input)?;
    let changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
    let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
        &app,
        &state,
        &mut connection,
        changed_task_ids.clone(),
        "task.blocked.runtime_cleared",
    )?;
    if cleaned_blocked_task_ids.contains(&task.id) {
        task = tasks::get_task_context(&connection, &task.id)?;
    }
    state.log("info", "task.created", &format!("Created task {}", task.id));
    state.log_authorized_action("auth.audit", "create_task", None, None, &task.id, "success");
    record_task_domain_event(
        &connection,
        "task.created",
        &task,
        json!({
            "taskId": task.id.clone(),
            "taskNumber": task.number.clone(),
            "status": task.status.clone(),
            "workflowId": task.workflow_id.clone(),
            "laneId": task.current_lane_id.clone(),
        }),
    );
    emit_task_change(&app, "task.created", changed_task_ids);
    request_dispatcher_check_after_task_create(&app, &state, "task.created", &task.id);
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
    let mut task = tasks::create_subtask(&mut connection, &parent_task_id, input)?;
    let changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
    let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
        &app,
        &state,
        &mut connection,
        changed_task_ids.clone(),
        "task.blocked.runtime_cleared",
    )?;
    if cleaned_blocked_task_ids.contains(&task.id) {
        task = tasks::get_task_context(&connection, &task.id)?;
    }
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
    record_task_domain_event(
        &connection,
        "task.created",
        &task,
        json!({
            "taskId": task.id.clone(),
            "taskNumber": task.number.clone(),
            "status": task.status.clone(),
            "workflowId": task.workflow_id.clone(),
            "laneId": task.current_lane_id.clone(),
            "parentTaskId": task.parent_task_id.clone(),
        }),
    );
    emit_task_change(&app, "task.created", changed_task_ids);
    request_dispatcher_check_after_task_create(&app, &state, "task.created", &task.id);
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
    let existing = tasks::get_task_context(&connection, &task_id)?;
    let mut task = tasks::update_task(&mut connection, &task_id, input)?;
    let mut changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
    changed_task_ids.extend(tasks::collect_parent_chain_task_ids(
        &connection,
        existing.parent_task_id.as_deref(),
    )?);
    let changed_task_ids = {
        let mut seen = HashSet::new();
        changed_task_ids
            .into_iter()
            .filter(|task_id| seen.insert(task_id.clone()))
            .collect::<Vec<_>>()
    };
    let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
        &app,
        &state,
        &mut connection,
        changed_task_ids.clone(),
        "task.blocked.runtime_cleared",
    )?;
    if cleaned_blocked_task_ids.contains(&task.id) {
        task = tasks::get_task_context(&connection, &task.id)?;
    }
    state.log("info", "task.updated", &format!("Updated task {}", task.id));
    state.log_authorized_action("auth.audit", "update_task", None, None, &task_id, "success");
    record_task_domain_event(
        &connection,
        "task.updated",
        &task,
        json!({
            "taskId": task.id.clone(),
            "taskNumber": task.number.clone(),
            "status": task.status.clone(),
            "workflowId": task.workflow_id.clone(),
            "laneId": task.current_lane_id.clone(),
        }),
    );
    emit_task_change(&app, "task.updated", changed_task_ids);
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
    record_task_domain_event(
        &connection,
        "task.deleted",
        &task,
        json!({
            "taskId": task.id.clone(),
            "taskNumber": task.number.clone(),
            "status": task.status.clone(),
            "workflowId": task.workflow_id.clone(),
            "laneId": task.current_lane_id.clone(),
        }),
    );
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
    let mut connection = database::open_connection()?;
    let comment = tasks::add_task_comment(&mut connection, &task_id, input)?;
    let task = tasks::get_task(&connection, &task_id)?;
    if let Some(target) =
        task_runtime::resolve_task_comment_notification_target(&connection, &task, &comment)?
    {
        if let Some(warning) = task_runtime::dispatch_task_comment_notification_target(
            Some(&app),
            Some(&state),
            &connection,
            &task,
            &comment,
            &target,
        ) {
            state.log(
                "warn",
                "task.comment.notification_failed",
                &format!(
                    "Comment {} on task {} was saved, but unread notification delivery degraded: {}",
                    comment.id, task_id, warning
                ),
            );
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
    if let Ok(task) = tasks::get_task_context(&connection, &task_id) {
        record_task_domain_event(
            &connection,
            "task.comment_added",
            &task,
            json!({
                "taskId": task.id.clone(),
                "commentId": comment.id.clone(),
                "interrupt": comment.interrupt_agent,
            }),
        );
    }
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
pub fn update_task_comment(
    app: AppHandle,
    state: State<'_, AppState>,
    comment_id: String,
    input: TaskCommentUpdateInput,
) -> Result<TaskComment, String> {
    let mut connection = database::open_connection()?;
    let comment = tasks::update_task_comment(&mut connection, &comment_id, input)?;
    state.log(
        "info",
        "task.comment.updated",
        &format!("Updated comment {} on task {}", comment.id, comment.task_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "update_task_comment",
        None,
        None,
        &comment.id,
        "success",
    );
    if let Ok(task) = tasks::get_task_context(&connection, &comment.task_id) {
        record_task_domain_event(
            &connection,
            "task.comment_updated",
            &task,
            json!({
                "taskId": task.id.clone(),
                "commentId": comment.id.clone(),
            }),
        );
    }
    emit_task_change(&app, "task.comment.updated", [comment.task_id.clone()]);
    Ok(comment)
}

#[tauri::command]
pub fn delete_task_comment(
    app: AppHandle,
    state: State<'_, AppState>,
    comment_id: String,
) -> Result<TaskComment, String> {
    let mut connection = database::open_connection()?;
    let comment = tasks::delete_task_comment(&mut connection, &comment_id)?;
    state.log(
        "info",
        "task.comment.deleted",
        &format!("Deleted comment {} on task {}", comment.id, comment.task_id),
    );
    state.log_authorized_action(
        "auth.audit",
        "delete_task_comment",
        None,
        None,
        &comment.id,
        "success",
    );
    if let Ok(task) = tasks::get_task_context(&connection, &comment.task_id) {
        record_task_domain_event(
            &connection,
            "task.comment_deleted",
            &task,
            json!({
                "taskId": task.id.clone(),
                "commentId": comment.id.clone(),
            }),
        );
    }
    emit_task_change(&app, "task.comment.deleted", [comment.task_id.clone()]);
    Ok(comment)
}

#[tauri::command]
pub fn get_task_comment_delete_impact(
    state: State<'_, AppState>,
    comment_id: String,
) -> Result<TaskCommentDeleteImpact, String> {
    let connection = database::open_connection()?;
    let impact = tasks::get_task_comment_delete_impact(&connection, &comment_id)?;
    state.log_authorized_action(
        "auth.audit",
        "get_task_comment_delete_impact",
        None,
        None,
        &comment_id,
        "success",
    );
    Ok(impact)
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
    let mut changed_task_ids = tasks::collect_task_refresh_ids(&connection, &blocked_task_id)?;
    changed_task_ids.push(blocker_task_id.clone());
    let changed_task_ids = {
        let mut seen = HashSet::new();
        changed_task_ids
            .into_iter()
            .filter(|task_id| seen.insert(task_id.clone()))
            .collect::<Vec<_>>()
    };
    let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
        &app,
        &state,
        &mut connection,
        changed_task_ids.clone(),
        "task.dependency.blocked",
    )?;
    state.log(
        "info",
        "task.dependency.added",
        &format!(
            "Added dependency {} -> {}",
            blocker_task_id, blocked_task_id
        ),
    );
    let canceled_assignment_present = cleaned_blocked_task_ids.contains(&blocked_task_id);
    state.log_authorized_action(
        "auth.audit",
        "add_task_dependency",
        None,
        None,
        &dependency.id,
        "success",
    );
    emit_task_change(&app, "task.dependency.added", changed_task_ids.clone());
    if canceled_assignment_present {
        emit_task_change(&app, "task.dependency.blocked", changed_task_ids);
    }
    Ok(dependency)
}

#[tauri::command]
pub fn remove_task_dependency(
    app: AppHandle,
    state: State<'_, AppState>,
    dependency_id: String,
) -> Result<TaskDependency, String> {
    let mut connection = database::open_connection()?;
    let dependency = tasks::remove_task_dependency(&connection, &dependency_id)?;
    let mut changed_task_ids =
        tasks::collect_task_refresh_ids(&connection, &dependency.blocked_task_id)?;
    changed_task_ids.push(dependency.blocker_task_id.clone());
    let changed_task_ids = {
        let mut seen = HashSet::new();
        changed_task_ids
            .into_iter()
            .filter(|task_id| seen.insert(task_id.clone()))
            .collect::<Vec<_>>()
    };
    cleanup_blocked_task_runtime_claims(
        &app,
        &state,
        &mut connection,
        changed_task_ids.clone(),
        "task.blocked.runtime_cleared",
    )?;
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
    emit_task_change(&app, "task.dependency.removed", changed_task_ids);
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
    if let Ok(task) = tasks::get_task_context(&connection, &task_id) {
        record_task_domain_event(
            &connection,
            "task.file_reference_added",
            &task,
            json!({
                "taskId": task.id.clone(),
                "referenceId": reference.id.clone(),
                "relativePath": reference.relative_path.clone(),
            }),
        );
    }
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
    if let Ok(task) = tasks::get_task_context(&connection, &reference.task_id) {
        record_task_domain_event(
            &connection,
            "task.file_reference_removed",
            &task,
            json!({
                "taskId": task.id.clone(),
                "referenceId": reference.id.clone(),
                "relativePath": reference.relative_path.clone(),
            }),
        );
    }
    emit_task_change(
        &app,
        "task.file_reference.removed",
        [reference.task_id.clone()],
    );
    Ok(reference)
}

pub fn add_task_attachment_bytes(
    app: AppHandle,
    state: &AppState,
    task_id: String,
    input: task_attachments::TaskAttachmentBytesInput,
) -> Result<TaskAttachment, String> {
    let mut connection = database::open_connection()?;
    let attachment = task_attachments::add_task_attachment_bytes(&mut connection, &task_id, input)?;
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
    if let Ok(task) = tasks::get_task_context(&connection, &task_id) {
        record_task_domain_event(
            &connection,
            "task.attachment_added",
            &task,
            json!({
                "taskId": task.id.clone(),
                "attachmentId": attachment.id.clone(),
                "fileName": attachment.file_name.clone(),
            }),
        );
    }
    emit_task_change(&app, "task.attachment.added", [task_id]);
    Ok(attachment)
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
    if let Ok(task) = tasks::get_task_context(&connection, &task_id) {
        record_task_domain_event(
            &connection,
            "task.attachment_added",
            &task,
            json!({
                "taskId": task.id.clone(),
                "attachmentId": attachment.id.clone(),
                "fileName": attachment.file_name.clone(),
            }),
        );
    }
    emit_task_change(&app, "task.attachment.added", [task_id]);
    Ok(attachment)
}

#[tauri::command]
pub fn download_task_attachment(
    state: State<'_, AppState>,
    attachment_id: String,
    destination_path: Option<String>,
) -> Result<Option<String>, String> {
    let connection = database::open_connection()?;
    let attachment = task_attachments::load_attachment(&connection, &attachment_id)?;
    let destination = if let Some(destination_path) = destination_path {
        Some(std::path::PathBuf::from(destination_path))
    } else {
        rfd::FileDialog::new()
            .set_file_name(&attachment.file_name)
            .save_file()
    };

    let Some(destination_path) = destination else {
        state.log(
            "info",
            "task.attachment.download.cancelled",
            &format!("Download cancelled for attachment {}", attachment_id),
        );
        return Ok(None);
    };

    task_attachments::copy_attachment_to_path(&connection, &attachment_id, &destination_path)?;
    state.log(
        "info",
        "task.attachment.downloaded",
        &format!(
            "Downloaded attachment {} to {}",
            attachment_id,
            destination_path.display()
        ),
    );
    Ok(Some(destination_path.display().to_string()))
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
    if let Ok(task) = tasks::get_task_context(&connection, &attachment.task_id) {
        record_task_domain_event(
            &connection,
            "task.attachment_removed",
            &task,
            json!({
                "taskId": task.id.clone(),
                "attachmentId": attachment.id.clone(),
                "fileName": attachment.file_name.clone(),
            }),
        );
    }
    emit_task_change(
        &app,
        "task.attachment.removed",
        [attachment.task_id.clone()],
    );
    Ok(attachment)
}

pub(crate) async fn dispatch_task_lane_via_app(
    app: AppHandle,
    task_id: String,
) -> Result<TaskDetail, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        session_context_for_task_id(&task_id_for_context)
    })
    .await
    .map_err(|error| format!("Unable to join task dispatch context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let state = app.state::<AppState>();
    let assignment = task_runtime::dispatch_task_lane_for_state(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
        &state,
    )?;
    let requeued_due_to_busy = assignment.worker_type == "agent"
        && assignment.status == "queued";
    if requeued_due_to_busy {
        let _ = dispatcher::request_dispatcher_check(&app, "task.dispatch.agent_busy_queued");
    } else if let Err(error) = task_runtime::start_assignment_run(
        app.clone(),
        &state,
        context.session_dir.clone(),
        &assignment,
    ) {
        if !error.contains("already processing a message") {
            return Err(error);
        }
        state.log(
            "info",
            "task.dispatch.already_running",
            &format!(
                "Task {} worker session {} was already processing a message immediately after dispatch; treating dispatch as successful.",
                task_id,
                assignment.session_id.as_deref().unwrap_or("<none>"),
            ),
        );
    }
    let task = tasks::get_task_context(&connection, &task_id)?;
    if let Some(session_id) = task
        .active_lane_assignment
        .as_ref()
        .and_then(|assignment| assignment.session_id.clone())
    {
        emit_session_change(&app, "task.dispatch", [session_id]);
    }
    state.log(
        "info",
        "task.dispatch",
        &format!(
            "Dispatched task lane for task {}{}",
            task_id,
            if requeued_due_to_busy {
                " (queued until agent session is free)"
            } else {
                ""
            }
        ),
    );
    record_task_domain_event(
        &connection,
        "task.dispatched",
        &task,
        json!({
            "taskId": task.id.clone(),
            "assignmentId": assignment.id.clone(),
            "laneId": assignment.lane_id.clone(),
            "sessionId": task.active_lane_assignment.as_ref().and_then(|entry| entry.session_id.clone()),
            "queuedUntilAgentFree": requeued_due_to_busy,
        }),
    );
    emit_task_change(&app, "task.dispatch", [task.id.clone()]);
    Ok(task)
}

#[tauri::command]
pub async fn dispatch_task_lane(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    state.sync_pi_runtime_health().map_err(|error| {
        format!("Unable to dispatch task lane because PI is unavailable: {error}")
    })?;
    pi_setup::require_pi_setup_ready().map_err(|error| {
        format!("Unable to dispatch task lane because Pi setup is incomplete: {error}")
    })?;
    dispatch_task_lane_via_app(app, task_id).await
}

#[tauri::command]
pub async fn complete_lane_as_success(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    summary: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    complete_lane_command(app, state, task_id, summary, notes, "success").await
}

#[tauri::command]
pub async fn complete_lane_as_failure(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    summary: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    complete_lane_command(app, state, task_id, summary, notes, "failure").await
}

#[tauri::command]
pub async fn request_user_intervention(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    summary: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    complete_lane_command(app, state, task_id, summary, notes, "needs_user").await
}

#[tauri::command]
pub async fn approve_task_review(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let task_id_for_context = task_id.clone();
    let context = tauri::async_runtime::spawn_blocking(move || {
        session_context_for_task_id(&task_id_for_context)
    })
    .await
    .map_err(|error| format!("Unable to join lane approval context task: {error}"))??;
    let mut connection = database::open_connection()?;
    let previous_assignment = task_runtime::get_current_lane_assignment(&connection, &task_id)?;
    let mut task = task_runtime::approve_task_review(
        &mut connection,
        &context.project_root,
        &context.session_dir,
        &task_id,
    )?;
    let mut changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
    let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
        &app,
        &state,
        &mut connection,
        changed_task_ids.clone(),
        "task.blocked.runtime_cleared",
    )?;
    if cleaned_blocked_task_ids.contains(&task.id) {
        task = tasks::get_task_context(&connection, &task_id)?;
    }

    let auto_dispatches = if state.sync_pi_runtime_health().is_ok() {
        task_runtime::collect_post_completion_auto_dispatches(&mut connection, &task_id)?
    } else {
        state.log(
            "warn",
            "task.transition.auto_dispatch.blocked",
            &format!(
                "Skipped auto-dispatch after approving task {} because PI is unavailable",
                task_id
            ),
        );
        Vec::new()
    };
    for outcome in &auto_dispatches {
        task_runtime::start_assignment_run(
            app.clone(),
            &state,
            outcome.session_dir.clone(),
            &outcome.assignment,
        )?;
        if let Some(session_id) = outcome.assignment.session_id.clone() {
            emit_session_change(&app, "task.transition.next_assignment", [session_id]);
        }
    }
    changed_task_ids.extend(
        auto_dispatches
            .iter()
            .map(|outcome| outcome.task_id.clone()),
    );
    let changed_task_ids = {
        let mut seen = HashSet::new();
        changed_task_ids
            .into_iter()
            .filter(|task_id| seen.insert(task_id.clone()))
            .collect::<Vec<_>>()
    };
    if !auto_dispatches.is_empty() {
        task = tasks::get_task_context(&connection, &task_id)?;
        emit_task_change(
            &app,
            "task.transition.auto_dispatch",
            changed_task_ids.clone(),
        );
    }

    let archived_session_id = previous_assignment.as_ref().and_then(|assignment| {
        if matches!(assignment.worker_type.as_str(), "agent" | "role")
            && matches!(task.status.as_str(), "completed" | "canceled")
        {
            assignment.session_id.clone()
        } else {
            None
        }
    });

    record_task_domain_event(
        &connection,
        "task.review_approved",
        &task,
        json!({
            "taskId": task.id.clone(),
            "assignmentId": previous_assignment.as_ref().map(|assignment| assignment.id.clone()),
            "laneId": previous_assignment.as_ref().map(|assignment| assignment.lane_id.clone()),
            "sessionId": previous_assignment.as_ref().and_then(|assignment| assignment.session_id.clone()),
            "onBehalfOfUser": true,
            "action": "approve_task_review",
        }),
    );

    state.log(
        "info",
        "task.review.approved",
        &format!("Approved task review for task {}", task_id),
    );
    emit_task_change(&app, "task.review.approved", changed_task_ids);
    if let Some(session_id) = archived_session_id {
        emit_session_change(&app, "task.review.approved.archive", [session_id]);
    }
    if let Some(session_id) =
        task_runtime::transitioned_assignment_session_to_retire(previous_assignment.as_ref(), &task)
    {
        crate::services::live_sessions::schedule_session_retirement(
            app.clone(),
            session_id,
            Duration::ZERO,
            "task.review.approved",
        );
    }
    Ok(task)
}

#[tauri::command]
pub async fn approve_lane_completion(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    approve_task_review(app, state, task_id).await
}

#[tauri::command]
pub async fn reassign_task_to_lane(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    lane_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let result = async {
        let task_id_for_context = task_id.clone();
        let context = tauri::async_runtime::spawn_blocking(move || {
            session_context_for_task_id(&task_id_for_context)
        })
        .await
        .map_err(|error| format!("Unable to join task re-lane context task: {error}"))??;
        let mut connection = database::open_connection()?;
        let previous_assignment = task_runtime::get_current_lane_assignment(&connection, &task_id)?;
        let mut task = task_runtime::reassign_task_to_lane_with_app(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &task_id,
            &lane_id,
            notes,
            Some(&app),
            None,
        )?;
        let changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
        let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
            &app,
            &state,
            &mut connection,
            changed_task_ids.clone(),
            "task.blocked.runtime_cleared",
        )?;
        if cleaned_blocked_task_ids.contains(&task.id) {
            task = tasks::get_task_context(&connection, &task_id)?;
        }

        let auto_dispatches = if state.sync_pi_runtime_health().is_ok() {
            task_runtime::collect_post_completion_auto_dispatches(&mut connection, &task_id)?
        } else {
            state.log(
                "warn",
                "task.transition.auto_dispatch.blocked",
                &format!(
                    "Skipped auto-dispatch after re-laning task {} because PI is unavailable",
                    task_id
                ),
            );
            Vec::new()
        };
        for outcome in &auto_dispatches {
            task_runtime::start_assignment_run(
                app.clone(),
                &state,
                outcome.session_dir.clone(),
                &outcome.assignment,
            )?;
            if let Some(session_id) = outcome.assignment.session_id.clone() {
                emit_session_change(&app, "task.transition.relane", [session_id]);
            }
        }
        if !auto_dispatches.is_empty() {
            task = tasks::get_task_context(&connection, &task_id)?;
        }

        let retired_session_id = task_runtime::transitioned_assignment_session_to_retire(
            previous_assignment.as_ref(),
            &task,
        );

        record_task_domain_event(
            &connection,
            "task.relaned",
            &task,
            json!({
                "taskId": task.id.clone(),
                "status": task.status.clone(),
                "workflowId": task.workflow_id.clone(),
                "laneId": task.current_lane_id.clone(),
                "targetLaneId": lane_id,
            }),
        );

        Ok::<(TaskDetail, Vec<String>, Option<String>), String>((
            task,
            auto_dispatches
                .iter()
                .map(|outcome| outcome.task_id.clone())
                .collect(),
            retired_session_id,
        ))
    }
    .await;

    match result {
        Ok((task, auto_dispatched_task_ids, retired_session_id)) => {
            state.log(
                "info",
                "task.transition.relane",
                &format!("Re-laned task {} to lane {}", task_id, lane_id),
            );
            let mut changed_task_ids = vec![task.id.clone()];
            changed_task_ids.extend(auto_dispatched_task_ids);
            emit_task_change(&app, "task.transition.relane", changed_task_ids);
            if let Some(session_id) = retired_session_id {
                crate::services::live_sessions::schedule_session_retirement(
                    app.clone(),
                    session_id,
                    Duration::ZERO,
                    "task.transition.relane",
                );
            }
            Ok(task)
        }
        Err(error) => {
            log_task_command_failure(&state, "task.transition.relane.failed", &task_id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn mark_task_needs_work(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let result = async {
        let task_id_for_context = task_id.clone();
        let context = tauri::async_runtime::spawn_blocking(move || {
            session_context_for_task_id(&task_id_for_context)
        })
        .await
        .map_err(|error| format!("Unable to join task review rework context task: {error}"))??;
        let mut connection = database::open_connection()?;
        let previous_assignment =
            task_runtime::get_current_lane_assignment(&connection, &task_id)?;
        let task = match task_runtime::mark_task_needs_work(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &task_id,
            notes.clone(),
        )? {
            task_runtime::ReviewReworkAction::Reactivated(assignment) => {
                if assignment.session_id.is_some() {
                    let follow_up_prompt = task_runtime::lane_rework_follow_up_prompt();
                    task_runtime::start_assignment_follow_up(
                        app.clone(),
                        &state,
                        context.session_dir.clone(),
                        &assignment,
                        &follow_up_prompt,
                    )?;
                }
                if let Some(session_id) = assignment.session_id.clone() {
                    emit_session_change(&app, "task.review.needs_work", [session_id]);
                }
                tasks::get_task_context(&connection, &task_id)?
            }
            task_runtime::ReviewReworkAction::Relaned(updated_task) => {
                let auto_dispatches = if state.sync_pi_runtime_health().is_ok() {
                    task_runtime::collect_post_completion_auto_dispatches(
                        &mut connection,
                        &task_id,
                    )?
                } else {
                    state.log(
                        "warn",
                        "task.transition.auto_dispatch.blocked",
                        &format!(
                            "Skipped auto-dispatch after Needs Work re-lane for task {} because PI is unavailable",
                            task_id
                        ),
                    );
                    Vec::new()
                };
                for outcome in &auto_dispatches {
                    task_runtime::start_assignment_run(
                        app.clone(),
                        &state,
                        outcome.session_dir.clone(),
                        &outcome.assignment,
                    )?;
                    if let Some(session_id) = outcome.assignment.session_id.clone() {
                        emit_session_change(&app, "task.review.needs_work", [session_id]);
                    }
                }
                if auto_dispatches.is_empty() {
                    updated_task
                } else {
                    tasks::get_task_context(&connection, &task_id)?
                }
            }
        };
        let changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
        let retired_session_id = task_runtime::transitioned_assignment_session_to_retire(
            previous_assignment.as_ref(),
            &task,
        );
        record_task_domain_event(
            &connection,
            "task.review_needs_work",
            &task,
            json!({
                "taskId": task.id.clone(),
                "assignmentId": previous_assignment.as_ref().map(|assignment| assignment.id.clone()),
                "laneId": previous_assignment.as_ref().map(|assignment| assignment.lane_id.clone()),
                "sessionId": previous_assignment.as_ref().and_then(|assignment| assignment.session_id.clone()),
                "targetLaneId": task.current_lane_id.clone(),
                "notes": notes,
                "onBehalfOfUser": true,
                "action": "mark_task_needs_work",
            }),
        );
        Ok::<(TaskDetail, Vec<String>, Option<String>), String>((
            task,
            changed_task_ids,
            retired_session_id,
        ))
    }
    .await;

    match result {
        Ok((task, changed_task_ids, retired_session_id)) => {
            state.log(
                "info",
                "task.review.needs_work",
                &format!("Marked task {} as needs work after review", task_id),
            );
            emit_task_change(&app, "task.review.needs_work", changed_task_ids);
            if let Some(session_id) = retired_session_id {
                crate::services::live_sessions::schedule_session_retirement(
                    app.clone(),
                    session_id,
                    Duration::ZERO,
                    "task.review.needs_work",
                );
            }
            Ok(task)
        }
        Err(error) => {
            log_task_command_failure(&state, "task.review.needs_work.failed", &task_id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn resume_task_lane(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let result = async {
        let task_id_for_context = task_id.clone();
        let context = tauri::async_runtime::spawn_blocking(move || {
            session_context_for_task_id(&task_id_for_context)
        })
        .await
        .map_err(|error| format!("Unable to join task resume context task: {error}"))??;
        let connection = database::open_connection()?;
        let assignment = task_runtime::resume_task_lane(&connection, &task_id)?;
        if assignment.session_id.is_some() {
            let follow_up_prompt = task_runtime::lane_rework_follow_up_prompt();
            task_runtime::start_assignment_follow_up(
                app.clone(),
                &state,
                context.session_dir.clone(),
                &assignment,
                &follow_up_prompt,
            )?;
        }
        if let Some(session_id) = assignment.session_id.clone() {
            emit_session_change(&app, "task.control.resumed", [session_id]);
        }
        let task = tasks::get_task_context(&connection, &task_id)?;
        record_task_domain_event(
            &connection,
            "task.control_resumed",
            &task,
            json!({
                "taskId": task.id.clone(),
                "assignmentId": assignment.id.clone(),
                "laneId": assignment.lane_id.clone(),
                "sessionId": assignment.session_id.clone(),
                "notes": notes,
                "onBehalfOfUser": true,
                "action": "resume_task_lane",
            }),
        );
        Ok::<TaskDetail, String>(task)
    }
    .await;

    match result {
        Ok(task) => {
            state.log(
                "info",
                "task.control.resumed",
                &format!("Resumed paused task lane for task {}", task_id),
            );
            emit_task_change(&app, "task.control.resumed", [task.id.clone()]);
            Ok(task)
        }
        Err(error) => {
            log_task_command_failure(&state, "task.control.resume.failed", &task_id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn send_lane_back_for_work(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let connection = database::open_connection()?;
    let assignment = task_runtime::get_current_lane_assignment(&connection, &task_id)?
        .ok_or_else(|| format!("Task {task_id} has no paused lane assignment to resume"))?;
    let task = tasks::get_task_context(&connection, &task_id)?;
    match task_runtime::effective_task_review_assignment_status(&task, &assignment).as_str() {
        "awaiting_user_approval" => mark_task_needs_work(app, state, task_id, None).await,
        "awaiting_user_intervention" => resume_task_lane(app, state, task_id, None).await,
        _ => Err(format!("Task {task_id} is not paused for user review")),
    }
}

#[tauri::command]
pub async fn pause_task_lane(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let result = async {
        let connection = database::open_connection()?;
        let previous_assignment = task_runtime::get_current_lane_assignment(&connection, &task_id)?;
        let task = task_runtime::pause_task_lane(&connection, &task_id, notes.clone())?;
        if let Some(session_id) = previous_assignment
            .as_ref()
            .and_then(|assignment| assignment.session_id.as_deref())
        {
            let _ = stop_live_session_runtime_for_task_control(&state, session_id)?;
            emit_session_change(&app, "task.control.paused", [session_id.to_string()]);
        }
        record_task_domain_event(
            &connection,
            "task.control_paused",
            &task,
            json!({
                "taskId": task.id.clone(),
                "assignmentId": previous_assignment.as_ref().map(|assignment| assignment.id.clone()),
                "laneId": previous_assignment.as_ref().map(|assignment| assignment.lane_id.clone()),
                "sessionId": previous_assignment.as_ref().and_then(|assignment| assignment.session_id.clone()),
                "notes": notes,
                "onBehalfOfUser": true,
                "action": "pause_task_lane",
            }),
        );
        Ok::<TaskDetail, String>(task)
    }
    .await;

    match result {
        Ok(task) => {
            state.log(
                "info",
                "task.control.paused",
                &format!("Paused task lane for task {}", task_id),
            );
            emit_task_change(&app, "task.control.paused", [task.id.clone()]);
            Ok(task)
        }
        Err(error) => {
            log_task_command_failure(&state, "task.control.pause.failed", &task_id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub async fn stop_task_activity(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    notes: Option<String>,
) -> Result<TaskDetail, String> {
    let result = async {
        let mut connection = database::open_connection()?;
        let previous_assignment = task_runtime::get_current_lane_assignment(&connection, &task_id)?;
        if let Some(session_id) = previous_assignment
            .as_ref()
            .and_then(|assignment| assignment.session_id.as_deref())
        {
            let _ = stop_live_session_runtime_for_task_control(&state, session_id)?;
        }
        let task = task_runtime::stop_task_activity(&mut connection, &task_id, notes.clone())?;
        if let Some(session_id) = previous_assignment
            .as_ref()
            .and_then(|assignment| assignment.session_id.clone())
        {
            emit_session_change(&app, "task.control.stopped", [session_id.clone()]);
            crate::services::live_sessions::schedule_session_retirement(
                app.clone(),
                session_id,
                Duration::ZERO,
                "task.control.stopped",
            );
        }
        record_task_domain_event(
            &connection,
            "task.control_stopped",
            &task,
            json!({
                "taskId": task.id.clone(),
                "assignmentId": previous_assignment.as_ref().map(|assignment| assignment.id.clone()),
                "laneId": previous_assignment.as_ref().map(|assignment| assignment.lane_id.clone()),
                "sessionId": previous_assignment.as_ref().and_then(|assignment| assignment.session_id.clone()),
                "notes": notes,
                "onBehalfOfUser": true,
                "action": "stop_task_activity",
            }),
        );
        Ok::<TaskDetail, String>(task)
    }
    .await;

    match result {
        Ok(task) => {
            state.log(
                "info",
                "task.control.stopped",
                &format!("Stopped task activity for task {}", task_id),
            );
            emit_task_change(&app, "task.control.stopped", [task.id.clone()]);
            Ok(task)
        }
        Err(error) => {
            log_task_command_failure(&state, "task.control.stop.failed", &task_id, &error);
            Err(error)
        }
    }
}

#[tauri::command]
pub fn reset_task_runtime(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let mut connection = database::open_connection()?;
    let previous_assignment = tasks::get_task_context(&connection, &task_id)
        .ok()
        .and_then(|task| task.active_lane_assignment);
    let task = task_runtime::reset_task_runtime(&mut connection, &task_id)?;

    state.log(
        "info",
        "task.runtime.reset",
        &format!("Reset task runtime for task {}", task_id),
    );
    let _ = emit_task_change(&app, "task.runtime.reset", [task.id.clone()]);
    if let Some(session_id) = previous_assignment.and_then(|assignment| assignment.session_id) {
        let _ = emit_session_change(&app, "task.runtime.reset", [session_id]);
    }

    Ok(task)
}

#[tauri::command]
pub async fn manual_task_whip(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
) -> Result<TaskDetail, String> {
    let connection = database::open_connection()?;
    let task = tasks::get_task_context(&connection, &task_id)?;
    let assignment = task.active_lane_assignment.clone().ok_or_else(|| {
        format!(
            "Task {} does not have an active lane assignment to whip",
            task_id
        )
    })?;

    if assignment.status != "active" {
        return Err(format!(
            "Task {} is not active and cannot be whipped right now",
            task_id
        ));
    }

    task_runtime::record_task_whip_sent(&connection, &assignment.id, assignment.whip_count)?;

    if let Some(session_id) = assignment.session_id.clone() {
        emit_session_change(&app, "task.whip.sent", [session_id]);
    }
    let updated_task = tasks::get_task_context(&connection, &task_id)?;
    state.log(
        "info",
        "task.whip.sent",
        &format!("Sent manual whip for task {}", task_id),
    );
    emit_task_change(&app, "task.whip.sent", [updated_task.id.clone()]);
    Ok(updated_task)
}

async fn complete_lane_command(
    app: AppHandle,
    state: State<'_, AppState>,
    task_id: String,
    summary: String,
    notes: Option<String>,
    outcome: &str,
) -> Result<TaskDetail, String> {
    let result = async {
        let task_id_for_context = task_id.clone();
        let context = tauri::async_runtime::spawn_blocking(move || {
            session_context_for_task_id(&task_id_for_context)
        })
        .await
        .map_err(|error| format!("Unable to join lane completion context task: {error}"))??;
        let mut connection = database::open_connection()?;
        let previous_assignment = task_runtime::get_current_lane_assignment(&connection, &task_id)?;
        let mut task = match outcome {
            "success" => task_runtime::complete_lane_as_success_with_app(
                &mut connection,
                &context.project_root,
                &context.session_dir,
                &task_id,
                Some(summary.clone()),
                notes.clone(),
                Some(&app),
                None,
            )?,
            "failure" => task_runtime::complete_lane_as_failure_with_app(
                &mut connection,
                &context.project_root,
                &context.session_dir,
                &task_id,
                Some(summary.clone()),
                notes.clone(),
                Some(&app),
                None,
            )?,
            _ => task_runtime::request_user_intervention_with_app(
                &mut connection,
                &context.project_root,
                &context.session_dir,
                &task_id,
                Some(summary.clone()),
                notes.clone(),
                Some(&app),
                None,
            )?,
        };
        let mut changed_task_ids = tasks::collect_task_refresh_ids(&connection, &task.id)?;
        let cleaned_blocked_task_ids = cleanup_blocked_task_runtime_claims(
            &app,
            &state,
            &mut connection,
            changed_task_ids.clone(),
            "task.blocked.runtime_cleared",
        )?;
        if cleaned_blocked_task_ids.contains(&task.id) {
            task = tasks::get_task_context(&connection, &task_id)?;
        }

        let auto_dispatches = if state.sync_pi_runtime_health().is_ok() {
            task_runtime::collect_post_completion_auto_dispatches(&mut connection, &task_id)?
        } else {
            state.log(
                "warn",
                "task.transition.auto_dispatch.blocked",
                &format!(
                    "Skipped auto-dispatch after transitioning task {} because PI is unavailable",
                    task_id
                ),
            );
            Vec::new()
        };
        for outcome in &auto_dispatches {
            task_runtime::start_assignment_run(
                app.clone(),
                &state,
                outcome.session_dir.clone(),
                &outcome.assignment,
            )?;
            if let Some(session_id) = outcome.assignment.session_id.clone() {
                emit_session_change(&app, "task.transition.next_assignment", [session_id]);
            }
        }
        if !auto_dispatches.is_empty() {
            task = tasks::get_task_context(&connection, &task_id)?;
        }

        let retired_session_id = task_runtime::transitioned_assignment_session_to_retire(
            previous_assignment.as_ref(),
            &task,
        );

        let domain_topic = match outcome {
            "success" if task.status == "completed" => "task.completed",
            "success" => "task.transition_success",
            "failure" => "task.failed",
            _ => "task.user_intervention_requested",
        };
        record_task_domain_event(
            &connection,
            domain_topic,
            &task,
            json!({
                "taskId": task.id.clone(),
                "status": task.status.clone(),
                "workflowId": task.workflow_id.clone(),
                "laneId": task.current_lane_id.clone(),
                "outcome": outcome,
                "summary": summary,
                "notes": notes,
            }),
        );

        changed_task_ids.extend(
            auto_dispatches
                .iter()
                .map(|outcome| outcome.task_id.clone()),
        );
        let mut seen = HashSet::new();
        let changed_task_ids = changed_task_ids
            .into_iter()
            .filter(|task_id| seen.insert(task_id.clone()))
            .collect::<Vec<_>>();

        let archived_session_id = previous_assignment.as_ref().and_then(|assignment| {
            if matches!(assignment.worker_type.as_str(), "agent" | "role")
                && matches!(task.status.as_str(), "completed" | "canceled")
            {
                assignment.session_id.clone()
            } else {
                None
            }
        });

        Ok::<(TaskDetail, Vec<String>, Option<String>, Option<String>), String>((
            task,
            changed_task_ids,
            retired_session_id,
            archived_session_id,
        ))
    }
    .await;

    match result {
        Ok((task, changed_task_ids, retired_session_id, archived_session_id)) => {
            state.log(
                "info",
                "task.transition",
                &format!("Completed task lane {} with outcome {}", task_id, outcome),
            );
            emit_task_change(
                &app,
                task_runtime::task_transition_event_reason(outcome, &task),
                changed_task_ids,
            );
            if let Some(session_id) = archived_session_id {
                emit_session_change(
                    &app,
                    &format!("task.transition.{outcome}.archive"),
                    [session_id],
                );
            }
            if let Some(session_id) = retired_session_id {
                crate::services::live_sessions::schedule_session_retirement(
                    app.clone(),
                    session_id,
                    Duration::ZERO,
                    format!("task.transition.{outcome}"),
                );
            }
            Ok(task)
        }
        Err(error) => {
            log_task_command_failure(
                &state,
                &format!("task.transition.{outcome}.failed"),
                &task_id,
                &error,
            );
            Err(error)
        }
    }
}
