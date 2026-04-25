use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
    process::Command,
};

use chrono::Utc;
use rusqlite::{
    params, params_from_iter, types::Value, Connection, OptionalExtension, Row, TransactionBehavior,
};
use uuid::Uuid;

use crate::{
    models::{
        AuthorizationContext, TaskComment, TaskCommentInput, TaskCommentReceipt, TaskDependency,
        TaskDetail, TaskLaneAssignment, TaskLaneRun, TaskSummary, TaskTodo, TaskTodoInput,
        TaskUpsertInput,
    },
    services::{
        orchestra_paths::{default_orchestra_root, task_attachments_dir},
        projects, task_attachments, task_file_references, task_repositories, task_runtime,
        workflows,
    },
};

const DEFAULT_PROJECT_ID: &str = "orchestra";
const VALID_TASK_TYPES: &[&str] = &["task", "bug", "feature", "chore", "epic"];
const VALID_TASK_STATUSES: &[&str] = &[
    "draft",
    "ready",
    "in_progress",
    "blocked",
    "in_review",
    "completed",
    "canceled",
];
const VALID_TASK_PRIORITIES: &[&str] = &["P0", "P1", "P2", "P3", "P4"];
const VALID_ASSIGNEE_TYPES: &[&str] = &["user", "agent", "role", "unassigned"];
const VALID_COMMENT_ORIGIN_TYPES: &[&str] = &["user", "agent", "role", "system"];
const DEFAULT_TASK_COMMENT_USER_ID: &str = "desktop-user";
const TERMINAL_TASK_STATUSES: &[&str] = &["completed", "canceled"];
const TASK_TAG_SEPARATOR: char = '\u{001F}';
const MAX_TASK_TAG_LENGTH: usize = 32;
const MAX_TASK_TAG_COUNT: usize = 20;

#[cfg(test)]
type PostTaskNumberAllocationHook = std::sync::Arc<dyn Fn(&str) + Send + Sync>;

#[cfg(test)]
static POST_TASK_NUMBER_ALLOCATION_HOOK: std::sync::OnceLock<
    std::sync::Mutex<Option<PostTaskNumberAllocationHook>>,
> = std::sync::OnceLock::new();

#[cfg(test)]
fn set_post_task_number_allocation_hook(hook: Option<PostTaskNumberAllocationHook>) {
    let hook_slot = POST_TASK_NUMBER_ALLOCATION_HOOK.get_or_init(|| std::sync::Mutex::new(None));
    let mut active_hook = hook_slot
        .lock()
        .expect("post-allocation hook mutex should lock");
    *active_hook = hook;
}

#[cfg(test)]
fn run_post_task_number_allocation_hook(task_title: &str) {
    let hook = POST_TASK_NUMBER_ALLOCATION_HOOK
        .get()
        .and_then(|hook_slot| hook_slot.lock().ok().and_then(|hook| hook.clone()));
    if let Some(hook) = hook {
        hook(task_title);
    }
}

#[cfg(not(test))]
fn run_post_task_number_allocation_hook(_task_title: &str) {}

#[derive(Debug, Clone)]
struct CommentAnchorInput {
    repository_id: String,
    relative_path: String,
    line_start: i64,
    line_end: i64,
    column_start: Option<i64>,
    column_end: Option<i64>,
    selected_text: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct CommentAnchorMetadata {
    commit_hash: Option<String>,
    has_uncommitted_changes: Option<bool>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskTagMatchMode {
    All,
    Any,
}

impl Default for TaskTagMatchMode {
    fn default() -> Self {
        Self::All
    }
}

impl TaskTagMatchMode {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("all") => Ok(Self::All),
            Some("any") => Ok(Self::Any),
            Some(other) => Err(format!(
                "tagMatch: Unsupported task tag match mode `{other}`. Expected `all` or `any`."
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSortField {
    UpdatedAt,
    CreatedAt,
    Priority,
    Number,
    Title,
    Tags,
}

impl Default for TaskSortField {
    fn default() -> Self {
        Self::UpdatedAt
    }
}

impl TaskSortField {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("updatedAt") => Ok(Self::UpdatedAt),
            Some("createdAt") => Ok(Self::CreatedAt),
            Some("priority") => Ok(Self::Priority),
            Some("number") => Ok(Self::Number),
            Some("title") => Ok(Self::Title),
            Some("tags") => Ok(Self::Tags),
            Some(other) => Err(format!(
                "sortBy: Unsupported task sort field `{other}`. Expected one of `updatedAt`, `createdAt`, `priority`, `number`, `title`, or `tags`."
            )),
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum TaskSortDirection {
    Asc,
    Desc,
}

impl Default for TaskSortDirection {
    fn default() -> Self {
        Self::Desc
    }
}

impl TaskSortDirection {
    pub fn parse(value: Option<&str>) -> Result<Self, String> {
        match value.map(str::trim).filter(|value| !value.is_empty()) {
            None | Some("desc") => Ok(Self::Desc),
            Some("asc") => Ok(Self::Asc),
            Some(other) => Err(format!(
                "sortDirection: Unsupported task sort direction `{other}`. Expected `asc` or `desc`."
            )),
        }
    }

    fn sql_keyword(self) -> &'static str {
        match self {
            Self::Asc => "ASC",
            Self::Desc => "DESC",
        }
    }
}

#[derive(Debug, Clone, Default)]
pub struct TaskListQuery {
    pub include_archived: bool,
    pub tags: Vec<String>,
    pub tag_match: TaskTagMatchMode,
    pub sort_by: TaskSortField,
    pub sort_direction: TaskSortDirection,
}

impl TaskListQuery {
    pub fn from_raw(
        include_archived: Option<bool>,
        tags: Option<Vec<String>>,
        tag_match: Option<&str>,
        sort_by: Option<&str>,
        sort_direction: Option<&str>,
    ) -> Result<Self, String> {
        let tags = normalize_task_tags(tags.unwrap_or_default());
        let validation_errors = validate_task_tags(&tags);
        if !validation_errors.is_empty() {
            return Err(validation_errors.join(" "));
        }

        Ok(Self {
            include_archived: include_archived.unwrap_or(false),
            tags,
            tag_match: TaskTagMatchMode::parse(tag_match)?,
            sort_by: TaskSortField::parse(sort_by)?,
            sort_direction: TaskSortDirection::parse(sort_direction)?,
        })
    }
}

pub fn list_tasks(
    connection: &Connection,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<TaskSummary>, String> {
    list_tasks_with_query(
        connection,
        project_id,
        TaskListQuery {
            include_archived,
            ..TaskListQuery::default()
        },
    )
}

pub fn list_tasks_with_query(
    connection: &Connection,
    project_id: &str,
    query: TaskListQuery,
) -> Result<Vec<TaskSummary>, String> {
    projects::ensure_project_exists(connection, project_id)?;

    let matching_tags_cte = if query.tags.is_empty() {
        "matching_tags AS (SELECT NULL AS task_id, 0 AS matched_tag_count WHERE 0)".to_string()
    } else {
        let placeholders = (1..=query.tags.len())
            .map(|index| format!("?{index}"))
            .collect::<Vec<_>>()
            .join(", ");
        format!(
            "matching_tags AS (SELECT tt.task_id, COUNT(DISTINCT tt.tag) AS matched_tag_count FROM task_tags tt WHERE tt.tag IN ({placeholders}) GROUP BY tt.task_id)"
        )
    };
    let tag_filter_sql = match (query.tags.is_empty(), query.tag_match) {
        (true, _) => String::new(),
        (false, TaskTagMatchMode::All) => format!(
            " AND COALESCE(mt.matched_tag_count, 0) = {}",
            query.tags.len()
        ),
        (false, TaskTagMatchMode::Any) => " AND COALESCE(mt.matched_tag_count, 0) >= 1".into(),
    };
    let project_param_index = query.tags.len() + 1;
    let archived_param_index = query.tags.len() + 2;
    let mut statement = connection
        .prepare(&format!(
            r#"
            WITH
                {matching_tags_cte},
                tag_rollup AS (
                    SELECT
                        ordered_tags.task_id,
                        COUNT(*) AS tag_count,
                        GROUP_CONCAT(ordered_tags.tag, ',') AS tag_sort_key
                    FROM (
                        SELECT tt.task_id, tt.tag
                        FROM task_tags tt
                        ORDER BY tt.task_id ASC, tt.tag ASC
                    ) ordered_tags
                    GROUP BY ordered_tags.task_id
                )
            SELECT
                {summary_columns}
            FROM tasks t
            LEFT JOIN matching_tags mt ON mt.task_id = t.id
            LEFT JOIN tag_rollup tr ON tr.task_id = t.id
            WHERE t.project_id = ?{project_param_index}
              AND (?{archived_param_index} = 1 OR t.archived = 0)
              {tag_filter_sql}
            ORDER BY {order_clause}
            "#,
            matching_tags_cte = matching_tags_cte,
            summary_columns = task_summary_columns("t"),
            project_param_index = project_param_index,
            archived_param_index = archived_param_index,
            tag_filter_sql = tag_filter_sql,
            order_clause = task_list_order_clause(&query),
        ))
        .map_err(|error| format!("Unable to prepare task list query: {error}"))?;

    let mut parameters = query
        .tags
        .iter()
        .cloned()
        .map(Value::from)
        .collect::<Vec<_>>();
    parameters.push(Value::from(project_id.to_string()));
    parameters.push(Value::from(if query.include_archived { 1 } else { 0 }));

    let rows = statement
        .query_map(params_from_iter(parameters), map_task_summary_row)
        .map_err(|error| format!("Unable to query tasks for project {project_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read task rows: {error}"))
}

pub fn list_tasks_materialized_from_schedule(
    connection: &Connection,
    schedule_id: &str,
    limit: usize,
) -> Result<Vec<TaskSummary>, String> {
    let mut statement = connection
        .prepare(&format!(
            r#"
            SELECT
                {summary_columns}
            FROM tasks t
            WHERE t.source_schedule_id = ?1
            ORDER BY t.created_at DESC, t.id DESC
            LIMIT ?2
            "#,
            summary_columns = task_summary_columns("t"),
        ))
        .map_err(|error| {
            format!(
                "Unable to prepare schedule materialized tasks query for {schedule_id}: {error}"
            )
        })?;

    let rows = statement
        .query_map(params![schedule_id, limit as i64], map_task_summary_row)
        .map_err(|error| {
            format!("Unable to query materialized tasks for schedule {schedule_id}: {error}")
        })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        format!("Unable to read materialized tasks for schedule {schedule_id}: {error}")
    })
}

pub fn get_task(connection: &Connection, task_id: &str) -> Result<TaskDetail, String> {
    let mut task = connection
        .query_row(
            &format!(
                r#"
                SELECT
                    {summary_columns},
                    t.repository_id
                FROM tasks t
                WHERE t.id = ?1
                "#,
                summary_columns = task_summary_columns("t"),
            ),
            [task_id],
            |row| {
                Ok(TaskDetail {
                    id: row.get(0)?,
                    project_id: row.get(1)?,
                    number: row.get(2)?,
                    title: row.get(3)?,
                    description: row.get(4)?,
                    task_type: row.get(5)?,
                    tags: parse_task_tags_csv(row.get::<_, String>(6)?),
                    status: row.get(7)?,
                    priority: row.get(8)?,
                    workflow_id: row.get(9)?,
                    current_lane_id: row.get(10)?,
                    assignee_type: row.get(11)?,
                    assignee_id: row.get(12)?,
                    parent_task_id: row.get(13)?,
                    whip_max_attempts: row.get(14)?,
                    archived: row.get::<_, i64>(15)? != 0,
                    comment_count: row.get(16)?,
                    unread_comment_count: row.get(17)?,
                    lane_run_count: row.get(18)?,
                    child_count: row.get(19)?,
                    completed_child_count: row.get(20)?,
                    in_progress_child_count: row.get(21)?,
                    blocked_child_count: row.get(22)?,
                    blocked_by_count: row.get(23)?,
                    blocking_count: row.get(24)?,
                    attachment_count: row.get(25)?,
                    dependency_blocked: row.get::<_, i64>(26)? != 0,
                    active_lane_assignment_status: row.get(27)?,
                    ready_for_dispatch: row.get::<_, i64>(28)? != 0,
                    repository_id: row.get(31)?,
                    repository_ids: Vec::new(),
                    parent: None,
                    lineage: Vec::new(),
                    children: Vec::new(),
                    blocked_by: Vec::new(),
                    blocking: Vec::new(),
                    attachments: Vec::new(),
                    task_repositories: Vec::new(),
                    file_references: Vec::new(),
                    comments: Vec::new(),
                    todos: Vec::new(),
                    lane_runs: Vec::new(),
                    active_lane_assignment: None,
                    created_at: row.get(29)?,
                    updated_at: row.get(30)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query task {task_id}: {error}"))?
        .ok_or_else(|| format!("Task {task_id} was not found"))?;

    task.parent = load_parent_summary(connection, task.parent_task_id.as_deref())?;
    task.lineage = load_lineage(connection, task.parent_task_id.clone())?;
    task.children = load_child_tasks(connection, task_id)?;
    task.blocked_by = load_blocked_by_dependencies(connection, task_id)?;
    task.blocking = load_blocking_dependencies(connection, task_id)?;
    task.attachments = task_attachments::load_task_attachments(connection, task_id)?;
    task.active_lane_assignment = task_runtime::get_current_lane_assignment(connection, task_id)?;
    task.active_lane_assignment_status = task
        .active_lane_assignment
        .as_ref()
        .map(|assignment| assignment.status.clone());
    task.task_repositories = task_repositories::load_task_repositories(
        connection,
        task_id,
        task.active_lane_assignment
            .as_ref()
            .and_then(|assignment| assignment.runtime_cwd.as_deref()),
    )?;
    task.repository_ids = task
        .task_repositories
        .iter()
        .map(|repository| repository.repository_id.clone())
        .collect();
    task.file_references = task_file_references::load_task_file_references(
        connection,
        task_id,
        task.active_lane_assignment
            .as_ref()
            .and_then(|assignment| assignment.runtime_cwd.as_deref()),
    )?;
    task.comments = load_task_comments(connection, task_id)?;
    task.todos = load_task_todos(connection, task_id, None, None)?;
    task.lane_runs = load_task_lane_runs(connection, task_id)?;
    Ok(task)
}

pub fn get_task_context(connection: &Connection, task_id: &str) -> Result<TaskDetail, String> {
    get_task(connection, task_id)
}

pub fn list_task_comments(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskComment>, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }
    load_task_comments(connection, task_id)
}

pub fn list_task_todos(connection: &Connection, task_id: &str) -> Result<Vec<TaskTodo>, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }
    load_task_todos(connection, task_id, None, None)
}

pub fn list_unfinished_task_todos(
    connection: &Connection,
    task_id: &str,
    lane_id: Option<&str>,
) -> Result<Vec<TaskTodo>, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }
    load_task_todos(connection, task_id, lane_id, Some(false))
}

pub fn add_task_todo(
    connection: &Connection,
    task_id: &str,
    input: TaskTodoInput,
) -> Result<TaskTodo, String> {
    add_task_todo_with_authorization(connection, task_id, input, None)
}

pub(crate) fn add_task_todo_with_authorization(
    connection: &Connection,
    task_id: &str,
    input: TaskTodoInput,
    authorization: Option<&AuthorizationContext>,
) -> Result<TaskTodo, String> {
    let task = get_task(connection, task_id)?;
    let lane_id = normalized_optional_string(input.lane_id)
        .ok_or_else(|| "laneId: A workflow lane is required for task todos.".to_string())?;
    validate_task_todo_input(
        connection,
        &task,
        &lane_id,
        &input.description,
        authorization,
    )?;
    let now = now_iso();
    let todo = TaskTodo {
        id: task_todo_id(),
        task_id: task.id,
        lane_id,
        description: input.description.trim().to_string(),
        completed: false,
        created_at: now.clone(),
        updated_at: now.clone(),
    };

    connection
        .execute(
            r#"
            INSERT INTO task_todos (id, task_id, lane_id, description, completed, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, 0, ?5, ?6)
            "#,
            params![
                todo.id,
                todo.task_id,
                todo.lane_id,
                todo.description,
                todo.created_at,
                todo.updated_at,
            ],
        )
        .map_err(|error| format!("Unable to create task todo for task {task_id}: {error}"))?;

    get_task_todo(connection, &todo.id)?
        .ok_or_else(|| format!("Task todo {} was not found after creation", todo.id))
}

pub fn mark_task_todo_finished(connection: &Connection, todo_id: &str) -> Result<TaskTodo, String> {
    update_task_todo_completion(connection, todo_id, true)
}

pub fn mark_task_todo_unfinished(
    connection: &Connection,
    todo_id: &str,
) -> Result<TaskTodo, String> {
    update_task_todo_completion(connection, todo_id, false)
}

pub fn delete_task_todo(connection: &Connection, todo_id: &str) -> Result<TaskTodo, String> {
    let todo = get_task_todo(connection, todo_id)?
        .ok_or_else(|| format!("Task todo {todo_id} was not found"))?;
    connection
        .execute("DELETE FROM task_todos WHERE id = ?1", [todo_id])
        .map_err(|error| format!("Unable to delete task todo {todo_id}: {error}"))?;
    Ok(todo)
}

pub fn create_task(
    connection: &mut Connection,
    project_id: Option<&str>,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let project_id = projects::require_requested_or_default_project_id(
        connection,
        project_id,
        "Create a project first before creating tasks.",
    )?;
    create_task_from_blueprint(connection, &project_id, input, None, None)
}

pub fn create_task_from_blueprint(
    connection: &mut Connection,
    project_id: &str,
    input: TaskUpsertInput,
    source_schedule_id: Option<&str>,
    source_schedule_occurrence_id: Option<&str>,
) -> Result<TaskDetail, String> {
    projects::ensure_project_exists(connection, project_id)?;
    let normalized = prepare_task_input_for_project(connection, project_id, input, None)?;
    let task_id = task_id();
    let now = now_iso();
    let tx = connection
        .transaction_with_behavior(TransactionBehavior::Immediate)
        .map_err(|error| format!("Unable to start task creation transaction: {error}"))?;
    let sequence_number = next_task_sequence_number(&tx, project_id)?;
    let task_prefix = projects::get_project_task_prefix(&tx, project_id)?;
    let number = format!("{task_prefix}-{sequence_number}");
    run_post_task_number_allocation_hook(&normalized.title);

    tx.execute(
        r#"
        INSERT INTO tasks (
            id,
            project_id,
            sequence_number,
            number,
            title,
            description,
            task_type,
            status,
            priority,
            workflow_id,
            current_lane_id,
            assignee_type,
            assignee_id,
            repository_id,
            parent_task_id,
            whip_max_attempts,
            archived,
            source_schedule_id,
            source_schedule_occurrence_id,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19, ?20, ?20)
        "#,
        params![
            task_id,
            project_id,
            sequence_number,
            number,
            normalized.title,
            normalized.description,
            normalized.task_type,
            normalized.status,
            normalized.priority,
            normalized.workflow_id,
            normalized.current_lane_id,
            normalized.assignee_type,
            normalized.assignee_id,
            normalized.repository_ids.first().cloned(),
            normalized.parent_task_id,
            normalized.whip_max_attempts.unwrap_or(10),
            if normalized.archived.unwrap_or(false) { 1 } else { 0 },
            source_schedule_id,
            source_schedule_occurrence_id,
            now,
        ],
    )
    .map_err(|error| format!("Unable to create task: {error}"))?;

    sync_task_repository_links(&tx, &task_id, project_id, &normalized.repository_ids, &now)?;
    sync_task_tags(&tx, &task_id, &normalized.tags, &now)?;
    reconcile_dependency_statuses(
        &tx,
        collect_task_refresh_ids_with_parent_overrides(
            &tx,
            &task_id,
            normalized.parent_task_id.as_deref(),
            normalized.parent_task_id.as_deref(),
        )?,
        &now,
    )?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task creation: {error}"))?;

    get_task(connection, &task_id)
}

pub fn create_subtask(
    connection: &mut Connection,
    parent_task_id: &str,
    mut input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    input.parent_task_id = Some(parent_task_id.to_string());
    let project_id = connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [parent_task_id],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| format!("Unable to resolve parent task project: {error}"))?;
    create_task(connection, Some(&project_id), input)
}

pub fn prepare_task_input_for_project(
    connection: &Connection,
    project_id: &str,
    input: TaskUpsertInput,
    existing_task_id: Option<&str>,
) -> Result<TaskUpsertInput, String> {
    let normalized = apply_default_task_repositories(
        connection,
        project_id,
        apply_default_lane_if_needed(connection, normalize_input(input))?,
    )?;
    validate_task_input(connection, project_id, &normalized, existing_task_id)?;
    Ok(normalized)
}

pub fn update_task(
    connection: &mut Connection,
    task_id: &str,
    input: TaskUpsertInput,
) -> Result<TaskDetail, String> {
    let existing = get_task(connection, task_id)?;
    let normalized =
        prepare_task_input_for_project(connection, &existing.project_id, input, Some(task_id))?;
    let now = now_iso();

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task update transaction: {error}"))?;

    tx.execute(
        r#"
        UPDATE tasks
        SET title = ?2,
            description = ?3,
            task_type = ?4,
            status = ?5,
            priority = ?6,
            workflow_id = ?7,
            current_lane_id = ?8,
            assignee_type = ?9,
            assignee_id = ?10,
            repository_id = ?11,
            parent_task_id = ?12,
            whip_max_attempts = ?13,
            archived = ?14,
            updated_at = ?15
        WHERE id = ?1
        "#,
        params![
            task_id,
            normalized.title,
            normalized.description,
            normalized.task_type,
            normalized.status,
            normalized.priority,
            normalized.workflow_id,
            normalized.current_lane_id,
            normalized.assignee_type,
            normalized.assignee_id,
            normalized.repository_ids.first().cloned(),
            normalized.parent_task_id,
            normalized
                .whip_max_attempts
                .unwrap_or(existing.whip_max_attempts),
            if normalized.archived.unwrap_or(existing.archived) {
                1
            } else {
                0
            },
            now,
        ],
    )
    .map_err(|error| format!("Unable to update task {task_id}: {error}"))?;

    if normalized.status != existing.status {
        tx.execute(
            "UPDATE tasks SET auto_blocked_by_dependencies = 0 WHERE id = ?1",
            [task_id],
        )
        .map_err(|error| {
            format!("Unable to clear dependency auto-block provenance for task {task_id}: {error}")
        })?;
    }

    sync_task_repository_links(
        &tx,
        task_id,
        &existing.project_id,
        &normalized.repository_ids,
        &now,
    )?;
    sync_task_tags(&tx, task_id, &normalized.tags, &now)?;
    reconcile_dependency_statuses(
        &tx,
        collect_task_refresh_ids_with_parent_overrides(
            &tx,
            task_id,
            existing.parent_task_id.as_deref(),
            normalized.parent_task_id.as_deref(),
        )?,
        &now,
    )?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task update: {error}"))?;

    get_task(connection, task_id)
}

pub fn delete_task(connection: &mut Connection, task_id: &str) -> Result<TaskDetail, String> {
    let task = get_task(connection, task_id)?;
    let attachments = task_attachments::load_task_attachments(connection, task_id)?;
    let orchestra_root = default_orchestra_root()?;
    let attachment_dir = task_attachments_dir(&orchestra_root, &task.project_id, task_id);

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task deletion transaction: {error}"))?;

    let deleted = tx
        .execute("DELETE FROM tasks WHERE id = ?1", [task_id])
        .map_err(|error| format!("Unable to delete task {task_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task {task_id} was not found"));
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit task deletion: {error}"))?;

    for attachment in attachments {
        let path = std::path::PathBuf::from(&attachment.stored_path);
        if path.exists() {
            fs::remove_file(&path).map_err(|error| {
                format!(
                    "Unable to remove task attachment file {}: {error}",
                    path.display()
                )
            })?;
        }
    }

    if attachment_dir.exists() {
        fs::remove_dir_all(&attachment_dir).map_err(|error| {
            format!(
                "Unable to remove task attachment directory {}: {error}",
                attachment_dir.display()
            )
        })?;
    }

    Ok(task)
}

pub fn add_task_dependency(
    connection: &mut Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<TaskDependency, String> {
    validate_dependency_edge(connection, blocker_task_id, blocked_task_id)?;

    let project_id = task_project_id(connection, blocker_task_id)?;
    let (blocker_workflow_id, blocker_lane_id, blocker_lane_order) =
        dependency_blocker_lane_snapshot(connection, blocker_task_id)?;
    let dependency_id = dependency_id();
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start dependency transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO task_dependencies (
            id,
            project_id,
            blocker_task_id,
            blocked_task_id,
            blocker_workflow_id,
            blocker_lane_id,
            blocker_lane_order,
            created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
        "#,
        params![
            dependency_id,
            project_id,
            blocker_task_id,
            blocked_task_id,
            blocker_workflow_id,
            blocker_lane_id,
            blocker_lane_order,
            now
        ],
    )
    .map_err(|error| format!("Unable to add task dependency: {error}"))?;
    reconcile_dependency_statuses(&tx, collect_task_refresh_ids(&tx, blocked_task_id)?, &now)?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task dependency: {error}"))?;

    load_dependency(connection, &dependency_id)
}

pub fn remove_task_dependency(
    connection: &Connection,
    dependency_id: &str,
) -> Result<TaskDependency, String> {
    let dependency = load_dependency(connection, dependency_id)?;
    let deleted = connection
        .execute(
            "DELETE FROM task_dependencies WHERE id = ?1",
            [dependency_id],
        )
        .map_err(|error| format!("Unable to remove task dependency {dependency_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task dependency {dependency_id} was not found"));
    }

    reconcile_dependency_statuses(
        connection,
        collect_task_refresh_ids(connection, &dependency.blocked_task_id)?,
        &now_iso(),
    )?;

    Ok(dependency)
}

pub fn collect_task_refresh_ids(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<String>, String> {
    let current_parent_task_id = connection
        .query_row(
            "SELECT parent_task_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to resolve current parent task for refresh collection on {task_id}: {error}"
            )
        })?
        .flatten();
    collect_task_refresh_ids_with_parent_overrides(
        connection,
        task_id,
        current_parent_task_id.as_deref(),
        current_parent_task_id.as_deref(),
    )
}

pub fn collect_parent_chain_task_ids(
    connection: &Connection,
    parent_task_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut task_ids = Vec::new();
    let mut current_parent_id = parent_task_id.map(|value| value.to_string());

    while let Some(parent_id) = current_parent_id {
        task_ids.push(parent_id.clone());
        current_parent_id = connection
            .query_row(
                "SELECT parent_task_id FROM tasks WHERE id = ?1",
                [parent_id.as_str()],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve parent task chain for task {}: {error}",
                    task_ids.last().cloned().unwrap_or_default()
                )
            })?
            .flatten();
    }

    Ok(task_ids)
}

pub fn reconcile_dependency_statuses(
    connection: &Connection,
    task_ids: impl IntoIterator<Item = String>,
    now: &str,
) -> Result<Vec<String>, String> {
    let mut changed_task_ids = Vec::new();

    for task_id in unique_task_ids(task_ids) {
        if reconcile_dependency_status(connection, &task_id, now)? {
            changed_task_ids.push(task_id);
        }
    }

    Ok(changed_task_ids)
}

fn collect_task_refresh_ids_with_parent_overrides(
    connection: &Connection,
    task_id: &str,
    old_parent_task_id: Option<&str>,
    new_parent_task_id: Option<&str>,
) -> Result<Vec<String>, String> {
    let mut task_ids = vec![task_id.to_string()];
    task_ids.extend(load_dependent_task_ids(connection, task_id)?);
    task_ids.extend(collect_parent_chain_task_ids(
        connection,
        old_parent_task_id,
    )?);
    task_ids.extend(collect_parent_chain_task_ids(
        connection,
        new_parent_task_id,
    )?);
    Ok(unique_task_ids(task_ids))
}

fn load_dependent_task_ids(
    connection: &Connection,
    blocker_task_id: &str,
) -> Result<Vec<String>, String> {
    connection
        .prepare(
            r#"
            SELECT blocked_task_id
            FROM task_dependencies
            WHERE blocker_task_id = ?1
            ORDER BY blocked_task_id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare dependent task query: {error}"))?
        .query_map([blocker_task_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query dependent tasks for {blocker_task_id}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read dependent tasks for {blocker_task_id}: {error}"))
}

fn reconcile_dependency_status(
    connection: &Connection,
    task_id: &str,
    now: &str,
) -> Result<bool, String> {
    let Some((status, auto_blocked_by_dependencies, has_blockers)) = connection
        .query_row(
            &format!(
                r#"
                SELECT
                    t.status,
                    t.auto_blocked_by_dependencies,
                    CASE
                        WHEN {unresolved_blockers} > 0 OR {unfinished_child_blockers} > 0 THEN 1
                        ELSE 0
                    END AS has_blockers
                FROM tasks t
                WHERE t.id = ?1
                "#,
                unresolved_blockers = unresolved_blocker_sql("t"),
                unfinished_child_blockers = unfinished_child_blocker_sql("t"),
            ),
            [task_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)? != 0,
                    row.get::<_, i64>(2)? != 0,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to inspect dependency status for task {task_id}: {error}")
        })?
    else {
        return Ok(false);
    };

    if TERMINAL_TASK_STATUSES.contains(&status.as_str()) {
        if auto_blocked_by_dependencies {
            connection
                .execute(
                    "UPDATE tasks SET auto_blocked_by_dependencies = 0, updated_at = ?2 WHERE id = ?1",
                    params![task_id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to clear dependency auto-block provenance for terminal task {task_id}: {error}"
                    )
                })?;
            return Ok(true);
        }
        return Ok(false);
    }

    if has_blockers {
        return match status.as_str() {
            "ready" | "in_progress" | "in_review" => {
                connection
                    .execute(
                        "UPDATE tasks SET status = 'blocked', auto_blocked_by_dependencies = 1, updated_at = ?2 WHERE id = ?1",
                        params![task_id, now],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to auto-block dependency-blocked task {task_id}: {error}"
                        )
                    })?;
                Ok(true)
            }
            "blocked" => Ok(false),
            _ => {
                if auto_blocked_by_dependencies {
                    connection
                        .execute(
                            "UPDATE tasks SET auto_blocked_by_dependencies = 0, updated_at = ?2 WHERE id = ?1",
                            params![task_id, now],
                        )
                        .map_err(|error| {
                            format!(
                                "Unable to clear stale dependency auto-block provenance for task {task_id}: {error}"
                            )
                        })?;
                    Ok(true)
                } else {
                    Ok(false)
                }
            }
        };
    }

    if status == "blocked" && auto_blocked_by_dependencies {
        connection
            .execute(
                "UPDATE tasks SET status = 'ready', auto_blocked_by_dependencies = 0, updated_at = ?2 WHERE id = ?1",
                params![task_id, now],
            )
            .map_err(|error| {
                format!("Unable to restore fully unblocked task {task_id} to ready: {error}")
            })?;
        return Ok(true);
    }

    if auto_blocked_by_dependencies {
        connection
            .execute(
                "UPDATE tasks SET auto_blocked_by_dependencies = 0, updated_at = ?2 WHERE id = ?1",
                params![task_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to clear dependency auto-block provenance for task {task_id}: {error}"
                )
            })?;
        return Ok(true);
    }

    Ok(false)
}

fn unique_task_ids(task_ids: impl IntoIterator<Item = String>) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut unique = Vec::new();

    for task_id in task_ids {
        if seen.insert(task_id.clone()) {
            unique.push(task_id);
        }
    }

    unique
}

pub fn add_task_comment(
    connection: &mut Connection,
    task_id: &str,
    input: TaskCommentInput,
) -> Result<TaskComment, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }

    let TaskCommentInput {
        author,
        origin_type,
        origin_id,
        message,
        interrupt_agent,
        parent_comment_id,
        repository_id,
        relative_path,
        absolute_path,
        line_start,
        line_end,
        column_start,
        column_end,
        selected_text,
    } = input;

    let author = author.trim();
    let message = message.trim();
    let origin_type = normalized_optional_string(origin_type).unwrap_or_else(|| "user".into());
    let origin_id = normalized_optional_string(origin_id);
    let parent_comment_id = normalized_optional_string(parent_comment_id);
    if author.is_empty() {
        return Err("author: Comment author is required.".to_string());
    }
    if message.is_empty() {
        return Err("message: Comment message is required.".to_string());
    }
    if !VALID_COMMENT_ORIGIN_TYPES.contains(&origin_type.as_str()) {
        return Err(
            "originType: Comment origin must be one of: user, agent, role, system.".to_string(),
        );
    }
    validate_task_comment_parent(connection, task_id, parent_comment_id.as_deref())?;

    let (anchor_input, anchor_metadata) = resolve_comment_anchor(
        connection,
        task_id,
        normalized_optional_string(repository_id),
        normalized_optional_string(relative_path),
        normalized_optional_string(absolute_path),
        line_start,
        line_end,
        column_start,
        column_end,
        normalized_optional_string(selected_text),
    )?;

    let now = now_iso();
    let comment = TaskComment {
        id: format!("task-comment-{}", Uuid::new_v4().simple()),
        task_id: task_id.to_string(),
        parent_comment_id: parent_comment_id.clone(),
        author: author.to_string(),
        origin_type: origin_type.clone(),
        origin_id: origin_id.clone(),
        message: message.to_string(),
        interrupt_agent,
        repository_id: anchor_input
            .as_ref()
            .map(|anchor| anchor.repository_id.clone()),
        relative_path: anchor_input
            .as_ref()
            .map(|anchor| anchor.relative_path.clone()),
        line_start: anchor_input.as_ref().map(|anchor| anchor.line_start),
        line_end: anchor_input.as_ref().map(|anchor| anchor.line_end),
        column_start: anchor_input.as_ref().and_then(|anchor| anchor.column_start),
        column_end: anchor_input.as_ref().and_then(|anchor| anchor.column_end),
        selected_text: anchor_input
            .as_ref()
            .and_then(|anchor| anchor.selected_text.clone()),
        anchor_commit_hash: anchor_metadata.commit_hash,
        anchor_has_uncommitted_changes: anchor_metadata.has_uncommitted_changes,
        created_at: now.clone(),
        updated_at: now,
    };

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task comment transaction: {error}"))?;
    tx.execute(
        "INSERT INTO task_comments (id, task_id, parent_comment_id, author, origin_type, origin_id, message, interrupt_agent, repository_id, relative_path, line_start, line_end, column_start, column_end, selected_text, anchor_commit_hash, anchor_has_uncommitted_changes, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, ?16, ?17, ?18, ?19)",
        params![
            comment.id,
            comment.task_id,
            comment.parent_comment_id,
            comment.author,
            comment.origin_type,
            comment.origin_id,
            comment.message,
            if comment.interrupt_agent { 1 } else { 0 },
            comment.repository_id,
            comment.relative_path,
            comment.line_start,
            comment.line_end,
            comment.column_start,
            comment.column_end,
            comment.selected_text,
            comment.anchor_commit_hash,
            comment.anchor_has_uncommitted_changes.map(|value| if value { 1 } else { 0 }),
            comment.created_at,
            comment.updated_at,
        ],
    )
    .map_err(|error| format!("Unable to add task comment: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Unable to commit task comment: {error}"))?;

    let _ = crate::services::task_comment_file_mentions::add_file_references_for_comment_mentions(
        connection,
        task_id,
        comment.message.as_str(),
    );

    Ok(comment)
}

pub fn update_task_comment(
    connection: &mut Connection,
    comment_id: &str,
    input: crate::models::TaskCommentUpdateInput,
) -> Result<TaskComment, String> {
    let existing = load_task_comment(connection, comment_id)?;
    let message = input.message.trim();
    if message.is_empty() {
        return Err("message: Comment message is required.".to_string());
    }
    let updated_at = now_iso();
    connection
        .execute(
            "UPDATE task_comments SET message = ?2, updated_at = ?3 WHERE id = ?1",
            params![comment_id, message, updated_at],
        )
        .map_err(|error| format!("Unable to update task comment {comment_id}: {error}"))?;

    Ok(TaskComment {
        message: message.to_string(),
        updated_at,
        ..existing
    })
}

pub fn delete_task_comment(
    connection: &mut Connection,
    comment_id: &str,
) -> Result<TaskComment, String> {
    let comment = load_task_comment(connection, comment_id)?;
    let deleted = connection
        .execute("DELETE FROM task_comments WHERE id = ?1", [comment_id])
        .map_err(|error| format!("Unable to delete task comment {comment_id}: {error}"))?;
    if deleted == 0 {
        return Err(format!("Task comment {comment_id} was not found"));
    }
    Ok(comment)
}

fn resolve_comment_anchor(
    connection: &Connection,
    task_id: &str,
    repository_id: Option<String>,
    relative_path: Option<String>,
    absolute_path: Option<String>,
    line_start: Option<i64>,
    line_end: Option<i64>,
    column_start: Option<i64>,
    column_end: Option<i64>,
    selected_text: Option<String>,
) -> Result<(Option<CommentAnchorInput>, CommentAnchorMetadata), String> {
    let has_anchor_input = repository_id.is_some()
        || relative_path.is_some()
        || line_start.is_some()
        || line_end.is_some()
        || column_start.is_some()
        || column_end.is_some()
        || selected_text.is_some();

    if !has_anchor_input {
        return Ok((None, CommentAnchorMetadata::default()));
    }

    let repository_id = repository_id.ok_or_else(|| {
        "repositoryId: File-anchored comments require a repository id.".to_string()
    })?;
    let relative_path = relative_path.ok_or_else(|| {
        "relativePath: File-anchored comments require a relative path.".to_string()
    })?;
    let line_start = line_start.ok_or_else(|| {
        "lineStart: File-anchored comments require a starting line number.".to_string()
    })?;
    let line_end = line_end.unwrap_or(line_start);

    if line_start < 1 {
        return Err("lineStart: File-anchored comments require a positive starting line.".into());
    }
    if line_end < line_start {
        return Err(
            "lineEnd: File-anchored comments must end on or after the starting line.".into(),
        );
    }
    if column_start.is_some() ^ column_end.is_some() {
        return Err(
            "columnStart/columnEnd: Column anchors must provide both start and end values.".into(),
        );
    }
    if let Some(column_start) = column_start {
        if column_start < 1 {
            return Err("columnStart: Column anchors must be positive.".into());
        }
    }
    if let Some(column_end) = column_end {
        if column_end < 1 {
            return Err("columnEnd: Column anchors must be positive.".into());
        }
    }
    if line_start == line_end {
        if let (Some(column_start), Some(column_end)) = (column_start, column_end) {
            if column_end < column_start {
                return Err(
                    "columnEnd: Column end must be on or after the starting column.".into(),
                );
            }
        }
    }
    if selected_text.is_some() && (column_start.is_none() || column_end.is_none()) {
        return Err("selectedText: Text selections require both start and end columns.".into());
    }

    let task = get_task(connection, task_id)?;
    let active_assignment = task_runtime::get_current_lane_assignment(connection, task_id)?;
    let task_workspace_cwd = active_assignment
        .as_ref()
        .map(|assignment| {
            task_runtime::resolve_assignment_workspace_cwd(
                connection,
                assignment,
                task_id,
                &task.project_id,
            )
        })
        .transpose()?
        .flatten();
    let file_references = task_file_references::load_task_file_references(
        connection,
        task_id,
        task_workspace_cwd.as_deref(),
    )?;
    let resolved_file = file_references
        .into_iter()
        .find(|reference| {
            reference.repository_id == repository_id && reference.relative_path == relative_path
        })
        .ok_or_else(|| {
            format!(
                "relativePath: No tracked task file reference matched {relative_path} in repository {repository_id}."
            )
        })?;

    let metadata = resolved_file
        .absolute_path
        .as_deref()
        .or(absolute_path.as_deref())
        .map(resolve_comment_anchor_metadata)
        .transpose()?
        .unwrap_or_default();

    Ok((
        Some(CommentAnchorInput {
            repository_id,
            relative_path,
            line_start,
            line_end,
            column_start,
            column_end,
            selected_text,
        }),
        metadata,
    ))
}

fn resolve_comment_anchor_metadata(path: &str) -> Result<CommentAnchorMetadata, String> {
    let Some(file_path) = Path::new(path).parent().map(PathBuf::from) else {
        return Ok(CommentAnchorMetadata::default());
    };

    let repo_root_output = Command::new("git")
        .args([
            "-C",
            file_path.to_string_lossy().as_ref(),
            "rev-parse",
            "--show-toplevel",
        ])
        .output()
        .map_err(|error| format!("Unable to inspect git root for {path}: {error}"))?;
    if !repo_root_output.status.success() {
        return Ok(CommentAnchorMetadata::default());
    }
    let repo_root = String::from_utf8_lossy(&repo_root_output.stdout)
        .trim()
        .to_string();
    if repo_root.is_empty() {
        return Ok(CommentAnchorMetadata::default());
    }

    let repo_root_path = PathBuf::from(&repo_root);
    let file_absolute_path = PathBuf::from(path);
    let relative_file_path = file_absolute_path
        .strip_prefix(&repo_root_path)
        .ok()
        .map(PathBuf::from)
        .unwrap_or_else(|| file_absolute_path.clone());

    let head_output = Command::new("git")
        .args(["-C", &repo_root, "rev-parse", "HEAD"])
        .output()
        .map_err(|error| format!("Unable to read git head for {path}: {error}"))?;
    let commit_hash = if head_output.status.success() {
        let value = String::from_utf8_lossy(&head_output.stdout)
            .trim()
            .to_string();
        if value.is_empty() {
            None
        } else {
            Some(value)
        }
    } else {
        None
    };

    let status_output = Command::new("git")
        .args([
            "-C",
            &repo_root,
            "status",
            "--porcelain",
            "--",
            relative_file_path.to_string_lossy().as_ref(),
        ])
        .output()
        .map_err(|error| format!("Unable to read git status for {path}: {error}"))?;
    let has_uncommitted_changes = if status_output.status.success() {
        Some(
            !String::from_utf8_lossy(&status_output.stdout)
                .trim()
                .is_empty(),
        )
    } else {
        None
    };

    Ok(CommentAnchorMetadata {
        commit_hash,
        has_uncommitted_changes,
    })
}

pub fn list_unread_task_comments(
    connection: &Connection,
    task_id: &str,
    assignment: &TaskLaneAssignment,
) -> Result<Vec<TaskComment>, String> {
    if assignment.task_id != task_id {
        return Err(format!(
            "Assignment {} does not belong to task {}",
            assignment.id, task_id
        ));
    }
    let session_id = assignment
        .session_id
        .as_deref()
        .ok_or_else(|| format!("Task assignment {} has no session id", assignment.id))?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT c.id, c.task_id, c.parent_comment_id, c.author, c.origin_type, c.origin_id, c.message, c.interrupt_agent, c.repository_id, c.relative_path, c.line_start, c.line_end, c.column_start, c.column_end, c.selected_text, c.anchor_commit_hash, c.anchor_has_uncommitted_changes, c.created_at, c.updated_at
            FROM task_comments c
            WHERE c.task_id = ?1
              AND NOT EXISTS (
                  SELECT 1
                  FROM task_comment_receipts r
                  WHERE r.comment_id = c.id AND r.session_id = ?2
              )
            ORDER BY c.created_at ASC, c.id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare unread task comments query: {error}"))?;

    let rows = statement
        .query_map(params![task_id, session_id], |row| {
            Ok(TaskComment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                parent_comment_id: row.get(2)?,
                author: row.get(3)?,
                origin_type: row.get(4)?,
                origin_id: row.get(5)?,
                message: row.get(6)?,
                interrupt_agent: row.get::<_, i64>(7)? != 0,
                repository_id: row.get(8)?,
                relative_path: row.get(9)?,
                line_start: row.get(10)?,
                line_end: row.get(11)?,
                column_start: row.get(12)?,
                column_end: row.get(13)?,
                selected_text: row.get(14)?,
                anchor_commit_hash: row.get(15)?,
                anchor_has_uncommitted_changes: row
                    .get::<_, Option<i64>>(16)?
                    .map(|value| value != 0),
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
            })
        })
        .map_err(|error| format!("Unable to load unread task comments for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect unread task comments for {task_id}: {error}"))
}

pub fn mark_task_comments_read(
    connection: &Connection,
    task_id: &str,
    assignment: &TaskLaneAssignment,
    comment_ids: Option<&[String]>,
) -> Result<Vec<TaskCommentReceipt>, String> {
    if assignment.task_id != task_id {
        return Err(format!(
            "Assignment {} does not belong to task {}",
            assignment.id, task_id
        ));
    }
    let session_id = assignment
        .session_id
        .as_deref()
        .ok_or_else(|| format!("Task assignment {} has no session id", assignment.id))?;

    let comments = load_comments_for_receipt_update(connection, task_id, comment_ids)?;
    if comments.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_iso();
    for comment in &comments {
        connection
            .execute(
                r#"
                INSERT INTO task_comment_receipts (
                    comment_id,
                    task_id,
                    assignment_id,
                    worker_type,
                    worker_id,
                    role_instance_id,
                    session_id,
                    read_at,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8, ?8)
                ON CONFLICT(comment_id, session_id) DO UPDATE SET
                    assignment_id = excluded.assignment_id,
                    worker_type = excluded.worker_type,
                    worker_id = excluded.worker_id,
                    role_instance_id = excluded.role_instance_id,
                    read_at = excluded.read_at,
                    updated_at = excluded.updated_at
                "#,
                params![
                    comment.id.as_str(),
                    task_id,
                    assignment.id.as_str(),
                    assignment.worker_type.as_str(),
                    assignment.worker_id.clone(),
                    assignment.role_instance_id.clone(),
                    session_id,
                    now,
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to record task comment receipt for comment {} on task {}: {error}",
                    comment.id, task_id
                )
            })?;
    }

    load_task_comment_receipts(connection, task_id, session_id, Some(&comments))
}

pub fn count_unread_task_comments_for_user(
    connection: &Connection,
    task_id: &str,
    user_id: &str,
) -> Result<i64, String> {
    connection
        .query_row(
            r#"
            SELECT COUNT(*)
            FROM task_comments c
            WHERE c.task_id = ?1
              AND c.origin_type != 'user'
              AND NOT EXISTS (
                  SELECT 1
                  FROM task_comment_user_receipts r
                  WHERE r.comment_id = c.id AND r.user_id = ?2
              )
            "#,
            params![task_id, user_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            format!("Unable to count unread user task comments for {task_id}: {error}")
        })
}

pub fn mark_task_comments_read_for_user(
    connection: &Connection,
    task_id: &str,
    comment_ids: Option<&[String]>,
) -> Result<i64, String> {
    if !task_exists(connection, task_id)? {
        return Err(format!("Task {task_id} was not found"));
    }

    let comments = load_comments_for_user_receipt_update(connection, task_id, comment_ids)?;
    if comments.is_empty() {
        return Ok(0);
    }

    let now = now_iso();
    for comment in &comments {
        connection
            .execute(
                r#"
                INSERT INTO task_comment_user_receipts (
                    comment_id,
                    task_id,
                    user_id,
                    read_at,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, ?4, ?4)
                ON CONFLICT(comment_id, user_id) DO UPDATE SET
                    read_at = excluded.read_at,
                    updated_at = excluded.updated_at
                "#,
                params![
                    comment.id.as_str(),
                    task_id,
                    DEFAULT_TASK_COMMENT_USER_ID,
                    now
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to record user task comment receipt for comment {} on task {}: {error}",
                    comment.id, task_id
                )
            })?;
    }

    Ok(comments.len() as i64)
}

fn validate_task_comment_parent(
    connection: &Connection,
    task_id: &str,
    parent_comment_id: Option<&str>,
) -> Result<(), String> {
    let Some(parent_comment_id) = parent_comment_id else {
        return Ok(());
    };

    let parent = connection
        .query_row(
            "SELECT task_id, parent_comment_id FROM task_comments WHERE id = ?1",
            [parent_comment_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to load parent comment {parent_comment_id}: {error}"))?
        .ok_or_else(|| format!("parentCommentId: Comment {parent_comment_id} was not found."))?;

    if parent.0 != task_id {
        return Err("parentCommentId: Reply target must belong to the same task.".into());
    }
    if parent.1.is_some() {
        return Err("parentCommentId: Replies can only target top-level comments.".into());
    }

    Ok(())
}

fn validate_task_input(
    connection: &Connection,
    project_id: &str,
    input: &TaskUpsertInput,
    task_id: Option<&str>,
) -> Result<(), String> {
    projects::ensure_project_exists(connection, project_id)?;
    let mut errors = Vec::new();

    if input.title.is_empty() {
        errors.push("title: Task title is required.".to_string());
    }

    errors.extend(validate_task_tags(&input.tags));

    if !VALID_TASK_TYPES.contains(&input.task_type.as_str()) {
        errors.push("type: Task type must be one of: task, bug, feature, chore, epic.".to_string());
    }

    if !VALID_TASK_STATUSES.contains(&input.status.as_str()) {
        errors.push(
            "status: Task status must be one of: draft, ready, in_progress, blocked, in_review, completed, canceled.".to_string(),
        );
    }

    if !VALID_TASK_PRIORITIES.contains(&input.priority.as_str()) {
        errors.push("priority: Task priority must be one of: P0, P1, P2, P3, P4.".to_string());
    }

    if let Some(whip_max_attempts) = input.whip_max_attempts {
        if whip_max_attempts < 1 {
            errors.push("whipMaxAttempts: Task whip max attempts must be at least 1.".to_string());
        }
    }

    if !VALID_ASSIGNEE_TYPES.contains(&input.assignee_type.as_str()) {
        errors.push(
            "assigneeType: Assignee type must be one of: user, agent, role, unassigned."
                .to_string(),
        );
    }

    if matches!(input.assignee_type.as_str(), "user" | "unassigned") && input.assignee_id.is_some()
    {
        errors
            .push("assigneeId: User/unassigned tasks must not specify an assignee id.".to_string());
    }

    if matches!(input.assignee_type.as_str(), "agent" | "role") && input.assignee_id.is_none() {
        errors.push("assigneeId: Agent/role tasks require an assignee id.".to_string());
    }

    if input.current_lane_id.is_some() && input.workflow_id.is_none() {
        errors.push("currentLaneId: A current lane requires a workflow selection.".to_string());
    }

    if let Some(parent_task_id) = input.parent_task_id.as_deref() {
        if Some(parent_task_id) == task_id {
            errors.push("parentTaskId: A task cannot be its own parent.".to_string());
        } else if !task_exists(connection, parent_task_id)? {
            errors.push("parentTaskId: Parent task was not found.".to_string());
        } else {
            let parent_project_id = task_project_id(connection, parent_task_id)?;
            if parent_project_id != project_id {
                errors
                    .push("parentTaskId: Parent task must belong to the same project.".to_string());
            } else if let Some(task_id) = task_id {
                if would_create_parent_cycle(connection, task_id, parent_task_id)? {
                    errors.push("parentTaskId: Parent would create a hierarchy cycle.".to_string());
                }
            }
        }
    }

    if let Some(workflow_id) = input.workflow_id.as_deref() {
        if !workflow_exists(connection, workflow_id)? {
            errors.push("workflowId: Workflow was not found.".to_string());
        } else if let Some(current_lane_id) = input.current_lane_id.as_deref() {
            if !lane_exists_for_workflow(connection, workflow_id, current_lane_id)? {
                errors.push(
                    "currentLaneId: Lane does not belong to the selected workflow.".to_string(),
                );
            }
        }
    }

    for repository_id in &input.repository_ids {
        match projects::ensure_repository_belongs_to_project(connection, project_id, repository_id)
        {
            Ok(_) => {}
            Err(error) => errors.push(format!("repositoryId: {error}")),
        }
    }

    if errors.is_empty() {
        Ok(())
    } else {
        Err(errors.join(" "))
    }
}

fn validate_dependency_edge(
    connection: &Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<(), String> {
    if blocker_task_id == blocked_task_id {
        return Err("A task cannot depend on itself.".to_string());
    }

    if !task_exists(connection, blocker_task_id)? {
        return Err(format!("Blocker task {blocker_task_id} was not found"));
    }

    if !task_exists(connection, blocked_task_id)? {
        return Err(format!("Blocked task {blocked_task_id} was not found"));
    }

    let blocker_project = task_project_id(connection, blocker_task_id)?;
    let blocked_project = task_project_id(connection, blocked_task_id)?;
    if blocker_project != blocked_project {
        return Err("Task dependencies must stay within a single project.".to_string());
    }

    if dependency_exists(connection, blocker_task_id, blocked_task_id)? {
        return Err("That dependency already exists.".to_string());
    }

    if would_create_dependency_cycle(connection, blocker_task_id, blocked_task_id)? {
        return Err("That dependency would create a cycle.".to_string());
    }

    Ok(())
}

fn load_comments_for_receipt_update(
    connection: &Connection,
    task_id: &str,
    comment_ids: Option<&[String]>,
) -> Result<Vec<TaskComment>, String> {
    let comments = load_task_comments(connection, task_id)?;
    let Some(comment_ids) = comment_ids else {
        return Ok(comments);
    };

    let selected_ids = comment_ids
        .iter()
        .map(|value| value.trim())
        .filter(|value| !value.is_empty())
        .map(str::to_string)
        .collect::<HashSet<_>>();
    if selected_ids.is_empty() {
        return Ok(comments);
    }

    let filtered = comments
        .into_iter()
        .filter(|comment| selected_ids.contains(&comment.id))
        .collect::<Vec<_>>();

    if filtered.len() != selected_ids.len() {
        return Err("One or more comment ids were not found on this task.".into());
    }

    Ok(filtered)
}

fn load_comments_for_user_receipt_update(
    connection: &Connection,
    task_id: &str,
    comment_ids: Option<&[String]>,
) -> Result<Vec<TaskComment>, String> {
    let comments = load_comments_for_receipt_update(connection, task_id, comment_ids)?;
    Ok(comments
        .into_iter()
        .filter(|comment| comment.origin_type != "user")
        .collect())
}

fn load_task_comment_receipts(
    connection: &Connection,
    task_id: &str,
    session_id: &str,
    comments: Option<&[TaskComment]>,
) -> Result<Vec<TaskCommentReceipt>, String> {
    let selected_ids = comments.map(|entries| {
        entries
            .iter()
            .map(|comment| comment.id.as_str())
            .collect::<HashSet<_>>()
    });
    let mut statement = connection
        .prepare(
            r#"
            SELECT comment_id, task_id, assignment_id, worker_type, worker_id, role_instance_id, session_id, read_at, created_at, updated_at
            FROM task_comment_receipts
            WHERE task_id = ?1 AND session_id = ?2
            ORDER BY read_at ASC, comment_id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task comment receipts query: {error}"))?;

    let rows = statement
        .query_map(params![task_id, session_id], |row| {
            Ok(TaskCommentReceipt {
                comment_id: row.get(0)?,
                task_id: row.get(1)?,
                assignment_id: row.get(2)?,
                worker_type: row.get(3)?,
                worker_id: row.get(4)?,
                role_instance_id: row.get(5)?,
                session_id: row.get(6)?,
                read_at: row.get(7)?,
                created_at: row.get(8)?,
                updated_at: row.get(9)?,
            })
        })
        .map_err(|error| format!("Unable to read task comment receipts for {task_id}: {error}"))?;

    let receipts = rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        format!("Unable to collect task comment receipts for {task_id}: {error}")
    })?;

    if let Some(selected_ids) = selected_ids {
        Ok(receipts
            .into_iter()
            .filter(|receipt| selected_ids.contains(receipt.comment_id.as_str()))
            .collect())
    } else {
        Ok(receipts)
    }
}

fn load_task_comment(connection: &Connection, comment_id: &str) -> Result<TaskComment, String> {
    connection
        .query_row(
            r#"
            SELECT id, task_id, parent_comment_id, author, origin_type, origin_id, message, interrupt_agent, repository_id, relative_path, line_start, line_end, column_start, column_end, selected_text, anchor_commit_hash, anchor_has_uncommitted_changes, created_at, updated_at
            FROM task_comments
            WHERE id = ?1
            "#,
            [comment_id],
            |row| {
                Ok(TaskComment {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    parent_comment_id: row.get(2)?,
                    author: row.get(3)?,
                    origin_type: row.get(4)?,
                    origin_id: row.get(5)?,
                    message: row.get(6)?,
                    interrupt_agent: row.get::<_, i64>(7)? != 0,
                    repository_id: row.get(8)?,
                    relative_path: row.get(9)?,
                    line_start: row.get(10)?,
                    line_end: row.get(11)?,
                    column_start: row.get(12)?,
                    column_end: row.get(13)?,
                    selected_text: row.get(14)?,
                    anchor_commit_hash: row.get(15)?,
                    anchor_has_uncommitted_changes: row.get::<_, Option<i64>>(16)?.map(|value| value != 0),
                    created_at: row.get(17)?,
                    updated_at: row.get(18)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task comment {comment_id}: {error}"))?
        .ok_or_else(|| format!("Task comment {comment_id} was not found"))
}

fn load_task_comments(connection: &Connection, task_id: &str) -> Result<Vec<TaskComment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, parent_comment_id, author, origin_type, origin_id, message, interrupt_agent, repository_id, relative_path, line_start, line_end, column_start, column_end, selected_text, anchor_commit_hash, anchor_has_uncommitted_changes, created_at, updated_at
            FROM task_comments
            WHERE task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task comments query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok(TaskComment {
                id: row.get(0)?,
                task_id: row.get(1)?,
                parent_comment_id: row.get(2)?,
                author: row.get(3)?,
                origin_type: row.get(4)?,
                origin_id: row.get(5)?,
                message: row.get(6)?,
                interrupt_agent: row.get::<_, i64>(7)? != 0,
                repository_id: row.get(8)?,
                relative_path: row.get(9)?,
                line_start: row.get(10)?,
                line_end: row.get(11)?,
                column_start: row.get(12)?,
                column_end: row.get(13)?,
                selected_text: row.get(14)?,
                anchor_commit_hash: row.get(15)?,
                anchor_has_uncommitted_changes: row
                    .get::<_, Option<i64>>(16)?
                    .map(|value| value != 0),
                created_at: row.get(17)?,
                updated_at: row.get(18)?,
            })
        })
        .map_err(|error| format!("Unable to read task comments for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task comments for {task_id}: {error}"))
}

fn load_task_lane_runs(connection: &Connection, task_id: &str) -> Result<Vec<TaskLaneRun>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, lane_id, session_id, result, notes, started_at, completed_at
            FROM task_lane_runs
            WHERE task_id = ?1
            ORDER BY started_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task lane run query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok(TaskLaneRun {
                id: row.get(0)?,
                task_id: row.get(1)?,
                lane_id: row.get(2)?,
                session_id: row.get(3)?,
                result: row.get(4)?,
                notes: row.get(5)?,
                started_at: row.get(6)?,
                completed_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Unable to read task lane runs for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task lane runs for {task_id}: {error}"))
}

fn load_task_todos(
    connection: &Connection,
    task_id: &str,
    lane_id: Option<&str>,
    completed: Option<bool>,
) -> Result<Vec<TaskTodo>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, task_id, lane_id, description, completed, created_at, updated_at
            FROM task_todos
            WHERE task_id = ?1
              AND (?2 IS NULL OR lane_id = ?2)
              AND (?3 IS NULL OR completed = ?3)
            ORDER BY completed ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task todo query: {error}"))?;

    let completed_filter = completed.map(|value| if value { 1 } else { 0 });
    let rows = statement
        .query_map(params![task_id, lane_id, completed_filter], |row| {
            Ok(TaskTodo {
                id: row.get(0)?,
                task_id: row.get(1)?,
                lane_id: row.get(2)?,
                description: row.get(3)?,
                completed: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Unable to read task todos for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task todos for {task_id}: {error}"))
}

fn get_task_todo(connection: &Connection, todo_id: &str) -> Result<Option<TaskTodo>, String> {
    connection
        .query_row(
            "SELECT id, task_id, lane_id, description, completed, created_at, updated_at FROM task_todos WHERE id = ?1",
            [todo_id],
            |row| {
                Ok(TaskTodo {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    lane_id: row.get(2)?,
                    description: row.get(3)?,
                    completed: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query task todo {todo_id}: {error}"))
}

fn update_task_todo_completion(
    connection: &Connection,
    todo_id: &str,
    completed: bool,
) -> Result<TaskTodo, String> {
    let _existing = get_task_todo(connection, todo_id)?
        .ok_or_else(|| format!("Task todo {todo_id} was not found"))?;
    let now = now_iso();
    connection
        .execute(
            "UPDATE task_todos SET completed = ?2, updated_at = ?3 WHERE id = ?1",
            params![todo_id, if completed { 1 } else { 0 }, now],
        )
        .map_err(|error| format!("Unable to update task todo {todo_id}: {error}"))?;
    get_task_todo(connection, todo_id)?
        .ok_or_else(|| format!("Task todo {todo_id} was not found after update"))
}

fn validate_task_todo_input(
    connection: &Connection,
    task: &TaskDetail,
    lane_id: &str,
    description: &str,
    authorization: Option<&AuthorizationContext>,
) -> Result<(), String> {
    if description.trim().is_empty() {
        return Err("description: Task todo description is required.".into());
    }
    let workflow_id = task
        .workflow_id
        .as_deref()
        .ok_or_else(|| "laneId: Task todos require the task to have a workflow.".to_string())?;
    if !lane_exists_for_workflow(connection, workflow_id, lane_id)? {
        return Err("laneId: Todo lane must belong to the task workflow.".into());
    }
    authorize_task_todo_creation(connection, task, workflow_id, lane_id, authorization)
}

fn authorize_task_todo_creation(
    connection: &Connection,
    task: &TaskDetail,
    workflow_id: &str,
    target_lane_id: &str,
    authorization: Option<&AuthorizationContext>,
) -> Result<(), String> {
    let Some(authorization) = authorization else {
        return Ok(());
    };

    if !matches!(authorization.actor_type.as_str(), "agent" | "role_instance") {
        return Ok(());
    }

    let assignment = task_runtime::get_active_lane_assignment(connection, &task.id)?
        .filter(|assignment| {
            task_runtime::assignment_owned_by_worker_authorization(
                assignment,
                Some(authorization),
            )
        })
        .ok_or_else(|| {
            "taskId: Worker task todo creation requires an active assignment on the target task owned by this worker."
                .to_string()
        })?;

    let workflow = workflows::get_workflow(connection, workflow_id)?;
    let current_lane = workflow
        .lanes
        .iter()
        .find(|lane| lane.id == assignment.lane_id)
        .ok_or_else(|| {
            format!(
                "laneId: Active assignment lane {} is not part of workflow {}.",
                assignment.lane_id, workflow_id
            )
        })?;

    let allowed_lane_ids = permitted_task_todo_lane_ids(current_lane);
    if allowed_lane_ids.contains(target_lane_id) {
        return Ok(());
    }

    Err(format!(
        "laneId: Workers on lane {} can only create todos for {}. Requested lane {} is not permitted.",
        assignment.lane_id,
        allowed_lane_ids.iter().cloned().collect::<Vec<_>>().join(", "),
        target_lane_id,
    ))
}

fn permitted_task_todo_lane_ids(current_lane: &crate::models::WorkflowLane) -> BTreeSet<String> {
    let mut allowed_lane_ids = BTreeSet::from([current_lane.id.clone()]);
    if current_lane.success_transition_type == "lane" {
        if let Some(target_lane_id) = current_lane.success_target_lane_id.as_ref() {
            allowed_lane_ids.insert(target_lane_id.clone());
        }
    }
    if current_lane.failure_transition_type == "lane" {
        if let Some(target_lane_id) = current_lane.failure_target_lane_id.as_ref() {
            allowed_lane_ids.insert(target_lane_id.clone());
        }
    }
    allowed_lane_ids
}

fn load_parent_summary(
    connection: &Connection,
    parent_task_id: Option<&str>,
) -> Result<Option<TaskSummary>, String> {
    match parent_task_id {
        Some(parent_task_id) => load_task_summary(connection, parent_task_id).map(Some),
        None => Ok(None),
    }
}

fn load_lineage(
    connection: &Connection,
    mut parent_task_id: Option<String>,
) -> Result<Vec<TaskSummary>, String> {
    let mut lineage = Vec::new();

    while let Some(current_parent_id) = parent_task_id {
        let parent = load_task_summary(connection, &current_parent_id)?;
        parent_task_id = parent.parent_task_id.clone();
        lineage.push(parent);
    }

    lineage.reverse();
    Ok(lineage)
}

fn load_child_tasks(connection: &Connection, task_id: &str) -> Result<Vec<TaskSummary>, String> {
    let mut statement = connection
        .prepare(&format!(
            r#"
            SELECT
                {summary_columns}
            FROM tasks t
            WHERE t.parent_task_id = ?1
            ORDER BY t.archived ASC, t.sequence_number ASC, t.created_at ASC
            "#,
            summary_columns = task_summary_columns("t"),
        ))
        .map_err(|error| format!("Unable to prepare child task query: {error}"))?;

    let rows = statement
        .query_map([task_id], map_task_summary_row)
        .map_err(|error| format!("Unable to query child tasks for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect child tasks for {task_id}: {error}"))
}

fn load_task_summary(connection: &Connection, task_id: &str) -> Result<TaskSummary, String> {
    connection
        .query_row(
            &format!(
                r#"
                SELECT
                    {summary_columns}
                FROM tasks t
                WHERE t.id = ?1
                "#,
                summary_columns = task_summary_columns("t"),
            ),
            [task_id],
            map_task_summary_row,
        )
        .map_err(|error| format!("Unable to load task summary {task_id}: {error}"))
}

fn load_dependency(connection: &Connection, dependency_id: &str) -> Result<TaskDependency, String> {
    let dependency = connection
        .query_row(
            r#"
            SELECT id, blocker_task_id, blocked_task_id, created_at
            FROM task_dependencies
            WHERE id = ?1
            "#,
            [dependency_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task dependency {dependency_id}: {error}"))?
        .ok_or_else(|| format!("Task dependency {dependency_id} was not found"))?;

    Ok(TaskDependency {
        id: dependency.0,
        blocker: load_task_summary(connection, &dependency.1)?,
        blocked: load_task_summary(connection, &dependency.2)?,
        blocker_task_id: dependency.1,
        blocked_task_id: dependency.2,
        created_at: dependency.3,
    })
}

fn load_blocked_by_dependencies(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskDependency>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, blocker_task_id, blocked_task_id, created_at
            FROM task_dependencies
            WHERE blocked_task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare blocked-by dependency query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| {
            format!("Unable to query blocked-by dependencies for {task_id}: {error}")
        })?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!("Unable to collect blocked-by dependencies for {task_id}: {error}")
        })?
        .into_iter()
        .map(|(id, blocker_task_id, blocked_task_id, created_at)| {
            Ok(TaskDependency {
                id,
                blocker: load_task_summary(connection, &blocker_task_id)?,
                blocked: load_task_summary(connection, &blocked_task_id)?,
                blocker_task_id,
                blocked_task_id,
                created_at,
            })
        })
        .collect()
}

fn load_blocking_dependencies(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskDependency>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, blocker_task_id, blocked_task_id, created_at
            FROM task_dependencies
            WHERE blocker_task_id = ?1
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare blocking dependency query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .map_err(|error| format!("Unable to query blocking dependencies for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect blocking dependencies for {task_id}: {error}"))?
        .into_iter()
        .map(|(id, blocker_task_id, blocked_task_id, created_at)| {
            Ok(TaskDependency {
                id,
                blocker: load_task_summary(connection, &blocker_task_id)?,
                blocked: load_task_summary(connection, &blocked_task_id)?,
                blocker_task_id,
                blocked_task_id,
                created_at,
            })
        })
        .collect()
}

fn next_task_sequence_number(connection: &Connection, project_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COALESCE(MAX(sequence_number), 0) + 1 FROM tasks WHERE project_id = ?1",
            [project_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to calculate next task number for {project_id}: {error}"))
}

fn task_exists(connection: &Connection, task_id: &str) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1 LIMIT 1",
            [task_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up task {task_id}: {error}"))?;
    Ok(exists.is_some())
}

fn task_project_id(connection: &Connection, task_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to read project for task {task_id}: {error}"))
}

fn workflow_exists(connection: &Connection, workflow_id: &str) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM workflows WHERE id = ?1 LIMIT 1",
            [workflow_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up workflow {workflow_id}: {error}"))?;
    Ok(exists.is_some())
}

fn lane_exists_for_workflow(
    connection: &Connection,
    workflow_id: &str,
    lane_id: &str,
) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM workflow_lanes WHERE workflow_id = ?1 AND id = ?2 LIMIT 1",
            params![workflow_id, lane_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to look up workflow lane {lane_id}: {error}"))?;
    Ok(exists.is_some())
}

fn first_lane_id(connection: &Connection, workflow_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT id FROM workflow_lanes WHERE workflow_id = ?1 ORDER BY lane_order ASC LIMIT 1",
            [workflow_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to read first lane for workflow {workflow_id}: {error}"))
}

fn lane_owner_for_workflow(
    connection: &Connection,
    workflow_id: &str,
    lane_id: &str,
) -> Result<Option<(String, Option<String>)>, String> {
    connection
        .query_row(
            "SELECT assigned_entity_type, assigned_entity_id FROM workflow_lanes WHERE workflow_id = ?1 AND id = ?2 LIMIT 1",
            params![workflow_id, lane_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to read workflow lane owner {lane_id}: {error}"))
}

fn dependency_exists(
    connection: &Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<bool, String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM task_dependencies WHERE blocker_task_id = ?1 AND blocked_task_id = ?2 LIMIT 1",
            params![blocker_task_id, blocked_task_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query task dependency edge: {error}"))?;
    Ok(exists.is_some())
}

fn dependency_blocker_lane_snapshot(
    connection: &Connection,
    blocker_task_id: &str,
) -> Result<(Option<String>, Option<String>, Option<i64>), String> {
    connection
        .query_row(
            r#"
            SELECT t.workflow_id, t.current_lane_id, wl.lane_order
            FROM tasks t
            LEFT JOIN workflow_lanes wl
                ON wl.workflow_id = t.workflow_id
               AND wl.id = t.current_lane_id
            WHERE t.id = ?1
            "#,
            [blocker_task_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<i64>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to snapshot blocker lane for task {blocker_task_id}: {error}")
        })?
        .ok_or_else(|| format!("Task {blocker_task_id} was not found"))
}

fn unresolved_blocker_count(connection: &Connection, task_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            &format!(
                r#"
                SELECT {unresolved_blockers}
                FROM tasks t
                WHERE t.id = ?1
                "#,
                unresolved_blockers = unresolved_blocker_sql("t"),
            ),
            [task_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to compute unresolved blockers for {task_id}: {error}"))
}

fn would_create_parent_cycle(
    connection: &Connection,
    task_id: &str,
    proposed_parent_id: &str,
) -> Result<bool, String> {
    let mut current = Some(proposed_parent_id.to_string());

    while let Some(current_id) = current {
        if current_id == task_id {
            return Ok(true);
        }

        current = connection
            .query_row(
                "SELECT parent_task_id FROM tasks WHERE id = ?1",
                [current_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("Unable to traverse task hierarchy: {error}"))?
            .flatten();
    }

    Ok(false)
}

fn would_create_dependency_cycle(
    connection: &Connection,
    blocker_task_id: &str,
    blocked_task_id: &str,
) -> Result<bool, String> {
    let mut stack = vec![blocked_task_id.to_string()];
    let mut visited = std::collections::HashSet::new();

    while let Some(current) = stack.pop() {
        if !visited.insert(current.clone()) {
            continue;
        }

        if current == blocker_task_id {
            return Ok(true);
        }

        let mut statement = connection
            .prepare("SELECT blocked_task_id FROM task_dependencies WHERE blocker_task_id = ?1")
            .map_err(|error| format!("Unable to prepare dependency traversal query: {error}"))?;
        let rows = statement
            .query_map([current], |row| row.get::<_, String>(0))
            .map_err(|error| format!("Unable to traverse task dependency graph: {error}"))?;

        for child in rows {
            stack
                .push(child.map_err(|error| {
                    format!("Unable to read dependency traversal row: {error}")
                })?);
        }
    }

    Ok(false)
}

fn normalize_task_tags(tags: Vec<String>) -> Vec<String> {
    let mut normalized = tags
        .into_iter()
        .map(|tag| tag.trim().to_lowercase())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    normalized.sort();
    normalized.dedup();
    normalized
}

fn validate_task_tags(tags: &[String]) -> Vec<String> {
    let mut errors = Vec::new();

    if tags.len() > MAX_TASK_TAG_COUNT {
        errors.push(format!(
            "tags: Task tags must contain at most {MAX_TASK_TAG_COUNT} unique entries."
        ));
    }

    for (index, tag) in tags.iter().enumerate() {
        if tag.len() > MAX_TASK_TAG_LENGTH {
            errors.push(format!(
                "tags[{index}]: Task tags must be {MAX_TASK_TAG_LENGTH} characters or fewer."
            ));
        }
        if !tag.chars().all(|character| {
            character.is_ascii_lowercase()
                || character.is_ascii_digit()
                || matches!(character, '-' | '_')
        }) {
            errors.push(format!(
                "tags[{index}]: Task tags may only contain lowercase letters, digits, hyphens, and underscores."
            ));
        }
    }

    errors
}

fn parse_task_tags_csv(value: String) -> Vec<String> {
    if value.is_empty() {
        Vec::new()
    } else {
        value
            .split(TASK_TAG_SEPARATOR)
            .filter(|tag| !tag.is_empty())
            .map(str::to_string)
            .collect()
    }
}

fn normalize_input(mut input: TaskUpsertInput) -> TaskUpsertInput {
    input.title = input.title.trim().to_string();
    input.description = normalized_optional_string(input.description);
    input.task_type = input.task_type.trim().to_string();
    input.tags = normalize_task_tags(input.tags);
    input.status = input.status.trim().to_string();
    input.priority = input.priority.trim().to_string();
    input.workflow_id = normalized_optional_string(input.workflow_id);
    input.current_lane_id = normalized_optional_string(input.current_lane_id);
    input.assignee_type = input.assignee_type.trim().to_string();
    input.assignee_id = normalized_optional_string(input.assignee_id);
    input.repository_id = normalized_optional_string(input.repository_id);
    input.repository_ids = input
        .repository_ids
        .into_iter()
        .filter_map(|value| normalized_optional_string(Some(value)))
        .collect();
    if input.repository_ids.is_empty() {
        if let Some(repository_id) = input.repository_id.clone() {
            input.repository_ids.push(repository_id);
        }
    }
    input.repository_ids.sort();
    input.repository_ids.dedup();
    input.repository_id = input.repository_ids.first().cloned();
    input.parent_task_id = normalized_optional_string(input.parent_task_id);
    input
}

fn apply_default_task_repositories(
    connection: &Connection,
    project_id: &str,
    mut input: TaskUpsertInput,
) -> Result<TaskUpsertInput, String> {
    if input.repository_ids.is_empty() {
        let default_repository_id = connection
            .query_row(
                "SELECT default_repository_id FROM projects WHERE id = ?1",
                [project_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!("Unable to resolve default repository for project {project_id}: {error}")
            })?
            .flatten();
        if let Some(default_repository_id) = default_repository_id {
            input.repository_ids.push(default_repository_id.clone());
            input.repository_id = Some(default_repository_id);
        }
    }

    Ok(input)
}

fn apply_default_lane_if_needed(
    connection: &Connection,
    mut input: TaskUpsertInput,
) -> Result<TaskUpsertInput, String> {
    if input.current_lane_id.is_none() {
        if let Some(workflow_id) = input.workflow_id.as_deref() {
            input.current_lane_id = first_lane_id(connection, workflow_id)?;
        }
    }

    if let (Some(workflow_id), Some(current_lane_id)) = (
        input.workflow_id.as_deref(),
        input.current_lane_id.as_deref(),
    ) {
        if let Some((assignee_type, assignee_id)) =
            lane_owner_for_workflow(connection, workflow_id, current_lane_id)?
        {
            input.assignee_type = assignee_type;
            input.assignee_id = assignee_id;
        }
    }
    Ok(input)
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn sync_task_repository_links(
    connection: &rusqlite::Transaction<'_>,
    task_id: &str,
    project_id: &str,
    repository_ids: &[String],
    created_at: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM task_repositories WHERE task_id = ?1",
            [task_id],
        )
        .map_err(|error| format!("Unable to clear task repositories for {task_id}: {error}"))?;

    for repository_id in repository_ids {
        let repository_project_id = connection
            .query_row(
                "SELECT project_id FROM repositories WHERE id = ?1",
                [repository_id],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| {
                format!("Unable to validate task repository {repository_id}: {error}")
            })?;

        if repository_project_id != project_id {
            return Err(format!(
                "Repository {} does not belong to project {}",
                repository_id, project_id
            ));
        }

        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES (?1, ?2, ?3)",
                params![task_id, repository_id, created_at],
            )
            .map_err(|error| format!("Unable to link task repository {repository_id}: {error}"))?;
    }

    Ok(())
}

fn sync_task_tags(
    connection: &rusqlite::Transaction<'_>,
    task_id: &str,
    tags: &[String],
    created_at: &str,
) -> Result<(), String> {
    connection
        .execute("DELETE FROM task_tags WHERE task_id = ?1", [task_id])
        .map_err(|error| format!("Unable to clear task tags for {task_id}: {error}"))?;

    for tag in tags {
        connection
            .execute(
                "INSERT INTO task_tags (task_id, tag, created_at) VALUES (?1, ?2, ?3)",
                params![task_id, tag, created_at],
            )
            .map_err(|error| format!("Unable to store task tag {tag} for {task_id}: {error}"))?;
    }

    Ok(())
}

fn task_summary_columns(alias: &str) -> String {
    format!(
        r#"
        {alias}.id,
        {alias}.project_id,
        {alias}.number,
        {alias}.title,
        {alias}.description,
        {alias}.task_type,
        {tags_csv} AS tags_csv,
        {alias}.status,
        {alias}.priority,
        {alias}.workflow_id,
        {alias}.current_lane_id,
        {alias}.assignee_type,
        {alias}.assignee_id,
        {alias}.parent_task_id,
        {alias}.whip_max_attempts,
        {alias}.archived,
        COALESCE((SELECT COUNT(*) FROM task_comments c WHERE c.task_id = {alias}.id), 0) AS comment_count,
        {unread_user_comments} AS unread_comment_count,
        COALESCE((SELECT COUNT(*) FROM task_lane_runs lr WHERE lr.task_id = {alias}.id), 0) AS lane_run_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id), 0) AS child_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.status = 'completed'), 0) AS completed_child_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.status = 'in_progress'), 0) AS in_progress_child_count,
        COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.archived = 0 AND child.status NOT IN ('completed', 'canceled')), 0) AS blocked_child_count,
        COALESCE((SELECT COUNT(*) FROM task_dependencies d WHERE d.blocked_task_id = {alias}.id), 0) AS blocked_by_count,
        COALESCE((SELECT COUNT(*) FROM task_dependencies d WHERE d.blocker_task_id = {alias}.id), 0) AS blocking_count,
        COALESCE((SELECT COUNT(*) FROM task_attachments a WHERE a.task_id = {alias}.id), 0) AS attachment_count,
        CASE WHEN {unresolved_blockers} > 0 OR {unfinished_child_blockers} > 0 THEN 1 ELSE 0 END AS dependency_blocked,
        {current_lane_assignment_status} AS active_lane_assignment_status,
        CASE WHEN {alias}.archived = 0 AND {alias}.workflow_id IS NOT NULL AND {alias}.current_lane_id IS NOT NULL AND {alias}.status IN ('ready', 'in_progress') AND {unresolved_blockers} = 0 AND {unfinished_child_blockers} = 0 AND NOT EXISTS (SELECT 1 FROM task_lane_assignments tla WHERE tla.task_id = {alias}.id AND tla.status IN ('queued', 'active')) THEN 1 ELSE 0 END AS ready_for_dispatch,
        {alias}.created_at,
        {alias}.updated_at
        "#,
        unresolved_blockers = unresolved_blocker_sql(alias),
        unfinished_child_blockers = unfinished_child_blocker_sql(alias),
        unread_user_comments = unread_user_comment_count_sql(alias),
        current_lane_assignment_status = current_lane_assignment_status_sql(alias),
        tags_csv = task_tags_csv_sql(alias),
    )
}

fn current_lane_assignment_status_sql(alias: &str) -> String {
    format!(
        "(SELECT tla.status FROM task_lane_assignments tla WHERE tla.task_id = {alias}.id AND tla.status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user') AND {alias}.status NOT IN ('completed', 'canceled') AND ({alias}.current_lane_id IS NULL OR tla.lane_id = {alias}.current_lane_id) ORDER BY CASE tla.status WHEN 'active' THEN 0 WHEN 'awaiting_user_approval' THEN 1 WHEN 'awaiting_user_intervention' THEN 2 WHEN 'paused_by_user' THEN 3 ELSE 4 END, tla.created_at ASC, tla.id ASC LIMIT 1)"
    )
}

fn task_tags_csv_sql(alias: &str) -> String {
    format!(
        "COALESCE((SELECT GROUP_CONCAT(tag, '{separator}') FROM (SELECT tt.tag AS tag FROM task_tags tt WHERE tt.task_id = {alias}.id ORDER BY tt.tag ASC)), '')",
        separator = TASK_TAG_SEPARATOR,
    )
}

fn task_priority_sort_sql(alias: &str) -> String {
    format!(
        "CASE {alias}.priority WHEN 'P0' THEN 0 WHEN 'P1' THEN 1 WHEN 'P2' THEN 2 WHEN 'P3' THEN 3 WHEN 'P4' THEN 4 ELSE 5 END"
    )
}

fn default_task_list_tiebreak(sort_by: TaskSortField) -> &'static str {
    match sort_by {
        TaskSortField::UpdatedAt => "t.sequence_number DESC",
        _ => "t.updated_at DESC, t.sequence_number DESC",
    }
}

fn task_list_order_clause(query: &TaskListQuery) -> String {
    let direction = query.sort_direction.sql_keyword();
    let primary = match query.sort_by {
        TaskSortField::UpdatedAt => format!("t.updated_at {direction}"),
        TaskSortField::CreatedAt => format!("t.created_at {direction}"),
        TaskSortField::Priority => format!("{} {direction}", task_priority_sort_sql("t")),
        TaskSortField::Number => format!("t.sequence_number {direction}"),
        TaskSortField::Title => format!("t.title COLLATE NOCASE {direction}"),
        TaskSortField::Tags => format!(
            "CASE WHEN COALESCE(tr.tag_count, 0) = 0 THEN 1 ELSE 0 END ASC, COALESCE(tr.tag_sort_key, '') {direction}"
        ),
    };
    format!(
        "t.archived ASC, {primary}, {}",
        default_task_list_tiebreak(query.sort_by)
    )
}

fn unread_user_comment_count_sql(alias: &str) -> String {
    format!(
        "COALESCE((SELECT COUNT(*) FROM task_comments c WHERE c.task_id = {alias}.id AND c.origin_type != 'user' AND NOT EXISTS (SELECT 1 FROM task_comment_user_receipts r WHERE r.comment_id = c.id AND r.user_id = '{user_id}')), 0)",
        user_id = DEFAULT_TASK_COMMENT_USER_ID,
    )
}

fn unresolved_blocker_sql(alias: &str) -> String {
    format!(
        r#"COALESCE((
            SELECT COUNT(*)
            FROM task_dependencies d
            JOIN tasks blocker ON blocker.id = d.blocker_task_id
            LEFT JOIN workflow_lanes blocker_current_lane
                ON blocker_current_lane.workflow_id = blocker.workflow_id
               AND blocker_current_lane.id = blocker.current_lane_id
            WHERE d.blocked_task_id = {alias}.id
              AND blocker.status NOT IN ('completed', 'canceled')
              AND (
                    d.blocker_workflow_id IS NULL
                 OR d.blocker_lane_id IS NULL
                 OR d.blocker_lane_order IS NULL
                 OR blocker.workflow_id IS NULL
                 OR blocker.current_lane_id IS NULL
                 OR blocker.workflow_id != d.blocker_workflow_id
                 OR blocker_current_lane.lane_order IS NULL
                 OR blocker_current_lane.lane_order <= d.blocker_lane_order
              )
        ), 0)"#
    )
}

fn unfinished_child_blocker_sql(alias: &str) -> String {
    format!(
        "COALESCE((SELECT COUNT(*) FROM tasks child WHERE child.parent_task_id = {alias}.id AND child.archived = 0 AND child.status NOT IN ('completed', 'canceled')), 0)"
    )
}

fn map_task_summary_row(row: &Row<'_>) -> rusqlite::Result<TaskSummary> {
    Ok(TaskSummary {
        id: row.get(0)?,
        project_id: row.get(1)?,
        number: row.get(2)?,
        title: row.get(3)?,
        description: row.get(4)?,
        task_type: row.get(5)?,
        tags: parse_task_tags_csv(row.get::<_, String>(6)?),
        status: row.get(7)?,
        priority: row.get(8)?,
        workflow_id: row.get(9)?,
        current_lane_id: row.get(10)?,
        assignee_type: row.get(11)?,
        assignee_id: row.get(12)?,
        parent_task_id: row.get(13)?,
        whip_max_attempts: row.get(14)?,
        archived: row.get::<_, i64>(15)? != 0,
        comment_count: row.get(16)?,
        unread_comment_count: row.get(17)?,
        lane_run_count: row.get(18)?,
        child_count: row.get(19)?,
        completed_child_count: row.get(20)?,
        in_progress_child_count: row.get(21)?,
        blocked_child_count: row.get(22)?,
        blocked_by_count: row.get(23)?,
        blocking_count: row.get(24)?,
        attachment_count: row.get(25)?,
        dependency_blocked: row.get::<_, i64>(26)? != 0,
        active_lane_assignment_status: row.get(27)?,
        ready_for_dispatch: row.get::<_, i64>(28)? != 0,
        created_at: row.get(29)?,
        updated_at: row.get(30)?,
    })
}

fn task_id() -> String {
    format!("task-{}", Uuid::new_v4().simple())
}

fn task_todo_id() -> String {
    format!("task-todo-{}", Uuid::new_v4().simple())
}

fn dependency_id() -> String {
    format!("task-dependency-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;
    use std::{
        path::{Path, PathBuf},
        sync::{Arc, Barrier, Condvar, Mutex},
        thread,
        time::Duration,
    };

    #[derive(Default)]
    struct PostAllocationHookState {
        generation: usize,
        waiters: usize,
    }

    struct PostAllocationHookGuard;

    impl Drop for PostAllocationHookGuard {
        fn drop(&mut self) {
            set_post_task_number_allocation_hook(None);
        }
    }

    fn install_post_task_number_allocation_hook(
        hook: PostTaskNumberAllocationHook,
    ) -> PostAllocationHookGuard {
        set_post_task_number_allocation_hook(Some(hook));
        PostAllocationHookGuard
    }

    fn unique_temp_database_path(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!("{label}-{}.db", Uuid::new_v4().simple()))
    }

    fn open_file_backed_connection(path: &Path) -> Connection {
        let connection = Connection::open(path).expect("database should open");
        connection
            .busy_timeout(Duration::from_secs(5))
            .expect("busy timeout should configure");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys should enable");
        connection
            .pragma_update(None, "journal_mode", "WAL")
            .expect("wal mode should enable");
        connection
    }

    fn file_backed_connection_with_project_and_workflow(label: &str) -> PathBuf {
        let path = unique_temp_database_path(label);
        let connection = open_file_backed_connection(&path);
        database::apply_migrations(&connection).expect("apply migrations");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?5)",
                params![DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID, "Orchestra", "ORC", now_iso()],
            )
            .expect("default project should insert");
        seed_workflow(&connection);
        path
    }

    fn basic_task_input(title: &str) -> TaskUpsertInput {
        TaskUpsertInput {
            title: title.into(),
            description: None,
            task_type: "task".into(),
            tags: Vec::new(),
            status: "ready".into(),
            priority: "P2".into(),
            workflow_id: Some("workflow-dev".into()),
            current_lane_id: Some("lane-plan".into()),
            assignee_type: "user".into(),
            assignee_id: None,
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: None,
            archived: None,
        }
    }

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?5)",
                params![DEFAULT_PROJECT_ID, DEFAULT_PROJECT_ID, "Orchestra", "ORC", now_iso()],
            )
            .expect("default project should insert");
        connection
    }

    fn seed_workflow(connection: &Connection) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
                params!["workflow-dev", "development", "Development", now],
            )
            .expect("insert workflow");
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, success_transition_type, failure_transition_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 'user', 'end', 'end', ?5, ?5)",
                params!["lane-plan", "workflow-dev", "plan", "Plan", now],
            )
            .expect("insert lane");
    }

    fn seed_multi_lane_workflow(connection: &Connection) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 0, ?4, ?4)",
                params!["workflow-dev", "development", "Development", now],
            )
            .expect("insert workflow");
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, success_transition_type, success_target_lane_id, failure_transition_type, failure_target_lane_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, 0, 'user', 'lane', 'lane-review', 'lane', 'lane-rework', ?5, ?5)",
                params!["lane-plan", "workflow-dev", "plan", "Plan", now],
            )
            .expect("insert plan lane");
        for (lane_id, lane_key, lane_name, lane_order) in [
            ("lane-review", "review", "Review", 1),
            ("lane-rework", "rework", "Rework", 2),
            ("lane-done", "done", "Done", 3),
        ] {
            connection
                .execute(
                    "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, lane_order, assigned_entity_type, success_transition_type, failure_transition_type, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, 'user', 'end', 'end', ?6, ?6)",
                    params![lane_id, "workflow-dev", lane_key, lane_name, lane_order, now],
                )
                .expect("insert non-plan lane");
        }
    }

    fn insert_agent_assignment(
        connection: &Connection,
        task_id: &str,
        worker_id: &str,
        lane_id: &str,
    ) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, 'workflow-dev', ?3, 'agent', ?4, 'active', 'session-task-todo', '/tmp/task-todo', NULL, NULL, 'Prompt', 0, NULL, ?5, NULL, ?5, ?5)",
                params![format!("assignment-{lane_id}"), task_id, lane_id, worker_id, now],
            )
            .expect("insert assignment");
    }

    fn create_named_task(
        connection: &mut Connection,
        title: &str,
        status: &str,
        parent_task_id: Option<String>,
    ) -> TaskDetail {
        create_task(
            connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: title.into(),
                description: None,
                task_type: if parent_task_id.is_none() {
                    "epic"
                } else {
                    "task"
                }
                .into(),
                tags: Vec::new(),
                status: status.into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("create named task")
    }

    fn move_task_to_lane(
        connection: &mut Connection,
        task: &TaskDetail,
        status: &str,
        lane_id: &str,
    ) -> TaskDetail {
        update_task(
            connection,
            &task.id,
            TaskUpsertInput {
                title: task.title.clone(),
                description: task.description.clone(),
                task_type: task.task_type.clone(),
                tags: task.tags.clone(),
                status: status.into(),
                priority: task.priority.clone(),
                workflow_id: task.workflow_id.clone(),
                current_lane_id: Some(lane_id.into()),
                assignee_type: task.assignee_type.clone(),
                assignee_id: task.assignee_id.clone(),
                repository_id: task.repository_id.clone(),
                repository_ids: task.repository_ids.clone(),
                parent_task_id: task.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(task.archived),
            },
        )
        .expect("move task to lane")
    }

    fn load_persisted_task_tags(connection: &Connection, task_id: &str) -> Vec<String> {
        connection
            .prepare("SELECT tag FROM task_tags WHERE task_id = ?1 ORDER BY tag ASC")
            .expect("task tag query should prepare")
            .query_map([task_id], |row| row.get::<_, String>(0))
            .expect("task tag query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("task tag rows should collect")
    }

    fn create_task_with_tags(
        connection: &mut Connection,
        title: &str,
        tags: Vec<&str>,
    ) -> TaskDetail {
        create_task(
            connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: title.into(),
                description: None,
                task_type: "task".into(),
                tags: tags.into_iter().map(str::to_string).collect(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create")
    }

    fn list_task_titles_with_query(connection: &Connection, query: TaskListQuery) -> Vec<String> {
        list_tasks_with_query(connection, DEFAULT_PROJECT_ID, query)
            .expect("tasks should list")
            .into_iter()
            .map(|task| task.title)
            .collect()
    }

    #[test]
    fn create_and_load_task_round_trip() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let epic = create_named_task(&mut connection, "Task system", "ready", None);
        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Map task foundation".into(),
                description: Some("Persist task records".into()),
                task_type: "feature".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "role".into(),
                assignee_id: Some("developer".into()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: Some(epic.id.clone()),
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("create task");

        assert_eq!(created.number, "ORC-2");
        assert_eq!(created.parent_task_id.as_deref(), Some(epic.id.as_str()));
        assert_eq!(created.whip_max_attempts, 10);

        let loaded_epic = get_task(&connection, &epic.id).expect("load epic");
        assert_eq!(loaded_epic.child_count, 1);
        assert_eq!(loaded_epic.in_progress_child_count, 1);
        assert_eq!(loaded_epic.children.len(), 1);
        assert_eq!(loaded_epic.children[0].id, created.id);

        let loaded_child = get_task(&connection, &created.id).expect("load child");
        assert_eq!(loaded_child.lineage.len(), 1);
        assert_eq!(loaded_child.lineage[0].id, epic.id);
        assert_eq!(
            loaded_child.parent.as_ref().map(|task| task.id.as_str()),
            Some(epic.id.as_str())
        );
    }

    #[test]
    fn concurrent_task_creation_allocates_distinct_numbers() {
        let database_path =
            file_backed_connection_with_project_and_workflow("concurrent-task-number-allocation");
        let start_barrier = Arc::new(Barrier::new(3));
        let hook_state = Arc::new((
            Mutex::new(PostAllocationHookState::default()),
            Condvar::new(),
        ));
        let _hook_guard = install_post_task_number_allocation_hook({
            let hook_state = Arc::clone(&hook_state);
            Arc::new(move |title: &str| {
                if !title.starts_with("Concurrent allocator ") {
                    return;
                }

                let (lock, condvar) = &*hook_state;
                let mut state = lock.lock().expect("hook state should lock");
                state.waiters += 1;

                if state.waiters == 1 {
                    let observed_generation = state.generation;
                    let (guard, _) = condvar
                        .wait_timeout_while(state, Duration::from_millis(150), |state| {
                            state.generation == observed_generation
                        })
                        .expect("hook wait should succeed");
                    state = guard;
                } else {
                    state.generation += 1;
                    condvar.notify_all();
                }

                state.waiters -= 1;
            })
        });

        let first_handle = {
            let database_path = database_path.clone();
            let start_barrier = Arc::clone(&start_barrier);
            thread::spawn(move || {
                let mut connection = open_file_backed_connection(&database_path);
                start_barrier.wait();
                create_task(
                    &mut connection,
                    Some(DEFAULT_PROJECT_ID),
                    basic_task_input("Concurrent allocator A"),
                )
                .map(|task| task.number)
            })
        };
        let second_handle = {
            let database_path = database_path.clone();
            let start_barrier = Arc::clone(&start_barrier);
            thread::spawn(move || {
                let mut connection = open_file_backed_connection(&database_path);
                start_barrier.wait();
                create_task(
                    &mut connection,
                    Some(DEFAULT_PROJECT_ID),
                    basic_task_input("Concurrent allocator B"),
                )
                .map(|task| task.number)
            })
        };

        start_barrier.wait();

        let first_number = first_handle
            .join()
            .expect("first create thread should join")
            .expect("first create should succeed");
        let second_number = second_handle
            .join()
            .expect("second create thread should join")
            .expect("second create should succeed");

        let mut numbers = vec![first_number, second_number];
        numbers.sort();
        assert_eq!(numbers, vec!["ORC-1".to_string(), "ORC-2".to_string()]);

        let verification_connection = open_file_backed_connection(&database_path);
        let persisted_numbers = verification_connection
            .prepare("SELECT number FROM tasks ORDER BY sequence_number ASC")
            .expect("task number query should prepare")
            .query_map([], |row| row.get::<_, String>(0))
            .expect("task number query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("task numbers should collect");
        assert_eq!(persisted_numbers, vec!["ORC-1", "ORC-2"]);
    }

    #[test]
    fn normalizes_persists_and_lists_task_tags() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Tagged task".into(),
                description: None,
                task_type: "task".into(),
                tags: vec![
                    "Urgent".into(),
                    " backend ".into(),
                    "".into(),
                    "urgent".into(),
                    "ops_1".into(),
                ],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        assert_eq!(created.tags, vec!["backend", "ops_1", "urgent"]);
        assert_eq!(
            load_persisted_task_tags(&connection, &created.id),
            created.tags
        );

        let listed = list_tasks(&connection, DEFAULT_PROJECT_ID, false).expect("tasks should list");
        let listed_task = listed
            .iter()
            .find(|task| task.id == created.id)
            .expect("tagged task should be listed");
        assert_eq!(listed_task.tags, vec!["backend", "ops_1", "urgent"]);

        let loaded = get_task(&connection, &created.id).expect("task should load");
        assert_eq!(loaded.tags, vec!["backend", "ops_1", "urgent"]);

        let context = get_task_context(&connection, &created.id).expect("task context should load");
        assert_eq!(context.tags, vec!["backend", "ops_1", "urgent"]);
    }

    #[test]
    fn list_task_filters_and_sorts_do_not_duplicate_multi_tag_tasks() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let shared = create_task_with_tags(
            &mut connection,
            "Backend urgent ops",
            vec!["backend", "urgent", "ops"],
        );
        let backend = create_task_with_tags(&mut connection, "Backend only", vec!["backend"]);
        let urgent = create_task_with_tags(&mut connection, "Urgent only", vec!["urgent"]);
        create_task_with_tags(&mut connection, "Untagged", vec![]);

        let query = TaskListQuery::from_raw(
            Some(false),
            Some(vec!["backend".into(), "urgent".into()]),
            Some("any"),
            Some("title"),
            Some("asc"),
        )
        .expect("query should parse");
        let listed = list_tasks_with_query(&connection, DEFAULT_PROJECT_ID, query)
            .expect("tasks should list");
        let listed_ids = listed
            .iter()
            .map(|task| task.id.as_str())
            .collect::<Vec<_>>();
        let listed_titles = listed
            .iter()
            .map(|task| task.title.as_str())
            .collect::<Vec<_>>();

        assert_eq!(
            listed_titles,
            vec!["Backend only", "Backend urgent ops", "Urgent only"]
        );
        assert!(listed_ids.contains(&backend.id.as_str()));
        assert!(listed_ids.contains(&shared.id.as_str()));
        assert!(listed_ids.contains(&urgent.id.as_str()));
        assert_eq!(listed_ids.len(), 3);
        assert_eq!(
            listed_ids
                .iter()
                .copied()
                .collect::<std::collections::HashSet<_>>()
                .len(),
            listed_ids.len()
        );
    }

    #[test]
    fn list_task_filters_support_all_and_any_tag_matching() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        create_task_with_tags(&mut connection, "Backend urgent", vec!["backend", "urgent"]);
        create_task_with_tags(&mut connection, "Backend only", vec!["backend"]);
        create_task_with_tags(&mut connection, "Ops urgent", vec!["ops", "urgent"]);
        create_task_with_tags(&mut connection, "Untagged", vec![]);

        let all_query = TaskListQuery::from_raw(
            Some(false),
            Some(vec![" backend ".into(), "URGENT".into(), "urgent".into()]),
            Some("all"),
            Some("title"),
            Some("asc"),
        )
        .expect("all query should parse");
        assert_eq!(
            list_task_titles_with_query(&connection, all_query),
            vec!["Backend urgent"]
        );

        let any_query = TaskListQuery::from_raw(
            Some(false),
            Some(vec!["urgent".into(), "ops".into()]),
            Some("any"),
            Some("title"),
            Some("asc"),
        )
        .expect("any query should parse");
        assert_eq!(
            list_task_titles_with_query(&connection, any_query),
            vec!["Backend urgent", "Ops urgent"]
        );
    }

    #[test]
    fn list_task_filter_rejects_invalid_tags() {
        let error = TaskListQuery::from_raw(
            Some(false),
            Some(vec!["valid".into(), "not ok".into()]),
            Some("all"),
            Some("updatedAt"),
            Some("desc"),
        )
        .expect_err("invalid filter tags should be rejected");

        assert!(error.contains(
            "Task tags may only contain lowercase letters, digits, hyphens, and underscores."
        ));
    }

    #[test]
    fn list_task_sorts_by_canonical_tag_string_and_keeps_untagged_last() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        create_task_with_tags(&mut connection, "backend", vec!["backend"]);
        create_task_with_tags(&mut connection, "api+backend", vec!["backend", "api"]);
        create_task_with_tags(&mut connection, "api", vec!["api"]);
        create_task_with_tags(&mut connection, "untagged", vec![]);

        let ascending =
            TaskListQuery::from_raw(Some(false), None, Some("all"), Some("tags"), Some("asc"))
                .expect("ascending query should parse");
        assert_eq!(
            list_task_titles_with_query(&connection, ascending),
            vec!["api", "api+backend", "backend", "untagged"]
        );

        let descending =
            TaskListQuery::from_raw(Some(false), None, Some("all"), Some("tags"), Some("desc"))
                .expect("descending query should parse");
        assert_eq!(
            list_task_titles_with_query(&connection, descending),
            vec!["backend", "api+backend", "api", "untagged"]
        );
    }

    #[test]
    fn list_task_filters_respect_include_archived_with_tags() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        create_task_with_tags(&mut connection, "Live backend", vec!["backend"]);
        create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Archived backend".into(),
                description: None,
                task_type: "task".into(),
                tags: vec!["backend".into()],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(true),
            },
        )
        .expect("archived task should create");

        let hidden = TaskListQuery::from_raw(
            Some(false),
            Some(vec!["backend".into()]),
            Some("all"),
            Some("title"),
            Some("asc"),
        )
        .expect("hidden query should parse");
        assert_eq!(
            list_task_titles_with_query(&connection, hidden),
            vec!["Live backend"]
        );

        let visible = TaskListQuery::from_raw(
            Some(true),
            Some(vec!["backend".into()]),
            Some("all"),
            Some("title"),
            Some("asc"),
        )
        .expect("visible query should parse");
        assert_eq!(
            list_task_titles_with_query(&connection, visible),
            vec!["Live backend", "Archived backend"]
        );
    }

    #[test]
    fn empty_task_tags_round_trip_as_empty_array() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Untagged task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        assert!(created.tags.is_empty());
        assert!(load_persisted_task_tags(&connection, &created.id).is_empty());
        assert!(get_task(&connection, &created.id)
            .expect("task should load")
            .tags
            .is_empty());
    }

    #[test]
    fn rejects_invalid_task_tags() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let error = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Invalid tags".into(),
                description: None,
                task_type: "task".into(),
                tags: vec!["valid".into(), "not ok".into(), "x".repeat(33)],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect_err("invalid tags should be rejected");

        assert!(error.contains(
            "Task tags may only contain lowercase letters, digits, hyphens, and underscores."
        ));
        assert!(error.contains("Task tags must be 32 characters or fewer."));
    }

    #[test]
    fn rejects_more_than_twenty_unique_task_tags() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let error = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Too many tags".into(),
                description: None,
                task_type: "task".into(),
                tags: (1..=21).map(|index| format!("tag-{index}")).collect(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect_err("tag count overflow should be rejected");

        assert!(error.contains("tags: Task tags must contain at most 20 unique entries."));
    }

    #[test]
    fn updates_task_whip_max_attempts() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Whip settings task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: Some(3),
                archived: None,
            },
        )
        .expect("task should create");
        assert_eq!(created.whip_max_attempts, 3);

        let updated = update_task(
            &mut connection,
            &created.id,
            TaskUpsertInput {
                title: created.title.clone(),
                description: created.description.clone(),
                task_type: created.task_type.clone(),
                tags: Vec::new(),
                status: created.status.clone(),
                priority: created.priority.clone(),
                workflow_id: created.workflow_id.clone(),
                current_lane_id: created.current_lane_id.clone(),
                assignee_type: created.assignee_type.clone(),
                assignee_id: created.assignee_id.clone(),
                repository_id: created.repository_id.clone(),
                repository_ids: created.repository_ids.clone(),
                parent_task_id: created.parent_task_id.clone(),
                whip_max_attempts: Some(5),
                archived: Some(created.archived),
            },
        )
        .expect("task should update");
        assert_eq!(updated.whip_max_attempts, 5);
    }

    #[test]
    fn update_task_replaces_and_clears_tags() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Mutable tags".into(),
                description: None,
                task_type: "task".into(),
                tags: vec!["alpha".into(), "beta".into()],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        assert_eq!(
            load_persisted_task_tags(&connection, &created.id),
            vec!["alpha", "beta"]
        );

        let updated = update_task(
            &mut connection,
            &created.id,
            TaskUpsertInput {
                title: created.title.clone(),
                description: created.description.clone(),
                task_type: created.task_type.clone(),
                tags: vec!["gamma".into(), " beta ".into(), "GAMMA".into()],
                status: created.status.clone(),
                priority: created.priority.clone(),
                workflow_id: created.workflow_id.clone(),
                current_lane_id: created.current_lane_id.clone(),
                assignee_type: created.assignee_type.clone(),
                assignee_id: created.assignee_id.clone(),
                repository_id: created.repository_id.clone(),
                repository_ids: created.repository_ids.clone(),
                parent_task_id: created.parent_task_id.clone(),
                whip_max_attempts: Some(created.whip_max_attempts),
                archived: Some(created.archived),
            },
        )
        .expect("task should update");

        assert_eq!(updated.tags, vec!["beta", "gamma"]);
        assert_eq!(
            load_persisted_task_tags(&connection, &created.id),
            vec!["beta", "gamma"]
        );

        let cleared = update_task(
            &mut connection,
            &created.id,
            TaskUpsertInput {
                title: updated.title.clone(),
                description: updated.description.clone(),
                task_type: updated.task_type.clone(),
                tags: Vec::new(),
                status: updated.status.clone(),
                priority: updated.priority.clone(),
                workflow_id: updated.workflow_id.clone(),
                current_lane_id: updated.current_lane_id.clone(),
                assignee_type: updated.assignee_type.clone(),
                assignee_id: updated.assignee_id.clone(),
                repository_id: updated.repository_id.clone(),
                repository_ids: updated.repository_ids.clone(),
                parent_task_id: updated.parent_task_id.clone(),
                whip_max_attempts: Some(updated.whip_max_attempts),
                archived: Some(updated.archived),
            },
        )
        .expect("task tags should clear");

        assert!(cleared.tags.is_empty());
        assert!(load_persisted_task_tags(&connection, &created.id).is_empty());
    }

    #[test]
    fn invalid_tag_updates_do_not_partially_write() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Stable tags".into(),
                description: None,
                task_type: "task".into(),
                tags: vec!["backend".into(), "urgent".into()],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let error = update_task(
            &mut connection,
            &created.id,
            TaskUpsertInput {
                title: created.title.clone(),
                description: created.description.clone(),
                task_type: created.task_type.clone(),
                tags: vec!["ops".into(), "bad tag".into()],
                status: created.status.clone(),
                priority: created.priority.clone(),
                workflow_id: created.workflow_id.clone(),
                current_lane_id: created.current_lane_id.clone(),
                assignee_type: created.assignee_type.clone(),
                assignee_id: created.assignee_id.clone(),
                repository_id: created.repository_id.clone(),
                repository_ids: created.repository_ids.clone(),
                parent_task_id: created.parent_task_id.clone(),
                whip_max_attempts: Some(created.whip_max_attempts),
                archived: Some(created.archived),
            },
        )
        .expect_err("invalid update should fail");

        assert!(error.contains(
            "Task tags may only contain lowercase letters, digits, hyphens, and underscores."
        ));
        assert_eq!(
            load_persisted_task_tags(&connection, &created.id),
            vec!["backend", "urgent"]
        );
        assert_eq!(
            get_task_context(&connection, &created.id)
                .expect("task context should load")
                .tags,
            vec!["backend", "urgent"]
        );
    }

    #[test]
    fn deleting_task_cascades_task_tags() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let created = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Tagged delete".into(),
                description: None,
                task_type: "task".into(),
                tags: vec!["cleanup".into(), "ops".into()],
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");
        assert_eq!(
            load_persisted_task_tags(&connection, &created.id),
            vec!["cleanup", "ops"]
        );

        let _deleted = delete_task(&mut connection, &created.id).expect("task should delete");
        assert!(load_persisted_task_tags(&connection, &created.id).is_empty());
    }

    #[test]
    fn lists_tasks_scoped_to_project() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);
        let now = now_iso();
        connection.execute(
            "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-a', 'project-a', 'Project A', NULL, 'PA', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project A should insert");
        connection.execute(
            "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-b', 'project-b', 'Project B', NULL, 'PB', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project B should insert");

        let task_a = create_task(
            &mut connection,
            Some("project-a"),
            TaskUpsertInput {
                title: "Task A".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task A should create");
        let task_b = create_task(
            &mut connection,
            Some("project-b"),
            TaskUpsertInput {
                title: "Task B".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task B should create");

        let project_a = list_tasks(&connection, "project-a", false).expect("project A tasks");
        let project_b = list_tasks(&connection, "project-b", false).expect("project B tasks");
        assert_eq!(project_a.len(), 1);
        assert_eq!(project_b.len(), 1);
        assert_eq!(project_a[0].id, task_a.id);
        assert_eq!(project_b[0].id, task_b.id);
        assert_eq!(task_a.number, "PA-1");
        assert_eq!(task_b.number, "PB-1");
    }

    #[test]
    fn list_tasks_keeps_lifecycle_status_and_exposes_assignment_status_separately() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);
        let now = now_iso();

        let task = create_named_task(
            &mut connection,
            "Queued implementation",
            "in_progress",
            None,
        );
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, 'workflow-dev', 'lane-plan', 'role', 'developer', 'queued', NULL, NULL, NULL, NULL, 'Implement it', 0, NULL, ?3, NULL, ?3, ?3)",
                params!["assignment-queued-summary", task.id.as_str(), now.as_str()],
            )
            .expect("queued assignment should insert");

        let listed = list_tasks(&connection, DEFAULT_PROJECT_ID, false).expect("tasks should list");
        let summary = listed
            .iter()
            .find(|candidate| candidate.id == task.id)
            .expect("task summary should be present");

        assert_eq!(summary.status, "in_progress");
        assert_eq!(
            summary.active_lane_assignment_status.as_deref(),
            Some("queued")
        );
        assert!(!summary.ready_for_dispatch);
    }

    #[test]
    fn changing_project_task_prefix_only_affects_future_tasks() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);
        let project = crate::services::projects::create_project(
            &connection,
            crate::models::ProjectUpsertInput {
                name: "Prefix Change Project".into(),
                description: None,
                task_prefix: "APP".into(),
            },
        )
        .expect("project should create");

        let first = create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "First task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("first task should create");

        crate::services::projects::update_project(
            &connection,
            &project.id,
            crate::models::ProjectUpsertInput {
                name: project.name.clone(),
                description: project.description.clone(),
                task_prefix: "WEB2".into(),
            },
        )
        .expect("project should update");

        let second = create_task(
            &mut connection,
            Some(&project.id),
            TaskUpsertInput {
                title: "Second task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("second task should create");

        assert_eq!(first.number, "APP-1");
        assert_eq!(second.number, "WEB2-2");
    }

    #[test]
    fn defaults_new_task_repositories_from_project_default_repository() {
        let mut connection = in_memory_connection();
        crate::services::projects::create_project(
            &mut connection,
            crate::models::ProjectUpsertInput {
                name: "Project With Default Repo".into(),
                description: None,
                task_prefix: "PWD".into(),
            },
        )
        .expect("project should create");
        let project = connection
            .query_row(
                "SELECT id FROM projects WHERE name = 'Project With Default Repo'",
                [],
                |row| row.get::<_, String>(0),
            )
            .expect("project id should load");
        let repository = crate::services::projects::create_repository(
            &connection,
            &project,
            crate::models::RepositoryUpsertInput {
                name: "Default Repo".into(),
                mode: Some("existing".into()),
                repository_path: Some(std::env::temp_dir().display().to_string()),
                default_branch: Some("main".into()),
            },
        )
        .expect("repository should create");
        crate::services::projects::set_project_default_repository(
            &connection,
            &project,
            Some(&repository.id),
        )
        .expect("default repository should set");

        let task = create_task(
            &mut connection,
            Some(&project),
            TaskUpsertInput {
                title: "Repo default task".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        assert_eq!(task.repository_id.as_deref(), Some(repository.id.as_str()));
        assert_eq!(task.repository_ids, vec![repository.id]);
        assert_eq!(task.task_repositories.len(), 1);
    }

    #[test]
    fn rejects_unknown_project_ids() {
        let mut connection = in_memory_connection();
        let error = create_task(
            &mut connection,
            Some("project-missing"),
            TaskUpsertInput {
                title: "Broken".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect_err("reject missing project id");

        assert!(error.contains("Project project-missing was not found"));
    }

    #[test]
    fn rejects_lane_without_matching_workflow() {
        let mut connection = in_memory_connection();
        let error = create_task(
            &mut connection,
            Some(DEFAULT_PROJECT_ID),
            TaskUpsertInput {
                title: "Broken".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "draft".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect_err("reject missing workflow for lane");

        assert!(error.contains("currentLaneId"));
    }

    #[test]
    fn adds_lists_and_updates_task_todos() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Todo target", "in_progress", None);
        let first = add_task_todo(
            &mut connection,
            &task.id,
            TaskTodoInput {
                lane_id: Some("lane-plan".into()),
                description: "Confirm the approach with the latest context".into(),
            },
        )
        .expect("first todo should add");
        let second = add_task_todo(
            &mut connection,
            &task.id,
            TaskTodoInput {
                lane_id: Some("lane-plan".into()),
                description: "Update implementation notes".into(),
            },
        )
        .expect("second todo should add");

        let listed = list_task_todos(&connection, &task.id).expect("todos should list");
        assert_eq!(listed.len(), 2);
        assert_eq!(listed[0].id, first.id);
        assert_eq!(listed[1].id, second.id);

        let unfinished_before =
            list_unfinished_task_todos(&connection, &task.id, Some("lane-plan"))
                .expect("unfinished todos should list");
        assert_eq!(unfinished_before.len(), 2);

        let finished =
            mark_task_todo_finished(&connection, &first.id).expect("todo should mark finished");
        assert!(finished.completed);

        let unfinished_after = list_unfinished_task_todos(&connection, &task.id, Some("lane-plan"))
            .expect("unfinished todos should reload");
        assert_eq!(unfinished_after.len(), 1);
        assert_eq!(unfinished_after[0].id, second.id);

        let reopened =
            mark_task_todo_unfinished(&connection, &first.id).expect("todo should reopen");
        assert!(!reopened.completed);

        let deleted = delete_task_todo(&connection, &second.id).expect("todo should delete");
        assert_eq!(deleted.id, second.id);
        let remaining =
            list_task_todos(&connection, &task.id).expect("remaining todos should list");
        assert_eq!(remaining.len(), 1);
        assert_eq!(remaining[0].id, first.id);
    }

    #[test]
    fn add_task_todo_with_authorization_allows_explicit_same_lane_targets() {
        let mut connection = in_memory_connection();
        seed_multi_lane_workflow(&connection);

        let task = create_named_task(
            &mut connection,
            "Authorized todo target",
            "in_progress",
            None,
        );
        insert_agent_assignment(&connection, &task.id, "agent-1", "lane-plan");

        let todo = add_task_todo_with_authorization(
            &connection,
            &task.id,
            TaskTodoInput {
                lane_id: Some("lane-plan".into()),
                description: "Keep the current lane checklist visible".into(),
            },
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
        )
        .expect("same-lane todo should be allowed");

        assert_eq!(todo.lane_id, "lane-plan");
    }

    #[test]
    fn add_task_todo_with_authorization_allows_direct_handoff_lane_targets() {
        let mut connection = in_memory_connection();
        seed_multi_lane_workflow(&connection);

        let task = create_named_task(
            &mut connection,
            "Cross-lane todo target",
            "in_progress",
            None,
        );
        insert_agent_assignment(&connection, &task.id, "agent-1", "lane-plan");

        let todo = add_task_todo_with_authorization(
            &connection,
            &task.id,
            TaskTodoInput {
                lane_id: Some("lane-review".into()),
                description: "Prepare the next lane handoff".into(),
            },
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
        )
        .expect("direct handoff todo should be allowed");

        assert_eq!(todo.lane_id, "lane-review");
    }

    #[test]
    fn add_task_todo_with_authorization_rejects_non_handoff_cross_lane_targets() {
        let mut connection = in_memory_connection();
        seed_multi_lane_workflow(&connection);

        let task = create_named_task(
            &mut connection,
            "Rejected cross-lane todo target",
            "in_progress",
            None,
        );
        insert_agent_assignment(&connection, &task.id, "agent-1", "lane-plan");

        let error = add_task_todo_with_authorization(
            &connection,
            &task.id,
            TaskTodoInput {
                lane_id: Some("lane-done".into()),
                description: "Skip ahead".into(),
            },
            Some(&AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: "agent-1".into(),
            }),
        )
        .expect_err("non-handoff lane should be rejected");

        assert_eq!(
            error,
            "laneId: Workers on lane lane-plan can only create todos for lane-plan, lane-review, lane-rework. Requested lane lane-done is not permitted.",
        );
    }

    #[test]
    fn rejects_parent_tasks_from_other_projects() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-a', 'project-a', 'Project A', NULL, 'PA', NULL, ?1, ?1)",
                [now_iso()],
            )
            .expect("project A should insert");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-b', 'project-b', 'Project B', NULL, 'PB', NULL, ?1, ?1)",
                [now_iso()],
            )
            .expect("project B should insert");

        let parent = create_task(
            &mut connection,
            Some("project-b"),
            TaskUpsertInput {
                title: "Other project parent".into(),
                description: None,
                task_type: "epic".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("parent should create");

        let error = create_task(
            &mut connection,
            Some("project-a"),
            TaskUpsertInput {
                title: "Broken child".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P1".into(),
                workflow_id: Some("workflow-dev".into()),
                current_lane_id: Some("lane-plan".into()),
                assignee_type: "user".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: Some(parent.id),
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect_err("cross-project parent should be rejected");

        assert!(
            error.contains("Parent task must belong to the same project"),
            "unexpected error: {error}"
        );
    }

    #[test]
    fn rejects_parent_cycles() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let parent = create_named_task(&mut connection, "Parent", "ready", None);
        let child = create_named_task(&mut connection, "Child", "ready", Some(parent.id.clone()));

        let error = update_task(
            &mut connection,
            &parent.id,
            TaskUpsertInput {
                title: parent.title.clone(),
                description: parent.description.clone(),
                task_type: parent.task_type.clone(),
                tags: Vec::new(),
                status: parent.status.clone(),
                priority: parent.priority.clone(),
                workflow_id: parent.workflow_id.clone(),
                current_lane_id: parent.current_lane_id.clone(),
                assignee_type: parent.assignee_type.clone(),
                assignee_id: parent.assignee_id.clone(),
                repository_id: parent.repository_id.clone(),
                repository_ids: parent.repository_ids.clone(),
                parent_task_id: Some(child.id.clone()),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect_err("reject parent cycle");

        assert!(error.contains("cycle"));
    }

    #[test]
    fn adds_comments_with_interrupt_flag() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Comment target", "in_progress", None);
        let comment = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: None,
                origin_id: None,
                message: "Please course-correct before continuing.".into(),
                interrupt_agent: true,
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
        .expect("add task comment");

        assert!(comment.interrupt_agent);
        let loaded = get_task(&connection, &task.id).expect("load task with comments");
        assert_eq!(loaded.comment_count, 1);
        assert_eq!(loaded.comments.len(), 1);
        assert_eq!(loaded.comments[0].author, "Reviewer");
        assert!(loaded.comments[0].interrupt_agent);
    }

    #[test]
    fn stores_file_anchor_metadata_for_selected_text_comments() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(
            &mut connection,
            "Anchored comment target",
            "in_progress",
            None,
        );
        let now = now_iso();
        let root =
            std::env::temp_dir().join(format!("task-comment-anchor-{}", Uuid::new_v4().simple()));
        let repo_root = root.join("repository");
        std::fs::create_dir_all(repo_root.join("docs")).expect("repo docs dir should create");
        std::fs::write(
            repo_root.join("docs").join("design.md"),
            "Alpha line\nBeta selected text\nGamma line\n",
        )
        .expect("repo file should write");
        assert!(Command::new("git")
            .args(["init", "-b", "main"])
            .current_dir(&repo_root)
            .status()
            .expect("git init should run")
            .success());
        assert!(Command::new("git")
            .args(["config", "user.email", "tests@example.invalid"])
            .current_dir(&repo_root)
            .status()
            .expect("git email config should run")
            .success());
        assert!(Command::new("git")
            .args(["config", "user.name", "Tests"])
            .current_dir(&repo_root)
            .status()
            .expect("git name config should run")
            .success());
        assert!(Command::new("git")
            .args(["add", "."])
            .current_dir(&repo_root)
            .status()
            .expect("git add should run")
            .success());
        assert!(Command::new("git")
            .args(["commit", "-m", "init"])
            .current_dir(&repo_root)
            .status()
            .expect("git commit should run")
            .success());
        let commit_hash = String::from_utf8(
            Command::new("git")
                .args(["rev-parse", "HEAD"])
                .current_dir(&repo_root)
                .output()
                .expect("git rev-parse should run")
                .stdout,
        )
        .expect("commit hash should decode")
        .trim()
        .to_string();

        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES (?1, 'orchestra', 'Orchestra', 'Default Orchestra project', NULL, ?2, ?2)",
                params![DEFAULT_PROJECT_ID, now.as_str()],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'main', ?6, ?6)",
                params![
                    "repo-anchor",
                    DEFAULT_PROJECT_ID,
                    "repo-anchor",
                    "Anchor Repo",
                    repo_root.display().to_string(),
                    now.as_str(),
                ],
            )
            .expect("repository should insert");
        connection
            .execute(
                "INSERT INTO task_repositories (task_id, repository_id, created_at) VALUES (?1, ?2, ?3)",
                params![task.id.as_str(), "repo-anchor", now.as_str()],
            )
            .expect("task repository link should insert");
        connection
            .execute(
                "INSERT INTO task_file_references (id, project_id, task_id, repository_id, relative_path, is_default, created_at) VALUES (?1, ?2, ?3, ?4, ?5, 1, ?6)",
                params![
                    "task-file-anchor",
                    DEFAULT_PROJECT_ID,
                    task.id.as_str(),
                    "repo-anchor",
                    "docs/design.md",
                    now.as_str(),
                ],
            )
            .expect("task file reference should insert");

        let comment = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: None,
                origin_id: None,
                message: "Clarify this selected text.".into(),
                interrupt_agent: false,
                parent_comment_id: None,
                repository_id: Some("repo-anchor".into()),
                relative_path: Some("docs/design.md".into()),
                absolute_path: Some(
                    repo_root
                        .join("docs")
                        .join("design.md")
                        .display()
                        .to_string(),
                ),
                line_start: Some(2),
                line_end: Some(2),
                column_start: Some(1),
                column_end: Some(18),
                selected_text: Some("Beta selected text".into()),
            },
        )
        .expect("anchored comment should add");

        assert_eq!(comment.relative_path.as_deref(), Some("docs/design.md"));
        assert_eq!(comment.line_start, Some(2));
        assert_eq!(comment.line_end, Some(2));
        assert_eq!(comment.column_start, Some(1));
        assert_eq!(comment.column_end, Some(18));
        assert_eq!(comment.selected_text.as_deref(), Some("Beta selected text"));
        assert_eq!(
            comment.anchor_commit_hash.as_deref(),
            Some(commit_hash.as_str())
        );
        assert_eq!(comment.anchor_has_uncommitted_changes, Some(false));
    }

    #[test]
    fn supports_comment_replies_on_top_level_comments() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Reply target", "in_progress", None);
        let parent = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: None,
                origin_id: None,
                message: "Please split this into smaller steps.".into(),
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
        .expect("parent comment should add");
        let reply = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Worker".into(),
                origin_type: None,
                origin_id: None,
                message: "Split completed and queued for follow-up review.".into(),
                interrupt_agent: false,
                parent_comment_id: Some(parent.id.clone()),
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
        .expect("reply should add");

        let comments =
            list_task_comments(&connection, &task.id).expect("task comments should load");
        assert_eq!(comments.len(), 2);
        assert_eq!(comments[1].id, reply.id);
        assert_eq!(
            comments[1].parent_comment_id.as_deref(),
            Some(parent.id.as_str())
        );
    }

    #[test]
    fn rejects_replies_to_replies() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Nested reply target", "in_progress", None);
        let parent = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: None,
                origin_id: None,
                message: "Parent comment".into(),
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
        .expect("parent comment should add");
        let reply = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Worker".into(),
                origin_type: None,
                origin_id: None,
                message: "Reply comment".into(),
                interrupt_agent: false,
                parent_comment_id: Some(parent.id.clone()),
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
        .expect("reply should add");

        let error = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "User".into(),
                origin_type: None,
                origin_id: None,
                message: "Nested reply".into(),
                interrupt_agent: false,
                parent_comment_id: Some(reply.id.clone()),
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
        .expect_err("nested reply should be rejected");
        assert!(error.contains("Replies can only target top-level comments"));
    }

    #[test]
    fn tracks_unread_comments_and_records_receipts_per_session() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "Unread target", "in_progress", None);
        let now = now_iso();
        let assignment = TaskLaneAssignment {
            id: "assignment-unread".into(),
            task_id: task.id.clone(),
            workflow_id: "workflow-dev".into(),
            lane_id: "lane-plan".into(),
            worker_type: "agent".into(),
            worker_id: Some("agent-data".into()),
            status: "active".into(),
            session_id: Some("session-unread".into()),
            runtime_cwd: Some("/tmp/unread".into()),
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: Some("Prompt".into()),
            pending_outcome: None,
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: now.clone(),
            completed_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, 0, NULL, ?11, NULL, ?11, ?11)",
                params![
                    assignment.id.as_str(),
                    assignment.task_id.as_str(),
                    assignment.workflow_id.as_str(),
                    assignment.lane_id.as_str(),
                    assignment.worker_type.as_str(),
                    assignment.worker_id.as_deref(),
                    assignment.status.as_str(),
                    assignment.session_id.as_deref(),
                    assignment.runtime_cwd.as_deref(),
                    assignment.prompt.as_deref(),
                    now.as_str(),
                ],
            )
            .expect("assignment should insert");

        let first = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: None,
                origin_id: None,
                message: "Check the failing test before you continue.".into(),
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
        .expect("first comment should add");
        let second = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Lead".into(),
                origin_type: None,
                origin_id: None,
                message: "Also update the release notes.".into(),
                interrupt_agent: true,
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
        .expect("second comment should add");

        let unread_before = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("unread comments should load");
        assert_eq!(unread_before.len(), 2);
        assert_eq!(unread_before[0].id, first.id);
        assert_eq!(unread_before[1].id, second.id);

        let receipts = mark_task_comments_read(
            &connection,
            &task.id,
            &assignment,
            Some(&[first.id.clone()]),
        )
        .expect("comment receipt should record");
        assert_eq!(receipts.len(), 1);
        assert_eq!(receipts[0].comment_id, first.id);
        assert_eq!(receipts[0].assignment_id, assignment.id);
        assert_eq!(receipts[0].session_id, "session-unread");

        let unread_after_first = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("remaining unread comments should load");
        assert_eq!(unread_after_first.len(), 1);
        assert_eq!(unread_after_first[0].id, second.id);

        let remaining_receipts = mark_task_comments_read(&connection, &task.id, &assignment, None)
            .expect("remaining unread comments should mark read");
        assert_eq!(remaining_receipts.len(), 2);
        let unread_after_all = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("all comments should now be read");
        assert!(unread_after_all.is_empty());
    }

    #[test]
    fn tracks_user_unread_comment_receipts_without_affecting_worker_receipts() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let task = create_named_task(&mut connection, "User unread receipts", "in_progress", None);
        let now = now_iso();
        let assignment = TaskLaneAssignment {
            id: "assignment-user-receipts".into(),
            task_id: task.id.clone(),
            workflow_id: "workflow-dev".into(),
            lane_id: "lane-plan".into(),
            worker_type: "agent".into(),
            worker_id: Some("agent-data".into()),
            status: "active".into(),
            session_id: Some("session-user-receipts".into()),
            runtime_cwd: Some("/tmp/user-receipts".into()),
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: Some("Prompt".into()),
            pending_outcome: None,
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: now.clone(),
            completed_at: None,
            created_at: now.clone(),
            updated_at: now.clone(),
        };
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, NULL, NULL, ?10, 0, NULL, ?11, NULL, ?11, ?11)",
                params![
                    assignment.id.as_str(),
                    assignment.task_id.as_str(),
                    assignment.workflow_id.as_str(),
                    assignment.lane_id.as_str(),
                    assignment.worker_type.as_str(),
                    assignment.worker_id.as_deref(),
                    assignment.status.as_str(),
                    assignment.session_id.as_deref(),
                    assignment.runtime_cwd.as_deref(),
                    assignment.prompt.as_deref(),
                    now.as_str(),
                ],
            )
            .expect("assignment should insert");

        let worker_comment = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "Reviewer".into(),
                origin_type: Some("agent".into()),
                origin_id: Some("agent-reviewer".into()),
                message: "Please address the latest review feedback.".into(),
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
        .expect("worker comment should add");
        let _user_comment = add_task_comment(
            &mut connection,
            &task.id,
            TaskCommentInput {
                author: "User".into(),
                origin_type: Some("user".into()),
                origin_id: None,
                message: "I have already reviewed this.".into(),
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
        .expect("user comment should add");

        assert_eq!(
            count_unread_task_comments_for_user(
                &connection,
                &task.id,
                DEFAULT_TASK_COMMENT_USER_ID,
            )
            .expect("user unread count should load"),
            1
        );

        let worker_unread_before = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("worker unread comments should load");
        assert_eq!(worker_unread_before.len(), 2);

        let marked_count = mark_task_comments_read_for_user(&connection, &task.id, None)
            .expect("user read receipts should record");
        assert_eq!(marked_count, 1);
        assert_eq!(
            count_unread_task_comments_for_user(
                &connection,
                &task.id,
                DEFAULT_TASK_COMMENT_USER_ID,
            )
            .expect("user unread count should reload"),
            0
        );

        let worker_unread_after = list_unread_task_comments(&connection, &task.id, &assignment)
            .expect("worker unread comments should remain unchanged");
        assert_eq!(worker_unread_after.len(), 2);
        assert_eq!(worker_unread_after[0].id, worker_comment.id);
    }

    #[test]
    fn dependency_add_auto_blocks_ready_task_and_completion_restores_ready() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let blocker = create_named_task(&mut connection, "Blocker", "in_progress", None);
        let blocked = create_named_task(&mut connection, "Blocked", "ready", None);

        add_task_dependency(&mut connection, &blocker.id, &blocked.id).expect("add dependency");

        let loaded = get_task(&connection, &blocked.id).expect("load blocked task");
        assert_eq!(loaded.status, "blocked");
        assert_eq!(loaded.blocked_by_count, 1);
        assert!(loaded.dependency_blocked);
        assert!(!loaded.ready_for_dispatch);
        assert_eq!(loaded.blocked_by[0].blocker.id, blocker.id);

        let updated_blocker = update_task(
            &mut connection,
            &blocker.id,
            TaskUpsertInput {
                title: blocker.title.clone(),
                description: blocker.description.clone(),
                task_type: blocker.task_type.clone(),
                tags: Vec::new(),
                status: "completed".into(),
                priority: blocker.priority.clone(),
                workflow_id: blocker.workflow_id.clone(),
                current_lane_id: blocker.current_lane_id.clone(),
                assignee_type: blocker.assignee_type.clone(),
                assignee_id: blocker.assignee_id.clone(),
                repository_id: blocker.repository_id.clone(),
                repository_ids: blocker.repository_ids.clone(),
                parent_task_id: blocker.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("complete blocker");

        assert_eq!(updated_blocker.status, "completed");
        let unblocked = get_task(&connection, &blocked.id).expect("reload blocked task");
        assert_eq!(unblocked.status, "ready");
        assert!(!unblocked.dependency_blocked);
        assert!(unblocked.ready_for_dispatch);
    }

    #[test]
    fn dependency_resolves_when_blocker_advances_beyond_captured_lane() {
        let mut connection = in_memory_connection();
        seed_multi_lane_workflow(&connection);

        let blocker = create_named_task(&mut connection, "Blocker", "in_progress", None);
        let blocked = create_named_task(&mut connection, "Blocked", "ready", None);

        add_task_dependency(&mut connection, &blocker.id, &blocked.id).expect("add dependency");
        let initially_blocked = get_task(&connection, &blocked.id).expect("load blocked task");
        assert_eq!(initially_blocked.status, "blocked");
        assert!(initially_blocked.dependency_blocked);
        assert!(!initially_blocked.ready_for_dispatch);

        let advanced_blocker =
            move_task_to_lane(&mut connection, &blocker, "in_review", "lane-review");
        assert_eq!(
            advanced_blocker.current_lane_id.as_deref(),
            Some("lane-review")
        );

        let unblocked = get_task(&connection, &blocked.id).expect("reload unblocked task");
        assert_eq!(unblocked.status, "ready");
        assert!(!unblocked.dependency_blocked);
        assert!(unblocked.ready_for_dispatch);
    }

    #[test]
    fn dependency_remains_unresolved_without_lane_snapshot_until_terminal_status() {
        let mut connection = in_memory_connection();
        seed_multi_lane_workflow(&connection);

        let blocker = create_named_task(&mut connection, "Legacy Blocker", "in_progress", None);
        let blocked = create_named_task(&mut connection, "Legacy Blocked", "ready", None);

        add_task_dependency(&mut connection, &blocker.id, &blocked.id).expect("add dependency");
        connection
            .execute(
                "UPDATE task_dependencies SET blocker_workflow_id = NULL, blocker_lane_id = NULL, blocker_lane_order = NULL WHERE blocker_task_id = ?1 AND blocked_task_id = ?2",
                params![blocker.id.as_str(), blocked.id.as_str()],
            )
            .expect("clear dependency lane snapshot");

        move_task_to_lane(&mut connection, &blocker, "in_review", "lane-review");
        let still_blocked = get_task(&connection, &blocked.id).expect("reload still blocked task");
        assert_eq!(still_blocked.status, "blocked");
        assert!(still_blocked.dependency_blocked);
        assert!(!still_blocked.ready_for_dispatch);

        let review_blocker = get_task(&connection, &blocker.id).expect("reload blocker");
        let completed_blocker = update_task(
            &mut connection,
            &blocker.id,
            TaskUpsertInput {
                title: review_blocker.title.clone(),
                description: review_blocker.description.clone(),
                task_type: review_blocker.task_type.clone(),
                tags: review_blocker.tags.clone(),
                status: "completed".into(),
                priority: review_blocker.priority.clone(),
                workflow_id: review_blocker.workflow_id.clone(),
                current_lane_id: review_blocker.current_lane_id.clone(),
                assignee_type: review_blocker.assignee_type.clone(),
                assignee_id: review_blocker.assignee_id.clone(),
                repository_id: review_blocker.repository_id.clone(),
                repository_ids: review_blocker.repository_ids.clone(),
                parent_task_id: review_blocker.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("complete legacy blocker");
        assert_eq!(completed_blocker.status, "completed");

        let unblocked = get_task(&connection, &blocked.id).expect("reload unblocked legacy task");
        assert_eq!(unblocked.status, "ready");
        assert!(!unblocked.dependency_blocked);
        assert!(unblocked.ready_for_dispatch);
    }

    #[test]
    fn removing_final_dependency_restores_ready_but_partial_unblock_stays_blocked() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let blocker_a = create_named_task(&mut connection, "Blocker A", "in_progress", None);
        let blocker_b = create_named_task(&mut connection, "Blocker B", "in_progress", None);
        let blocked = create_named_task(&mut connection, "Blocked", "ready", None);

        let dependency_a = add_task_dependency(&mut connection, &blocker_a.id, &blocked.id)
            .expect("add first dependency");
        let dependency_b = add_task_dependency(&mut connection, &blocker_b.id, &blocked.id)
            .expect("add second dependency");

        let initially_blocked =
            get_task(&connection, &blocked.id).expect("load initially blocked task");
        assert_eq!(initially_blocked.status, "blocked");
        assert!(initially_blocked.dependency_blocked);

        remove_task_dependency(&connection, &dependency_a.id).expect("remove first dependency");
        let partially_unblocked =
            get_task(&connection, &blocked.id).expect("reload partially unblocked task");
        assert_eq!(partially_unblocked.status, "blocked");
        assert!(partially_unblocked.dependency_blocked);
        assert_eq!(partially_unblocked.blocked_by_count, 1);

        remove_task_dependency(&connection, &dependency_b.id).expect("remove final dependency");
        let fully_unblocked =
            get_task(&connection, &blocked.id).expect("reload fully unblocked task");
        assert_eq!(fully_unblocked.status, "ready");
        assert!(!fully_unblocked.dependency_blocked);
        assert!(fully_unblocked.ready_for_dispatch);
    }

    #[test]
    fn manual_blocked_state_is_not_auto_restored_when_dependencies_clear() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let blocker = create_named_task(&mut connection, "Blocker", "in_progress", None);
        let blocked = create_named_task(&mut connection, "Blocked", "blocked", None);

        let dependency =
            add_task_dependency(&mut connection, &blocker.id, &blocked.id).expect("add dependency");

        let still_manually_blocked = get_task(&connection, &blocked.id).expect("load blocked task");
        assert_eq!(still_manually_blocked.status, "blocked");
        assert!(still_manually_blocked.dependency_blocked);

        remove_task_dependency(&connection, &dependency.id).expect("remove dependency");
        let after_unblock =
            get_task(&connection, &blocked.id).expect("reload blocked task after unblocking");
        assert_eq!(after_unblock.status, "blocked");
        assert!(!after_unblock.dependency_blocked);
        assert!(!after_unblock.ready_for_dispatch);
    }

    #[test]
    fn parent_tasks_are_blocked_while_child_tasks_are_unfinished() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let parent = create_named_task(&mut connection, "Parent", "in_progress", None);
        let child = create_named_task(&mut connection, "Child", "ready", Some(parent.id.clone()));

        let loaded_parent = get_task(&connection, &parent.id).expect("load parent task");
        assert_eq!(loaded_parent.status, "blocked");
        assert_eq!(loaded_parent.child_count, 1);
        assert_eq!(loaded_parent.blocked_child_count, 1);
        assert!(loaded_parent.dependency_blocked);
        assert!(!loaded_parent.ready_for_dispatch);

        let completed_child = update_task(
            &mut connection,
            &child.id,
            TaskUpsertInput {
                title: child.title.clone(),
                description: child.description.clone(),
                task_type: child.task_type.clone(),
                tags: Vec::new(),
                status: "completed".into(),
                priority: child.priority.clone(),
                workflow_id: child.workflow_id.clone(),
                current_lane_id: child.current_lane_id.clone(),
                assignee_type: child.assignee_type.clone(),
                assignee_id: child.assignee_id.clone(),
                repository_id: child.repository_id.clone(),
                repository_ids: child.repository_ids.clone(),
                parent_task_id: child.parent_task_id.clone(),
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("complete child task");

        assert_eq!(completed_child.status, "completed");
        let unblocked_parent = get_task(&connection, &parent.id).expect("reload parent task");
        assert_eq!(unblocked_parent.status, "ready");
        assert_eq!(unblocked_parent.blocked_child_count, 0);
        assert!(!unblocked_parent.dependency_blocked);
        assert!(unblocked_parent.ready_for_dispatch);
    }

    #[test]
    fn rejects_dependency_cycles() {
        let mut connection = in_memory_connection();
        seed_workflow(&connection);

        let alpha = create_named_task(&mut connection, "Alpha", "ready", None);
        let beta = create_named_task(&mut connection, "Beta", "ready", None);
        let gamma = create_named_task(&mut connection, "Gamma", "ready", None);

        add_task_dependency(&mut connection, &alpha.id, &beta.id).expect("alpha blocks beta");
        add_task_dependency(&mut connection, &beta.id, &gamma.id).expect("beta blocks gamma");

        let error = add_task_dependency(&mut connection, &gamma.id, &alpha.id)
            .expect_err("reject dependency cycle");
        assert!(error.contains("cycle"));
    }
}
