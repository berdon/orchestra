use std::collections::HashMap;

use clap::{Args, Subcommand};
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use serde_json::json;
use tauri::Manager;

use crate::{
    commands::tasks as task_commands,
    models::{
        TaskComment, TaskCommentDeleteImpact, TaskCommentInput, TaskDetail, TaskSummary,
        TaskUpsertInput,
    },
    services::{backend_bootstrap::CliBackend, database, domain_events, task_runtime, tasks},
};

#[derive(Debug, Clone, Args)]
pub struct TaskArgs {
    #[command(subcommand)]
    pub command: TaskCommand,
}

#[derive(Debug, Clone, Subcommand)]
pub enum TaskCommand {
    /// List tasks in the selected or default project.
    List(TaskListArgs),
    /// Show full task context.
    Show(TaskShowArgs),
    /// Create a task.
    Create(TaskCreateArgs),
    /// Patch core task fields.
    Update(TaskUpdateArgs),
    /// Add a task comment.
    Comment(TaskCommentArgs),
    /// List task comments.
    Comments(TaskCommentsArgs),
    /// Delete a task comment (and all its descendant replies) with cascade impact reporting.
    CommentDelete(TaskCommentDeleteArgs),
    /// Approve a review-paused task.
    Approve(TaskTargetArgs),
    /// Send a review-paused task back for more work.
    NeedsWork(TaskNotesArgs),
    /// Pause active or queued task activity.
    Pause(TaskNotesArgs),
    /// Resume paused task activity.
    Resume(TaskNotesArgs),
    /// Stop task activity and return it to ready state where supported.
    Stop(TaskNotesArgs),
    /// Dispatch the current task lane.
    Dispatch(TaskTargetArgs),
    /// Move a task to a specific workflow lane.
    Move(TaskMoveArgs),
}

#[derive(Debug, Clone, Args)]
pub struct TaskTargetArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskNotesArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Optional operator notes recorded with the action when supported.
    #[arg(long = "notes")]
    pub notes: Option<String>,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskMoveArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Workflow lane id to move the task into.
    #[arg(long = "lane")]
    pub lane_id: String,

    /// Optional operator notes describing why the task was moved.
    #[arg(long = "notes")]
    pub notes: Option<String>,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskListArgs {
    /// Include archived tasks.
    #[arg(long = "all")]
    pub include_archived: bool,

    /// Filter by exact task tag. Repeat to filter by multiple tags.
    #[arg(long = "tag")]
    pub tags: Vec<String>,

    /// Control how multiple tags match: all or any.
    #[arg(long = "tag-match")]
    pub tag_match: Option<String>,

    /// Sort field: updatedAt, createdAt, priority, number, title, or tags.
    #[arg(long = "sort-by")]
    pub sort_by: Option<String>,

    /// Sort direction: asc or desc.
    #[arg(long = "sort-direction")]
    pub sort_direction: Option<String>,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskShowArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskCreateArgs {
    /// Task title.
    #[arg(long = "title")]
    pub title: String,

    /// Task description.
    #[arg(long = "description")]
    pub description: Option<String>,

    /// Task type.
    #[arg(long = "type", default_value = "task")]
    pub task_type: String,

    /// Task status.
    #[arg(long = "status", default_value = "ready")]
    pub status: String,

    /// Task priority.
    #[arg(long = "priority", default_value = "P2")]
    pub priority: String,

    /// Workflow id.
    #[arg(long = "workflow")]
    pub workflow_id: Option<String>,

    /// Current workflow lane id.
    #[arg(long = "lane")]
    pub lane_id: Option<String>,

    /// Assignee type.
    #[arg(long = "assignee-type", default_value = "unassigned")]
    pub assignee_type: String,

    /// Assignee id.
    #[arg(long = "assignee-id")]
    pub assignee_id: Option<String>,

    /// Repository id.
    #[arg(long = "repository")]
    pub repository_id: Option<String>,

    /// Parent task selector.
    #[arg(long = "parent")]
    pub parent_task: Option<String>,

    /// Task tag. Repeat for multiple tags.
    #[arg(long = "tag")]
    pub tags: Vec<String>,

    /// Maximum whip attempts.
    #[arg(long = "whip-max-attempts")]
    pub whip_max_attempts: Option<i64>,

    /// Create the task archived.
    #[arg(long = "archived")]
    pub archived: bool,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskUpdateArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Replace the task title.
    #[arg(long = "title")]
    pub title: Option<String>,

    /// Replace the description.
    #[arg(long = "description")]
    pub description: Option<String>,

    /// Clear the description.
    #[arg(long = "clear-description")]
    pub clear_description: bool,

    /// Replace the task type.
    #[arg(long = "type")]
    pub task_type: Option<String>,

    /// Replace the task status.
    #[arg(long = "status")]
    pub status: Option<String>,

    /// Replace the task priority.
    #[arg(long = "priority")]
    pub priority: Option<String>,

    /// Replace the workflow id.
    #[arg(long = "workflow")]
    pub workflow_id: Option<String>,

    /// Clear the workflow id.
    #[arg(long = "clear-workflow")]
    pub clear_workflow: bool,

    /// Replace the current lane id.
    #[arg(long = "lane")]
    pub lane_id: Option<String>,

    /// Clear the current lane id.
    #[arg(long = "clear-lane")]
    pub clear_lane: bool,

    /// Replace the assignee type.
    #[arg(long = "assignee-type")]
    pub assignee_type: Option<String>,

    /// Replace the assignee id.
    #[arg(long = "assignee-id")]
    pub assignee_id: Option<String>,

    /// Clear the assignee.
    #[arg(long = "clear-assignee")]
    pub clear_assignee: bool,

    /// Replace the repository id.
    #[arg(long = "repository")]
    pub repository_id: Option<String>,

    /// Clear repository links.
    #[arg(long = "clear-repository")]
    pub clear_repository: bool,

    /// Replace the parent task.
    #[arg(long = "parent")]
    pub parent_task: Option<String>,

    /// Clear the parent task.
    #[arg(long = "clear-parent")]
    pub clear_parent: bool,

    /// Replace all tags with the provided set.
    #[arg(long = "tag")]
    pub tags: Vec<String>,

    /// Clear all tags.
    #[arg(long = "clear-tags")]
    pub clear_tags: bool,

    /// Replace maximum whip attempts.
    #[arg(long = "whip-max-attempts")]
    pub whip_max_attempts: Option<i64>,

    /// Archive the task.
    #[arg(long = "archived")]
    pub archived: bool,

    /// Unarchive the task.
    #[arg(long = "unarchived")]
    pub unarchived: bool,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskCommentArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Comment message text.
    #[arg(required = true, num_args = 1..)]
    pub message: Vec<String>,

    /// Existing top-level comment id to reply to.
    #[arg(long = "reply-to")]
    pub reply_to: Option<String>,

    /// Mark the comment as interrupting the active worker.
    #[arg(long = "interrupt")]
    pub interrupt: bool,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskCommentsArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,
}

#[derive(Debug, Clone, Args)]
pub struct TaskCommentDeleteArgs {
    /// Task id, task number (e.g. ORC-67), or numeric shorthand in the selected/default project.
    pub task: String,

    /// The comment id to delete. The comment and all its descendant replies will be cascade-deleted.
    pub comment_id: String,

    /// Emit structured JSON instead of human-readable terminal output.
    #[arg(long = "json")]
    pub json: bool,

    /// Skip the confirmation prompt. Use with caution — this will delete the comment and all descendant replies.
    #[arg(long = "force")]
    pub force: bool,
}

#[derive(Debug, Clone)]
struct ResolvedTaskTarget {
    task_id: String,
    number: String,
}

pub fn run(
    args: TaskArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    match args.command {
        TaskCommand::List(args) => run_list(args, requested_project),
        TaskCommand::Show(args) => run_show(args, requested_project),
        TaskCommand::Create(args) => run_create(args, backend, requested_project),
        TaskCommand::Update(args) => run_update(args, backend, requested_project),
        TaskCommand::Comment(args) => run_comment(args, backend, requested_project),
        TaskCommand::Comments(args) => run_comments(args, requested_project),
        TaskCommand::CommentDelete(args) => run_comment_delete(args, backend, requested_project),
        TaskCommand::Approve(args) => run_approve(args, backend, requested_project),
        TaskCommand::NeedsWork(args) => run_needs_work(args, backend, requested_project),
        TaskCommand::Pause(args) => run_pause(args, backend, requested_project),
        TaskCommand::Resume(args) => run_resume(args, backend, requested_project),
        TaskCommand::Stop(args) => run_stop(args, backend, requested_project),
        TaskCommand::Dispatch(args) => run_dispatch(args, backend, requested_project),
        TaskCommand::Move(args) => run_move(args, backend, requested_project),
    }
}

fn run_list(args: TaskListArgs, requested_project: Option<&str>) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let Some(project_id) = super::resolve_optional_project_id(&connection, requested_project)?
    else {
        if args.json {
            print_json(&Vec::<TaskSummary>::new())?;
        } else {
            println!("No tasks found.");
        }
        return Ok(0);
    };

    let query = tasks::TaskListQuery::from_raw(
        Some(args.include_archived),
        Some(args.tags),
        args.tag_match.as_deref(),
        args.sort_by.as_deref(),
        args.sort_direction.as_deref(),
    )?;
    let tasks = tasks::list_tasks_with_query(&connection, &project_id, query)?;

    if args.json {
        print_json(&tasks)?;
    } else {
        print_task_list(&tasks);
    }

    Ok(0)
}

fn run_show(args: TaskShowArgs, requested_project: Option<&str>) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    let task = tasks::get_task_context(&connection, &target.task_id)?;

    if args.json {
        print_json(&task)?;
    } else {
        print_task_detail(&task);
    }

    Ok(0)
}

fn run_create(
    args: TaskCreateArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let mut connection = database::open_connection()?;
    let project_id = super::require_project_id(
        &connection,
        requested_project,
        "Create a project first before using orc task create.",
    )?;
    let parent_task_id = match args.parent_task.as_deref() {
        Some(selector) => {
            Some(resolve_task_target(&connection, Some(&project_id), selector)?.task_id)
        }
        None => None,
    };
    let input = TaskUpsertInput {
        title: args.title,
        description: args.description,
        task_type: args.task_type,
        tags: args.tags,
        status: args.status,
        priority: args.priority,
        workflow_id: args.workflow_id,
        current_lane_id: args.lane_id,
        assignee_type: args.assignee_type,
        assignee_id: args.assignee_id,
        repository_id: args.repository_id.clone(),
        repository_ids: args.repository_id.into_iter().collect(),
        parent_task_id,
        whip_max_attempts: args.whip_max_attempts,
        archived: Some(args.archived),
    };

    let task = tasks::create_task(&mut connection, Some(&project_id), input)?;
    backend.state().log(
        "info",
        "orc.task.create",
        &format!("Created task {}", task.id),
    );
    record_task_event(
        &connection,
        "task.created",
        &task,
        json!({
            "taskId": task.id,
            "taskNumber": task.number,
            "status": task.status,
            "workflowId": task.workflow_id,
            "laneId": task.current_lane_id,
            "source": "orc"
        }),
    );

    if args.json {
        print_json(&task)?;
    } else {
        println!("Created {}.", task.number);
    }
    Ok(0)
}

fn run_update(
    args: TaskUpdateArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    validate_update_args(&args)?;

    let mut connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    let existing = tasks::get_task_context(&connection, &target.task_id)?;
    let input = apply_update_args(&connection, requested_project, &existing, &args)?;
    let task = tasks::update_task(&mut connection, &target.task_id, input)?;
    backend.state().log(
        "info",
        "orc.task.update",
        &format!("Updated task {}", task.id),
    );
    record_task_event(
        &connection,
        "task.updated",
        &task,
        json!({
            "taskId": task.id,
            "taskNumber": task.number,
            "status": task.status,
            "workflowId": task.workflow_id,
            "laneId": task.current_lane_id,
            "source": "orc"
        }),
    );

    if args.json {
        print_json(&task)?;
    } else {
        println!("Updated {}.", task.number);
    }
    Ok(0)
}

fn run_comment(
    args: TaskCommentArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let mut connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    let comment = tasks::add_task_comment(
        &mut connection,
        &target.task_id,
        TaskCommentInput {
            author: cli_comment_author(),
            origin_type: Some("user".into()),
            origin_id: None,
            message: args.message.join(" "),
            interrupt_agent: args.interrupt,
            parent_comment_id: args.reply_to,
            repository_id: None,
            relative_path: None,
            absolute_path: None,
            line_start: None,
            line_end: None,
            column_start: None,
            column_end: None,
            selected_text: None,
        },
    )?;

    if let Some(active_assignment) =
        task_runtime::get_active_lane_assignment(&connection, &target.task_id)?
    {
        if let Some(warning) = task_runtime::notify_or_queue_unread_comment_delivery(
            &connection,
            &active_assignment,
            &comment,
            || Err("orc CLI does not host a live assignment runtime".into()),
        ) {
            backend.state().log(
                "warn",
                "orc.task.comment.delivery",
                &format!(
                    "Comment {} on task {} required degraded unread delivery handling: {}",
                    comment.id, target.task_id, warning
                ),
            );
        }
    }

    if let Ok(task) = tasks::get_task_context(&connection, &target.task_id) {
        record_task_event(
            &connection,
            "task.comment_added",
            &task,
            json!({
                "taskId": task.id,
                "commentId": comment.id,
                "interrupt": comment.interrupt_agent,
                "source": "orc"
            }),
        );
    }
    backend.state().log(
        "info",
        "orc.task.comment",
        &format!("Added comment {} to task {}", comment.id, target.task_id),
    );

    if args.json {
        print_json(&comment)?;
    } else {
        println!("Commented on {}.", target.number);
    }
    Ok(0)
}

fn run_comments(args: TaskCommentsArgs, requested_project: Option<&str>) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    let comments = tasks::list_task_comments(&connection, &target.task_id)?;

    if args.json {
        print_json(&comments)?;
    } else {
        print_task_comments(&target.number, &comments);
    }

    Ok(0)
}

fn run_comment_delete(
    args: TaskCommentDeleteArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    let comment_id = args.comment_id.clone();

    // Fetch delete impact to show the user what will be destroyed
    let impact = match tasks::get_task_comment_delete_impact(&connection, &comment_id) {
        Ok(impact) => impact,
        Err(error) => {
            return Err(format!(
                "Unable to inspect delete impact for comment {}: {}",
                comment_id, error
            ));
        }
    };

    // Display impact summary before deletion (human-readable mode)
    if !args.json {
        println!("Delete comment {} on task {}:", comment_id, target.number);
        println!("  Reply count: {}", impact.reply_count);
        println!("  Attachment count: {}", impact.attachment_count);
        println!("  File reference count: {}", impact.file_reference_count);
        println!("  Total cascade-deleted: {}", impact.cascade_deleted_count);
        if impact.reply_count > 0 {
            println!(
                "  ⚠ This will also delete {} descendant reply/replies.",
                impact.reply_count
            );
        }
        if !args.force {
            std::io::Write::write_all(&mut std::io::stdout(), b"Continue? [y/N]: ")
                .map_err(|e| format!("Unable to flush prompt: {e}"))?;
            let mut input = String::new();
            std::io::stdin()
                .read_line(&mut input)
                .map_err(|e| format!("Unable to read input: {e}"))?;
            if !input.trim().eq_ignore_ascii_case("y") {
                println!("Deletion cancelled.");
                return Ok(0);
            }
        }
    }

    // Perform cascade deletion through Tauri command
    // We need the app handle and state for the Tauri command
    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();

    // Drop the DB connection before calling the Tauri command (it opens its own)
    drop(connection);

    // Clone for display after deletion (comment_id is moved into delete_task_comment)
    let display_comment_id = comment_id.clone();

    let result = task_commands::delete_task_comment(app, state, comment_id);

    match result {
        Ok(comment) => {
            if args.json {
                print_json(&impact)?;
            } else {
                println!(
                    "Deleted comment {} from task {}. {} total entities cascade-deleted.",
                    display_comment_id, comment.task_id, impact.cascade_deleted_count
                );
            }
            Ok(0)
        }
        Err(error) => Err(format!(
            "Failed to delete comment {}: {}",
            display_comment_id, error
        )),
    }
}

fn run_approve(
    args: TaskTargetArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();
    let task = tauri::async_runtime::block_on(task_commands::approve_task_review(
        app,
        state,
        target.task_id,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!("Approved {}.", task.number);
    }
    Ok(0)
}

fn run_needs_work(
    args: TaskNotesArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();
    let task = tauri::async_runtime::block_on(task_commands::mark_task_needs_work(
        app,
        state,
        target.task_id,
        args.notes,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!("Marked {} as needs work.", task.number);
    }
    Ok(0)
}

fn run_pause(
    args: TaskNotesArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();
    let task = tauri::async_runtime::block_on(task_commands::pause_task_lane(
        app,
        state,
        target.task_id,
        args.notes,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!("Paused {}.", task.number);
    }
    Ok(0)
}

fn run_resume(
    args: TaskNotesArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();
    let task = tauri::async_runtime::block_on(task_commands::resume_task_lane(
        app,
        state,
        target.task_id,
        args.notes,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!("Resumed {}.", task.number);
    }
    Ok(0)
}

fn run_stop(
    args: TaskNotesArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();
    let task = tauri::async_runtime::block_on(task_commands::stop_task_activity(
        app,
        state,
        target.task_id,
        args.notes,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!("Stopped {}.", task.number);
    }
    Ok(0)
}

fn run_dispatch(
    args: TaskTargetArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let task = tauri::async_runtime::block_on(task_commands::dispatch_task_lane_via_app(
        backend.app_handle(),
        target.task_id,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!("Dispatched {}.", task.number);
    }
    Ok(0)
}

fn run_move(
    args: TaskMoveArgs,
    backend: &CliBackend,
    requested_project: Option<&str>,
) -> Result<i32, String> {
    let connection = database::open_connection()?;
    let target = resolve_task_target(&connection, requested_project, &args.task)?;
    drop(connection);

    let app = backend.app_handle();
    let app_for_state = app.clone();
    let state = app_for_state.state::<crate::state::AppState>();
    let task = tauri::async_runtime::block_on(task_commands::reassign_task_to_lane(
        app,
        state,
        target.task_id,
        args.lane_id,
        args.notes,
    ))?;

    if args.json {
        print_json(&task)?;
    } else {
        println!(
            "Moved {} to {}.",
            task.number,
            task.current_lane_id.as_deref().unwrap_or("-")
        );
    }
    Ok(0)
}

fn resolve_task_target(
    connection: &Connection,
    requested_project: Option<&str>,
    selector: &str,
) -> Result<ResolvedTaskTarget, String> {
    let selector = selector.trim();
    if selector.is_empty() {
        return Err("Task selector cannot be empty".into());
    }

    let requested_project_id = super::resolve_optional_project_id(connection, requested_project)?;

    if selector.starts_with("task-") {
        let task = tasks::get_task_context(connection, selector)?;
        if let Some(project_id) = requested_project_id.as_deref() {
            if task.project_id != project_id {
                return Err(format!(
                    "Task {} was found, but it does not belong to the selected project {}",
                    selector, project_id
                ));
            }
        }
        return Ok(ResolvedTaskTarget {
            task_id: task.id,
            number: task.number,
        });
    }

    if selector.chars().all(|ch| ch.is_ascii_digit()) {
        let project_id = requested_project_id.ok_or_else(|| {
            "Numeric task selectors require --project or a default project.".to_string()
        })?;
        let sequence_number = selector
            .parse::<i64>()
            .map_err(|error| format!("Invalid numeric task selector {selector}: {error}"))?;
        let row = connection
            .query_row(
                "SELECT id, project_id, number FROM tasks WHERE project_id = ?1 AND sequence_number = ?2 LIMIT 1",
                params![project_id, sequence_number],
                |row| {
                    Ok(ResolvedTaskTarget {
                        task_id: row.get(0)?,
                        number: row.get(2)?,
                    })
                },
            )
            .optional()
            .map_err(|error| format!("Unable to resolve task selector {selector}: {error}"))?;
        return row.ok_or_else(|| format!("Task {selector} was not found"));
    }

    let (matches, scoped_project_id) =
        query_task_number_matches(connection, requested_project_id, selector)?;
    match matches.as_slice() {
        [] => Err(format!("Task {selector} was not found")),
        [target] => Ok(target.clone()),
        many => Err(match scoped_project_id {
            Some(project_id) => format!(
                "Task {selector} matched multiple records in project {project_id}. Use a canonical task id instead."
            ),
            None => format!(
                "Task {selector} is ambiguous across projects ({} matches). Re-run with --project or use a canonical task id.",
                many.len()
            ),
        }),
    }
}

fn query_task_number_matches(
    connection: &Connection,
    project_id: Option<String>,
    selector: &str,
) -> Result<(Vec<ResolvedTaskTarget>, Option<String>), String> {
    let sql = if project_id.is_some() {
        "SELECT id, project_id, number FROM tasks WHERE project_id = ?1 AND UPPER(number) = UPPER(?2) ORDER BY created_at ASC, id ASC"
    } else {
        "SELECT id, project_id, number FROM tasks WHERE UPPER(number) = UPPER(?1) ORDER BY created_at ASC, id ASC"
    };

    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Unable to prepare task lookup query: {error}"))?;
    let rows = if let Some(project_id) = project_id.clone() {
        statement
            .query_map(params![project_id, selector], |row| {
                Ok(ResolvedTaskTarget {
                    task_id: row.get(0)?,
                    number: row.get(2)?,
                })
            })
            .map_err(|error| format!("Unable to query task selector {selector}: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Unable to read task selector {selector}: {error}"))?
    } else {
        statement
            .query_map(params![selector], |row| {
                Ok(ResolvedTaskTarget {
                    task_id: row.get(0)?,
                    number: row.get(2)?,
                })
            })
            .map_err(|error| format!("Unable to query task selector {selector}: {error}"))?
            .collect::<Result<Vec<_>, _>>()
            .map_err(|error| format!("Unable to read task selector {selector}: {error}"))?
    };

    Ok((rows, project_id))
}

fn validate_update_args(args: &TaskUpdateArgs) -> Result<(), String> {
    if args.description.is_some() && args.clear_description {
        return Err("Use either --description or --clear-description, not both.".into());
    }
    if args.workflow_id.is_some() && args.clear_workflow {
        return Err("Use either --workflow or --clear-workflow, not both.".into());
    }
    if args.lane_id.is_some() && args.clear_lane {
        return Err("Use either --lane or --clear-lane, not both.".into());
    }
    if (args.assignee_type.is_some() || args.assignee_id.is_some()) && args.clear_assignee {
        return Err("Use either assignee flags or --clear-assignee, not both.".into());
    }
    if args.parent_task.is_some() && args.clear_parent {
        return Err("Use either --parent or --clear-parent, not both.".into());
    }
    if args.repository_id.is_some() && args.clear_repository {
        return Err("Use either --repository or --clear-repository, not both.".into());
    }
    if !args.tags.is_empty() && args.clear_tags {
        return Err("Use either one or more --tag values or --clear-tags, not both.".into());
    }
    if args.archived && args.unarchived {
        return Err("Use either --archived or --unarchived, not both.".into());
    }
    if !update_args_change_anything(args) {
        return Err("No task field changes were provided.".into());
    }
    Ok(())
}

fn update_args_change_anything(args: &TaskUpdateArgs) -> bool {
    args.title.is_some()
        || args.description.is_some()
        || args.clear_description
        || args.task_type.is_some()
        || args.status.is_some()
        || args.priority.is_some()
        || args.workflow_id.is_some()
        || args.clear_workflow
        || args.lane_id.is_some()
        || args.clear_lane
        || args.assignee_type.is_some()
        || args.assignee_id.is_some()
        || args.clear_assignee
        || args.repository_id.is_some()
        || args.clear_repository
        || args.parent_task.is_some()
        || args.clear_parent
        || !args.tags.is_empty()
        || args.clear_tags
        || args.whip_max_attempts.is_some()
        || args.archived
        || args.unarchived
}

fn apply_update_args(
    connection: &Connection,
    requested_project: Option<&str>,
    existing: &TaskDetail,
    args: &TaskUpdateArgs,
) -> Result<TaskUpsertInput, String> {
    let description = if args.clear_description {
        None
    } else {
        args.description
            .clone()
            .or_else(|| existing.description.clone())
    };

    let workflow_id = if args.clear_workflow {
        None
    } else {
        args.workflow_id
            .clone()
            .or_else(|| existing.workflow_id.clone())
    };

    let current_lane_id = if args.clear_lane {
        None
    } else {
        args.lane_id
            .clone()
            .or_else(|| existing.current_lane_id.clone())
    };

    let (assignee_type, assignee_id) = if args.clear_assignee {
        ("unassigned".to_string(), None)
    } else {
        let assignee_type = args
            .assignee_type
            .clone()
            .unwrap_or_else(|| existing.assignee_type.clone());
        let assignee_id = match args.assignee_id.clone() {
            Some(value) => Some(value),
            None if args.assignee_type.as_deref() == Some("unassigned") => None,
            None => existing.assignee_id.clone(),
        };
        (assignee_type, assignee_id)
    };

    let parent_task_id = if args.clear_parent {
        None
    } else if let Some(parent_selector) = args.parent_task.as_deref() {
        Some(resolve_task_target(connection, requested_project, parent_selector)?.task_id)
    } else {
        existing.parent_task_id.clone()
    };

    let repository_ids = if args.clear_repository {
        Vec::new()
    } else if let Some(repository_id) = args.repository_id.clone() {
        vec![repository_id]
    } else {
        existing.repository_ids.clone()
    };

    let tags = if args.clear_tags {
        Vec::new()
    } else if !args.tags.is_empty() {
        args.tags.clone()
    } else {
        existing.tags.clone()
    };

    let archived = if args.archived {
        Some(true)
    } else if args.unarchived {
        Some(false)
    } else {
        Some(existing.archived)
    };

    Ok(TaskUpsertInput {
        title: args.title.clone().unwrap_or_else(|| existing.title.clone()),
        description,
        task_type: args
            .task_type
            .clone()
            .unwrap_or_else(|| existing.task_type.clone()),
        tags,
        status: args
            .status
            .clone()
            .unwrap_or_else(|| existing.status.clone()),
        priority: args
            .priority
            .clone()
            .unwrap_or_else(|| existing.priority.clone()),
        workflow_id,
        current_lane_id,
        assignee_type,
        assignee_id,
        repository_id: repository_ids.first().cloned(),
        repository_ids,
        parent_task_id,
        whip_max_attempts: args.whip_max_attempts.or(Some(existing.whip_max_attempts)),
        archived,
    })
}

fn cli_comment_author() -> String {
    std::env::var("ORCHESTRA_CLI_AUTHOR")
        .ok()
        .filter(|value| !value.trim().is_empty())
        .or_else(|| std::env::var("GIT_AUTHOR_NAME").ok())
        .or_else(|| std::env::var("USER").ok())
        .or_else(|| std::env::var("LOGNAME").ok())
        .unwrap_or_else(|| "Orchestra CLI".into())
}

fn print_task_list(tasks: &[TaskSummary]) {
    if tasks.is_empty() {
        println!("No tasks found.");
        return;
    }

    for task in tasks {
        let lane = task.current_lane_id.as_deref().unwrap_or("-");
        let assignee = task.assignee_id.as_deref().unwrap_or("-");
        let tags = if task.tags.is_empty() {
            String::new()
        } else {
            format!("  [{}]", task.tags.join(","))
        };
        println!(
            "{:<10} {:<12} {:<4} {:<18} {:<16} {}{}",
            task.number, task.status, task.priority, lane, assignee, task.title, tags
        );
    }
}

fn print_task_detail(task: &TaskDetail) {
    println!("{} · {}", task.number, task.title);
    println!(
        "type={}  status={}  priority={}  assignee={}  lane={}  workflow={}",
        task.task_type,
        task.status,
        task.priority,
        task.assignee_id
            .as_deref()
            .unwrap_or(task.assignee_type.as_str()),
        task.current_lane_id.as_deref().unwrap_or("-"),
        task.workflow_id.as_deref().unwrap_or("-")
    );
    if !task.tags.is_empty() {
        println!("tags={}", task.tags.join(", "));
    }
    if let Some(description) = task.description.as_deref() {
        println!("\n{}", description);
    }
    println!();
    println!(
        "comments={}  todos={}  files={}  attachments={}  children={}  blocked_by={}  blocking={}",
        task.comment_count,
        task.todos.len(),
        task.file_references.len(),
        task.attachment_count,
        task.child_count,
        task.blocked_by_count,
        task.blocking_count
    );
    println!(
        "assignmentStatus={}  readyForDispatch={}  archived={}",
        task.active_lane_assignment_status.as_deref().unwrap_or("-"),
        task.ready_for_dispatch,
        task.archived
    );
}

fn print_task_comments(task_number: &str, comments: &[TaskComment]) {
    println!("Comments for {}", task_number);
    if comments.is_empty() {
        println!("No comments found.");
        return;
    }

    let mut top_level = Vec::new();
    let mut replies: HashMap<&str, Vec<&TaskComment>> = HashMap::new();
    for comment in comments {
        if let Some(parent_id) = comment.parent_comment_id.as_deref() {
            replies.entry(parent_id).or_default().push(comment);
        } else {
            top_level.push(comment);
        }
    }

    for comment in top_level {
        print_comment_line(comment, 0);
        if let Some(children) = replies.get(comment.id.as_str()) {
            for reply in children {
                print_comment_line(reply, 2);
            }
        }
    }
}

fn print_comment_line(comment: &TaskComment, indent: usize) {
    let padding = " ".repeat(indent);
    println!(
        "{}- {} [{}] {}",
        padding, comment.author, comment.created_at, comment.id
    );
    for line in comment.message.lines() {
        println!("{}  {}", padding, line);
    }
}

fn print_json<T: Serialize>(value: &T) -> Result<(), String> {
    let json = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to serialize JSON output: {error}"))?;
    println!("{json}");
    Ok(())
}

fn record_task_event(
    connection: &Connection,
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

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{ProjectUpsertInput, RoleUpsertInput, WorkflowLaneInput, WorkflowUpsertInput},
        services::{
            agent_runtime, database, pi_sessions, projects, roles, task_runtime, tool_bridge,
            workflows,
        },
        state::AppState,
    };
    use std::{
        fs,
        path::{Path, PathBuf},
        sync::{Arc, OnceLock},
        time::{SystemTime, UNIX_EPOCH},
    };
    use tokio::sync::broadcast::error::TryRecvError;

    fn temp_db_path(name: &str) -> PathBuf {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        std::env::temp_dir().join(format!("orchestra-{name}-{unique}.sqlite3"))
    }

    fn setup_connection(name: &str) -> Connection {
        let path = temp_db_path(name);
        database::initialize_database_at(&path).expect("database should initialize");
        database::open_connection_at(&path).expect("connection should open")
    }

    fn create_project(
        connection: &Connection,
        slug: &str,
        prefix: &str,
    ) -> crate::models::ProjectDetail {
        let id = format!("project-{slug}");
        let now = "2026-01-01T00:00:00Z";
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?5)",
                rusqlite::params![id, slug, slug, prefix, now],
            )
            .expect("project should insert");
        projects::get_project(connection, &format!("project-{slug}")).expect("project should load")
    }

    fn session_context_for_project_slug(slug: &str) -> pi_sessions::SessionContext {
        pi_sessions::detect_session_context(Some(slug)).expect("context should resolve")
    }

    fn insert_assignment(
        connection: &Connection,
        task_id: &str,
        workflow_id: &str,
        lane_id: &str,
        worker_type: &str,
        worker_id: Option<&str>,
        status: &str,
    ) {
        let now = "2026-01-01T00:00:00Z";
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, NULL, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?8, NULL, ?8, ?8)",
                rusqlite::params![
                    format!("assignment-{task_id}"),
                    task_id,
                    workflow_id,
                    lane_id,
                    worker_type,
                    worker_id,
                    status,
                    now,
                ],
            )
            .expect("assignment should insert");
    }

    fn create_role_workflow(
        connection: &mut Connection,
        _project_id: &str,
        role_id: &str,
        role_slug: &str,
    ) -> crate::models::WorkflowDefinition {
        workflows::seed_worker(connection, "roles", role_id, "Reviewer").expect("role should seed");
        workflows::create_workflow(
            connection,
            WorkflowUpsertInput {
                name: "Role Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-work".into()),
                    key: "work".into(),
                    name: "Work".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role_slug.into()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "complete_task".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "stay_in_lane".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create")
    }

    fn create_agent_review_workflow(
        connection: &mut Connection,
        _project_id: &str,
        agent_id: &str,
        agent_slug: &str,
    ) -> crate::models::WorkflowDefinition {
        workflows::seed_worker(connection, "agents", agent_id, "Data Agent")
            .expect("agent should seed");
        workflows::create_workflow(
            connection,
            WorkflowUpsertInput {
                name: "Agent Review Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent".into()),
                    key: "agent".into(),
                    name: "Agent".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent_slug.into()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: true,
                    success_transition_type: "complete_task".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "stay_in_lane".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create")
    }

    static CLI_HOME_ROOT: OnceLock<PathBuf> = OnceLock::new();
    static CLI_TEST_APP_HANDLE: OnceLock<tauri::AppHandle> = OnceLock::new();
    static CLI_TEST_TOOL_BRIDGE: OnceLock<Arc<tool_bridge::ToolBridgeConfig>> = OnceLock::new();

    #[ctor::ctor]
    fn initialize_cli_test_app_handle() {
        let tool_bridge = tool_bridge::dummy_tool_bridge_config("cli-tests-main-thread");
        let app = tauri::Builder::default()
            .manage(AppState::new(tool_bridge.clone()))
            .build(crate::tauri_context())
            .expect("main-thread test app should build");
        let leaked_app = Box::leak(Box::new(app));
        let app_handle = leaked_app.handle().clone();
        tool_bridge.attach_app_handle(app_handle.clone());
        let _ = CLI_TEST_TOOL_BRIDGE.set(tool_bridge);
        let _ = CLI_TEST_APP_HANDLE.set(app_handle);
    }

    fn with_cli_home<T>(label: &str, action: impl FnOnce() -> T) -> T {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_home = std::env::var_os("HOME");
        let previous_project_root = std::env::var_os("ORCHESTRA_PROJECT_ROOT");
        let root = CLI_HOME_ROOT
            .get_or_init(|| {
                let unique = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .expect("time should move forward")
                    .as_nanos();
                let root =
                    std::env::temp_dir().join(format!("orchestra-cli-home-{label}-{unique}"));
                fs::create_dir_all(&root).expect("temp cli home should create");
                if let Some(source_home) = previous_home.as_deref() {
                    copy_pi_setup(Path::new(source_home), &root);
                }
                ensure_pi_theme_assets();
                root
            })
            .clone();
        let project_root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .expect("src-tauri manifest should have repository parent")
            .to_path_buf();
        unsafe {
            std::env::set_var("HOME", &root);
            std::env::set_var("ORCHESTRA_PROJECT_ROOT", &project_root);
        }
        let result = action();
        match previous_home {
            Some(value) => unsafe {
                std::env::set_var("HOME", value);
            },
            None => unsafe {
                std::env::remove_var("HOME");
            },
        }
        match previous_project_root {
            Some(value) => unsafe {
                std::env::set_var("ORCHESTRA_PROJECT_ROOT", value);
            },
            None => unsafe {
                std::env::remove_var("ORCHESTRA_PROJECT_ROOT");
            },
        }
        result
    }

    fn copy_pi_setup(source_home: &Path, target_home: &Path) {
        let source_agent_dir = source_home.join(".orchestra/runtime/pi/agent");
        let target_agent_dir = target_home.join(".orchestra/runtime/pi/agent");
        fs::create_dir_all(&target_agent_dir).expect("target pi agent dir should create");
        for file_name in ["auth.json", "models.json"] {
            let source = source_agent_dir.join(file_name);
            if source.exists() {
                let destination = target_agent_dir.join(file_name);
                let _ = fs::copy(&source, &destination);
            }
        }
    }

    fn ensure_pi_theme_assets() {
        let source_dir = Path::new(
            "/opt/homebrew/lib/node_modules/@mariozechner/pi-coding-agent/dist/modes/interactive/theme",
        );
        let target_dir = Path::new(
            "/Applications/Orchestra.app/Contents/Resources/pi-runtime/runtime/dist/modes/interactive/theme",
        );
        if !source_dir.exists() {
            return;
        }
        fs::create_dir_all(target_dir).expect("target theme dir should create");
        for entry in fs::read_dir(source_dir).expect("theme dir should read") {
            let entry = entry.expect("theme entry should load");
            let destination = target_dir.join(entry.file_name());
            if entry
                .file_type()
                .expect("theme entry type should load")
                .is_file()
            {
                let _ = fs::copy(entry.path(), destination);
            }
        }
    }

    fn build_test_cli_backend(_label: &str) -> CliBackend {
        let database_path = database::initialize_database().expect("database should initialize");
        let tool_bridge = CLI_TEST_TOOL_BRIDGE
            .get()
            .expect("main-thread tool bridge should exist")
            .clone();
        let app_handle = CLI_TEST_APP_HANDLE
            .get()
            .expect("main-thread app handle should exist")
            .clone();
        CliBackend::from_test_handle(database_path, tool_bridge, app_handle)
    }

    fn create_service_project(
        connection: &Connection,
        label: &str,
    ) -> crate::models::ProjectDetail {
        let unique = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("time should move forward")
            .as_nanos();
        projects::create_project(
            connection,
            ProjectUpsertInput {
                name: format!("CLI {label} {unique}"),
                description: None,
                task_prefix: format!("C{:07X}", (unique & 0x0FFF_FFFF) as u64),
            },
        )
        .expect("project should create")
    }

    fn create_service_role(
        connection: &mut Connection,
        name: &str,
    ) -> crate::models::RoleDefinition {
        roles::create_role(
            connection,
            RoleUpsertInput {
                name: name.into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("medium".into()),
                capacity: 1,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create")
    }

    fn create_runtime_workflow(
        connection: &mut Connection,
        name: &str,
        primary_role_slug: &str,
        secondary_role_slug: Option<&str>,
        require_user_approval_on_success: bool,
        with_prompt: bool,
    ) -> crate::models::WorkflowDefinition {
        let mut lanes = vec![WorkflowLaneInput {
            id: Some("lane-work".into()),
            key: "work".into(),
            name: "Work".into(),
            description: None,
            order: Some(0),
            assigned_entity_type: "role".into(),
            assigned_entity_id: Some(primary_role_slug.into()),
            entry_prompt_template: with_prompt.then(|| format!("{name}: implement the task.")),
            use_separate_worktree: false,
            require_user_approval_on_success,
            success_transition_type: "complete_task".into(),
            success_target_lane_id: None,
            failure_transition_type: "stay_in_lane".into(),
            failure_target_lane_id: None,
        }];
        if let Some(secondary_role_slug) = secondary_role_slug {
            lanes.push(WorkflowLaneInput {
                id: Some("lane-review".into()),
                key: "review".into(),
                name: "Review".into(),
                description: None,
                order: Some(1),
                assigned_entity_type: "role".into(),
                assigned_entity_id: Some(secondary_role_slug.into()),
                entry_prompt_template: with_prompt.then(|| format!("{name}: review the task.")),
                use_separate_worktree: false,
                require_user_approval_on_success: false,
                success_transition_type: "complete_task".into(),
                success_target_lane_id: None,
                failure_transition_type: "stay_in_lane".into(),
                failure_target_lane_id: None,
            });
        }
        workflows::create_workflow(
            connection,
            WorkflowUpsertInput {
                name: name.into(),
                description: None,
                lanes,
            },
        )
        .expect("workflow should create")
    }

    fn create_runtime_task(
        connection: &mut Connection,
        project_id: &str,
        workflow_id: &str,
        lane_id: &str,
        title: &str,
    ) -> TaskDetail {
        tasks::create_task(
            connection,
            Some(project_id),
            TaskUpsertInput {
                title: title.into(),
                description: Some("CLI runtime task".into()),
                task_type: "task".into(),
                tags: vec!["cli".into()],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow_id.into()),
                current_lane_id: Some(lane_id.into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should create")
    }

    fn collect_remote_events(
        receiver: &mut tokio::sync::broadcast::Receiver<crate::models::RemoteEventEnvelope>,
    ) -> Vec<crate::models::RemoteEventEnvelope> {
        let mut events = Vec::new();
        loop {
            match receiver.try_recv() {
                Ok(event) => events.push(event),
                Err(TryRecvError::Empty) | Err(TryRecvError::Closed) => break,
                Err(TryRecvError::Lagged(_)) => continue,
            }
        }
        events
    }

    fn collect_remote_event_topics(
        receiver: &mut tokio::sync::broadcast::Receiver<crate::models::RemoteEventEnvelope>,
    ) -> Vec<String> {
        collect_remote_events(receiver)
            .into_iter()
            .map(|event| event.topic)
            .collect()
    }

    #[test]
    fn basic_task_commands_round_trip_through_cli_handlers() {
        with_cli_home("cli-task-basic", || {
            let backend = build_test_cli_backend("cli-task-basic");
            let connection = database::open_connection().expect("connection should open");
            let project = create_service_project(&connection, "basic");
            drop(connection);

            run_create(
                TaskCreateArgs {
                    title: "Created from CLI".into(),
                    description: Some("initial".into()),
                    task_type: "feature".into(),
                    status: "ready".into(),
                    priority: "P2".into(),
                    workflow_id: None,
                    lane_id: None,
                    assignee_type: "unassigned".into(),
                    assignee_id: None,
                    repository_id: None,
                    parent_task: None,
                    tags: vec!["cli".into(), "ops".into()],
                    whip_max_attempts: Some(3),
                    archived: false,
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task create should succeed");

            let connection = database::open_connection().expect("connection should reopen");
            let task = tasks::list_tasks_with_query(
                &connection,
                &project.id,
                tasks::TaskListQuery::from_raw(None, None, None, None, None)
                    .expect("query should build"),
            )
            .expect("tasks should list")
            .into_iter()
            .next()
            .expect("created task should exist");
            drop(connection);

            run_list(
                TaskListArgs {
                    include_archived: false,
                    tags: Vec::new(),
                    tag_match: None,
                    sort_by: None,
                    sort_direction: None,
                    json: false,
                },
                Some(project.slug.as_str()),
            )
            .expect("task list should succeed");
            run_show(
                TaskShowArgs {
                    task: task.number.clone(),
                    json: false,
                },
                Some(project.slug.as_str()),
            )
            .expect("task show should succeed");
            run_update(
                TaskUpdateArgs {
                    task: task.number.clone(),
                    title: Some("Updated from CLI".into()),
                    description: Some("updated".into()),
                    clear_description: false,
                    task_type: Some("bug".into()),
                    status: Some("in_progress".into()),
                    priority: Some("P1".into()),
                    workflow_id: None,
                    clear_workflow: false,
                    lane_id: None,
                    clear_lane: false,
                    assignee_type: None,
                    assignee_id: None,
                    clear_assignee: false,
                    repository_id: None,
                    clear_repository: false,
                    parent_task: None,
                    clear_parent: false,
                    tags: vec!["updated".into()],
                    clear_tags: false,
                    whip_max_attempts: Some(5),
                    archived: false,
                    unarchived: false,
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task update should succeed");
            run_comment(
                TaskCommentArgs {
                    task: task.number.clone(),
                    message: vec!["hello".into(), "cli".into()],
                    reply_to: None,
                    interrupt: false,
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task comment should succeed");
            run_comments(
                TaskCommentsArgs {
                    task: task.number.clone(),
                    json: false,
                },
                Some(project.slug.as_str()),
            )
            .expect("task comments should succeed");

            let connection = database::open_connection().expect("connection should reopen");
            let updated =
                tasks::get_task_context(&connection, &task.id).expect("task should reload");
            let comments =
                tasks::list_task_comments(&connection, &task.id).expect("comments should load");
            assert_eq!(updated.title, "Updated from CLI");
            assert_eq!(updated.task_type, "bug");
            assert_eq!(updated.status, "in_progress");
            assert_eq!(updated.priority, "P1");
            assert_eq!(updated.tags, vec!["updated".to_string()]);
            assert_eq!(updated.whip_max_attempts, 5);
            assert_eq!(comments.len(), 1);
            assert_eq!(comments[0].message, "hello cli");
        });
    }

    #[test]
    fn dispatch_pause_resume_and_stop_commands_update_task_state_and_emit_changes() {
        with_cli_home("cli-task-controls", || {
            let backend = build_test_cli_backend("cli-task-controls");
            let mut connection = database::open_connection().expect("connection should open");
            let project = create_service_project(&connection, "controls");
            let role = create_service_role(&mut connection, "CLI Control Role");
            let workflow = create_runtime_workflow(
                &mut connection,
                "CLI Control Flow",
                &role.slug,
                None,
                false,
                false,
            );
            let dispatch_task = create_runtime_task(
                &mut connection,
                &project.id,
                &workflow.id,
                "lane-work",
                "Dispatchable task",
            );
            let control_task = tasks::create_task(
                &mut connection,
                Some(&project.id),
                TaskUpsertInput {
                    title: "Control target".into(),
                    description: None,
                    task_type: "task".into(),
                    tags: Vec::new(),
                    status: "in_progress".into(),
                    priority: "P2".into(),
                    workflow_id: Some(workflow.id.clone()),
                    current_lane_id: Some("lane-work".into()),
                    assignee_type: "role".into(),
                    assignee_id: Some(role.slug.clone()),
                    repository_id: None,
                    repository_ids: Vec::new(),
                    parent_task_id: None,
                    whip_max_attempts: None,
                    archived: Some(false),
                },
            )
            .expect("control task should create");
            insert_assignment(
                &connection,
                &control_task.id,
                &workflow.id,
                "lane-work",
                "role",
                Some(role.slug.as_str()),
                "queued",
            );
            drop(connection);

            let mut receiver = backend.state().subscribe_remote_events();
            run_dispatch(
                TaskTargetArgs {
                    task: dispatch_task.number.clone(),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task dispatch should succeed through cli handler");
            let dispatch_events = collect_remote_events(&mut receiver);
            let connection = database::open_connection().expect("connection should reopen");
            let dispatched_task = tasks::get_task_context(&connection, &dispatch_task.id)
                .expect("dispatch task should reload");
            assert_eq!(dispatched_task.status, "in_progress");
            let dispatched_assignment = dispatched_task
                .active_lane_assignment
                .as_ref()
                .expect("dispatch task should have active assignment");
            assert_eq!(dispatched_assignment.task_id, dispatch_task.id);
            let dispatch_session_id = dispatched_assignment
                .session_id
                .clone()
                .expect("dispatch should allocate a session");
            drop(connection);
            assert!(dispatch_events.iter().any(|event| {
                event.topic == "task.updated"
                    && event.task_id.as_deref() == Some(dispatch_task.id.as_str())
            }));
            assert!(dispatch_events.iter().any(|event| {
                event.topic == "session.updated"
                    && event.session_id.as_deref() == Some(dispatch_session_id.as_str())
            }));

            let mut receiver = backend.state().subscribe_remote_events();
            run_pause(
                TaskNotesArgs {
                    task: control_task.number.clone(),
                    notes: Some("wait".into()),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task pause should succeed");
            let pause_topics = collect_remote_event_topics(&mut receiver);
            assert!(pause_topics.iter().any(|topic| topic == "task.updated"));

            let mut receiver = backend.state().subscribe_remote_events();
            run_resume(
                TaskNotesArgs {
                    task: control_task.number.clone(),
                    notes: Some("resume".into()),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task resume should succeed");
            let resume_topics = collect_remote_event_topics(&mut receiver);
            assert!(resume_topics.iter().any(|topic| topic == "task.updated"));

            let mut receiver = backend.state().subscribe_remote_events();
            run_stop(
                TaskNotesArgs {
                    task: control_task.number.clone(),
                    notes: Some("done".into()),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task stop should succeed");
            let stop_topics = collect_remote_event_topics(&mut receiver);
            assert!(stop_topics.iter().any(|topic| topic == "task.updated"));

            let connection = database::open_connection().expect("connection should reopen");
            let resumed = tasks::get_task_context(&connection, &control_task.id)
                .expect("control task should reload");
            assert_eq!(resumed.status, "ready");
            assert!(resumed.active_lane_assignment.is_none());
        });
    }

    #[test]
    fn move_needs_work_and_approve_commands_reuse_shared_task_semantics() {
        with_cli_home("cli-task-review", || {
            let backend = build_test_cli_backend("cli-task-review");
            let mut connection = database::open_connection().expect("connection should open");
            let project = create_service_project(&connection, "review");
            let primary_role = create_service_role(&mut connection, "CLI Review Primary");
            let secondary_role = create_service_role(&mut connection, "CLI Review Secondary");
            let relane_workflow = create_runtime_workflow(
                &mut connection,
                "CLI Re-lane Flow",
                &primary_role.slug,
                Some(&secondary_role.slug),
                false,
                false,
            );
            let approval_workflow = create_runtime_workflow(
                &mut connection,
                "CLI Approval Flow",
                &primary_role.slug,
                None,
                true,
                false,
            );
            let move_task = tasks::create_task(
                &mut connection,
                Some(&project.id),
                TaskUpsertInput {
                    title: "Move target".into(),
                    description: None,
                    task_type: "task".into(),
                    tags: Vec::new(),
                    status: "in_progress".into(),
                    priority: "P2".into(),
                    workflow_id: Some(relane_workflow.id.clone()),
                    current_lane_id: Some("lane-work".into()),
                    assignee_type: "role".into(),
                    assignee_id: Some(primary_role.slug.clone()),
                    repository_id: None,
                    repository_ids: Vec::new(),
                    parent_task_id: None,
                    whip_max_attempts: None,
                    archived: Some(false),
                },
            )
            .expect("move task should create");
            insert_assignment(
                &connection,
                &move_task.id,
                &relane_workflow.id,
                "lane-work",
                "role",
                Some(primary_role.slug.as_str()),
                "queued",
            );
            let needs_work_task = tasks::create_task(
                &mut connection,
                Some(&project.id),
                TaskUpsertInput {
                    title: "Needs work target".into(),
                    description: None,
                    task_type: "task".into(),
                    tags: Vec::new(),
                    status: "in_review".into(),
                    priority: "P2".into(),
                    workflow_id: Some(approval_workflow.id.clone()),
                    current_lane_id: Some("lane-work".into()),
                    assignee_type: "role".into(),
                    assignee_id: Some(primary_role.slug.clone()),
                    repository_id: None,
                    repository_ids: Vec::new(),
                    parent_task_id: None,
                    whip_max_attempts: None,
                    archived: Some(false),
                },
            )
            .expect("needs-work task should create");
            insert_assignment(
                &connection,
                &needs_work_task.id,
                &approval_workflow.id,
                "lane-work",
                "role",
                Some(primary_role.slug.as_str()),
                "awaiting_user_approval",
            );
            let approve_task = tasks::create_task(
                &mut connection,
                Some(&project.id),
                TaskUpsertInput {
                    title: "Approve target".into(),
                    description: None,
                    task_type: "task".into(),
                    tags: Vec::new(),
                    status: "in_review".into(),
                    priority: "P2".into(),
                    workflow_id: Some(approval_workflow.id.clone()),
                    current_lane_id: Some("lane-work".into()),
                    assignee_type: "role".into(),
                    assignee_id: Some(primary_role.slug.clone()),
                    repository_id: None,
                    repository_ids: Vec::new(),
                    parent_task_id: None,
                    whip_max_attempts: None,
                    archived: Some(false),
                },
            )
            .expect("approve task should create");
            insert_assignment(
                &connection,
                &approve_task.id,
                &approval_workflow.id,
                "lane-work",
                "role",
                Some(primary_role.slug.as_str()),
                "awaiting_user_approval",
            );
            drop(connection);

            let mut receiver = backend.state().subscribe_remote_events();
            run_move(
                TaskMoveArgs {
                    task: move_task.number.clone(),
                    lane_id: "lane-review".into(),
                    notes: Some("hand off".into()),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("task move should succeed through cli handler");
            let move_events = collect_remote_events(&mut receiver);
            let connection = database::open_connection().expect("connection should reopen");
            let moved_task = tasks::get_task_context(&connection, &move_task.id)
                .expect("move task should reload");
            assert_eq!(moved_task.current_lane_id.as_deref(), Some("lane-review"));
            assert_eq!(moved_task.status, "in_progress");
            let moved_assignment = moved_task
                .active_lane_assignment
                .as_ref()
                .expect("move task should auto-dispatch into the target lane");
            let move_session_id = moved_assignment
                .session_id
                .clone()
                .expect("move task should allocate a target-lane session");
            drop(connection);
            assert!(move_events.iter().any(|event| {
                event.topic == "task.updated"
                    && event.task_id.as_deref() == Some(move_task.id.as_str())
            }));
            assert!(move_events.iter().any(|event| {
                event.topic == "session.updated"
                    && event.session_id.as_deref() == Some(move_session_id.as_str())
            }));

            let mut receiver = backend.state().subscribe_remote_events();
            run_needs_work(
                TaskNotesArgs {
                    task: needs_work_task.number.clone(),
                    notes: Some("rework it".into()),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("needs-work should succeed");
            let needs_work_topics = collect_remote_event_topics(&mut receiver);
            assert!(needs_work_topics
                .iter()
                .any(|topic| topic == "task.updated"));
            let connection = database::open_connection().expect("connection should reopen");
            let reworked_task = tasks::get_task_context(&connection, &needs_work_task.id)
                .expect("needs-work task should reload");
            drop(connection);
            assert_eq!(reworked_task.status, "in_progress");

            let mut receiver = backend.state().subscribe_remote_events();
            run_approve(
                TaskTargetArgs {
                    task: approve_task.number.clone(),
                    json: false,
                },
                &backend,
                Some(project.slug.as_str()),
            )
            .expect("approve should succeed");
            let approve_topics = collect_remote_event_topics(&mut receiver);
            assert!(approve_topics.iter().any(|topic| topic == "task.updated"));
            let connection = database::open_connection().expect("connection should reopen");
            let approved_task = tasks::get_task_context(&connection, &approve_task.id)
                .expect("approved task should reload");
            assert_eq!(approved_task.status, "completed");
            assert!(approved_task.active_lane_assignment.is_none());
        });
    }

    #[test]
    fn resolves_task_number_case_insensitively() {
        let mut connection = setup_connection("task-lookup-number");
        let project = create_project(&connection, "orchestra", "ORC");
        let task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Lookup target".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should create");

        let resolved = resolve_task_target(&connection, None, &task.number.to_lowercase())
            .expect("task number should resolve");
        assert_eq!(resolved.task_id, task.id);
    }

    #[test]
    fn resolves_numeric_task_selector_with_selected_project() {
        let mut connection = setup_connection("task-lookup-numeric");
        let project = create_project(&connection, "orchestra", "ORC");
        let task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Numeric target".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should create");

        let resolved = resolve_task_target(&connection, Some("orchestra"), "1")
            .expect("numeric selector should resolve");
        assert_eq!(resolved.task_id, task.id);
    }

    #[test]
    fn update_overlay_clears_fields_explicitly() {
        let mut connection = setup_connection("task-update-overlay");
        let project = create_project(&connection, "orchestra", "ORC");
        let task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Original".into(),
                description: Some("Has text".into()),
                task_type: "task".into(),
                tags: vec!["cli".into(), "ops".into()],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(3),
                archived: Some(false),
            },
        )
        .expect("task should create");
        let existing = tasks::get_task_context(&connection, &task.id).expect("task should reload");

        let input = apply_update_args(
            &connection,
            Some("orchestra"),
            &existing,
            &TaskUpdateArgs {
                task: task.id.clone(),
                title: Some("Updated".into()),
                description: None,
                clear_description: true,
                task_type: None,
                status: None,
                priority: Some("P1".into()),
                workflow_id: None,
                clear_workflow: false,
                lane_id: None,
                clear_lane: false,
                assignee_type: None,
                assignee_id: None,
                clear_assignee: false,
                repository_id: None,
                clear_repository: false,
                parent_task: None,
                clear_parent: false,
                tags: Vec::new(),
                clear_tags: true,
                whip_max_attempts: Some(7),
                archived: false,
                unarchived: false,
                json: false,
            },
        )
        .expect("overlay should build");

        assert_eq!(input.title, "Updated");
        assert_eq!(input.description, None);
        assert_eq!(input.priority, "P1");
        assert!(input.tags.is_empty());
        assert_eq!(input.whip_max_attempts, Some(7));
    }

    #[test]
    fn comment_delivery_queues_fallback_without_live_runtime() {
        let mut connection = setup_connection("task-comment-fallback");
        let project = create_project(&connection, "orchestra", "ORC");
        let workflow =
            create_agent_review_workflow(&mut connection, &project.id, "agent-data", "data-agent");
        let task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Comment target".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent".into()),
                assignee_type: "agent".into(),
                assignee_id: Some("agent-data".into()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should create");

        let assignment = crate::models::TaskLaneAssignment {
            id: "assignment-comment".into(),
            task_id: task.id.clone(),
            workflow_id: workflow.id.clone(),
            lane_id: "lane-agent".into(),
            worker_type: "agent".into(),
            worker_id: Some("agent-data".into()),
            status: "active".into(),
            session_id: None,
            runtime_cwd: None,
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: None,
            pending_outcome: None,
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: "2026-01-01T00:00:00Z".into(),
            completed_at: None,
            created_at: "2026-01-01T00:00:00Z".into(),
            updated_at: "2026-01-01T00:00:00Z".into(),
        };

        let comment = tasks::add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "CLI".into(),
                origin_type: Some("user".into()),
                origin_id: None,
                message: "Please take another look".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: None,
                relative_path: None,
                absolute_path: None,
                line_start: None,
                line_end: None,
                column_start: None,
                column_end: None,
                selected_text: None,
            },
        )
        .expect("comment should save");

        let warning = task_runtime::notify_or_queue_unread_comment_delivery(
            &connection,
            &assignment,
            &comment,
            || Err("no live runtime".into()),
        );
        assert!(warning.is_some());

        let queued = agent_runtime::list_agent_queue_entries_for_project(
            &connection,
            &project.id,
            Some("agent-data"),
            true,
        )
        .expect("queued deliveries should load");
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0].source_task_id.as_deref(), Some(task.id.as_str()));
        assert_eq!(queued[0].source_type, "task_comment");
    }

    #[test]
    fn pause_resume_and_stop_change_task_state() {
        let mut connection = setup_connection("task-controls");
        let project = create_project(&connection, "orchestra", "ORC");
        let workflow =
            create_role_workflow(&mut connection, &project.id, "role-reviewer", "reviewer");
        let task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Control target".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-work".into()),
                assignee_type: "role".into(),
                assignee_id: Some("reviewer".into()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should create");
        insert_assignment(
            &connection,
            &task.id,
            &workflow.id,
            "lane-work",
            "role",
            Some("reviewer"),
            "queued",
        );

        let paused = task_runtime::pause_task_lane(&connection, &task.id, Some("wait".into()))
            .expect("task should pause");
        assert_eq!(
            paused.active_lane_assignment_status.as_deref(),
            Some("paused_by_user")
        );

        let resumed =
            task_runtime::resume_task_lane(&connection, &task.id).expect("task should resume");
        assert!(matches!(resumed.status.as_str(), "queued" | "active"));

        let stopped =
            task_runtime::stop_task_activity(&mut connection, &task.id, Some("done".into()))
                .expect("task should stop");
        assert_eq!(stopped.status, "ready");
        assert_eq!(stopped.active_lane_assignment_status, None);
    }

    #[test]
    fn approve_and_needs_work_use_review_pause_states() {
        let mut connection = setup_connection("task-approval");
        let project = create_project(&connection, "orchestra", "ORC");
        let workflow =
            create_role_workflow(&mut connection, &project.id, "role-reviewer", "reviewer");
        let context = session_context_for_project_slug(&project.slug);

        let needs_work_task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Needs work target".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_review".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-work".into()),
                assignee_type: "role".into(),
                assignee_id: Some("reviewer".into()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("needs-work task should create");
        insert_assignment(
            &connection,
            &needs_work_task.id,
            &workflow.id,
            "lane-work",
            "role",
            Some("reviewer"),
            "awaiting_user_approval",
        );
        let reworked = task_runtime::mark_task_needs_work(&connection, &needs_work_task.id)
            .expect("needs-work should reactivate the assignment");
        assert!(matches!(reworked.status.as_str(), "queued" | "active"));

        let approval_task = tasks::create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Approval target".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_review".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-work".into()),
                assignee_type: "role".into(),
                assignee_id: Some("reviewer".into()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("approval task should create");
        insert_assignment(
            &connection,
            &approval_task.id,
            &workflow.id,
            "lane-work",
            "role",
            Some("reviewer"),
            "awaiting_user_approval",
        );

        let approved = task_runtime::approve_task_review(
            &mut connection,
            &context.project_root,
            &context.session_dir,
            &approval_task.id,
        )
        .expect("approval should complete the task");
        assert_eq!(approved.status, "completed");
    }
}
