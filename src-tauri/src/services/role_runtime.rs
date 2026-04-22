use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        RoleDefinition, RoleInstance, RoleInstanceInput, RoleOperationsDetail,
        RoleOperationsSnapshot, RoleQueueEntry, RoleQueueEntryInput, RoleSummary,
    },
    services::{roles, task_runtime},
};

const QUEUE_STATUS_QUEUED: &str = "queued";
const QUEUE_STATUS_ASSIGNED: &str = "assigned";
const QUEUE_STATUS_COMPLETED: &str = "completed";
const QUEUE_STATUS_CANCELED: &str = "canceled";

const INSTANCE_STATUS_IDLE: &str = "idle";
const INSTANCE_STATUS_RUNNING: &str = "running";
const INSTANCE_STATUS_WAITING: &str = "waiting";
const INSTANCE_STATUS_COMPLETED: &str = "completed";
const INSTANCE_STATUS_FAILED: &str = "failed";
const INSTANCE_STATUS_CANCELED: &str = "canceled";

pub fn list_role_operations(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<RoleOperationsSnapshot>, String> {
    let roles = roles::list_roles(connection, include_archived)?;
    roles
        .into_iter()
        .map(|role| build_role_operations_snapshot(connection, role))
        .collect()
}

pub fn get_role_operations(
    connection: &Connection,
    role_id: &str,
) -> Result<RoleOperationsDetail, String> {
    let role = roles::get_role(connection, role_id)?;
    let queue_entries = list_role_queue_entries(connection, Some(role_id))?;
    let instances = list_role_instances(connection, Some(role_id))?;

    Ok(RoleOperationsDetail {
        queued_count: queue_entries
            .iter()
            .filter(|entry| entry.status == QUEUE_STATUS_QUEUED)
            .count() as i64,
        assigned_count: queue_entries
            .iter()
            .filter(|entry| entry.status == QUEUE_STATUS_ASSIGNED)
            .count() as i64,
        active_instance_count: instances
            .iter()
            .filter(|instance| is_active_instance_status(&instance.status))
            .count() as i64,
        idle_instance_count: instances
            .iter()
            .filter(|instance| instance.status == INSTANCE_STATUS_IDLE)
            .count() as i64,
        role,
        queue_entries,
        instances,
    })
}

pub fn list_role_queue_entries(
    connection: &Connection,
    role_id: Option<&str>,
) -> Result<Vec<RoleQueueEntry>, String> {
    let sql = if role_id.is_some() {
        r#"
        SELECT
            id,
            role_id,
            status,
            source_type,
            source_task_id,
            source_workflow_id,
            source_lane_id,
            title,
            summary,
            entry_prompt,
            assigned_instance_id,
            created_at,
            updated_at,
            started_at,
            completed_at
        FROM role_queue_entries
        WHERE role_id = ?1
        ORDER BY created_at ASC, id ASC
        "#
    } else {
        r#"
        SELECT
            id,
            role_id,
            status,
            source_type,
            source_task_id,
            source_workflow_id,
            source_lane_id,
            title,
            summary,
            entry_prompt,
            assigned_instance_id,
            created_at,
            updated_at,
            started_at,
            completed_at
        FROM role_queue_entries
        ORDER BY created_at ASC, id ASC
        "#
    };

    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Unable to prepare role queue query: {error}"))?;

    let rows = if let Some(role_id) = role_id {
        statement
            .query_map([role_id], read_role_queue_entry)
            .map_err(|error| format!("Unable to query role queue entries for {role_id}: {error}"))?
    } else {
        statement
            .query_map([], read_role_queue_entry)
            .map_err(|error| format!("Unable to query role queue entries: {error}"))?
    };

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read role queue rows: {error}"))
}

pub fn enqueue_role_work(
    connection: &mut Connection,
    input: RoleQueueEntryInput,
) -> Result<RoleQueueEntry, String> {
    let normalized = normalize_role_queue_entry_input(input)?;
    ensure_role_is_assignable(connection, &normalized.role_id)?;

    if normalized.source_type == "workflow_lane"
        && !queue_entry_source_is_valid(
            connection,
            normalized.source_task_id.as_deref(),
            normalized.source_workflow_id.as_deref(),
            normalized.source_lane_id.as_deref(),
        )?
    {
        return Err(format!(
            "Task/lane source for role work is no longer valid: task={:?} workflow={:?} lane={:?}",
            normalized.source_task_id, normalized.source_workflow_id, normalized.source_lane_id
        ));
    }

    if normalized.source_type == "workflow_lane" {
        if let (Some(task_id), Some(lane_id)) = (
            normalized.source_task_id.as_deref(),
            normalized.source_lane_id.as_deref(),
        ) {
            if let Some(existing) = find_open_workflow_lane_queue_entry(
                connection,
                &normalized.role_id,
                task_id,
                lane_id,
            )? {
                cancel_duplicate_open_workflow_lane_queue_entries(
                    connection,
                    &normalized.role_id,
                    task_id,
                    lane_id,
                    &existing.id,
                )?;
                return Ok(existing);
            }
        }
    }

    let queue_entry_id = role_queue_entry_id();
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role queue transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO role_queue_entries (
            id,
            role_id,
            status,
            source_type,
            source_task_id,
            source_workflow_id,
            source_lane_id,
            title,
            summary,
            entry_prompt,
            assigned_instance_id,
            created_at,
            updated_at,
            started_at,
            completed_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, NULL, ?11, ?11, NULL, NULL)
        "#,
        params![
            queue_entry_id,
            normalized.role_id,
            QUEUE_STATUS_QUEUED,
            normalized.source_type,
            normalized.source_task_id,
            normalized.source_workflow_id,
            normalized.source_lane_id,
            normalized.title,
            normalized.summary,
            normalized.entry_prompt,
            now,
        ],
    )
    .map_err(|error| format!("Unable to enqueue role work: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit role queue transaction: {error}"))?;

    get_role_queue_entry(connection, &queue_entry_id)
}

pub fn get_role_queue_entry(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<RoleQueueEntry, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                role_id,
                status,
                source_type,
                source_task_id,
                source_workflow_id,
                source_lane_id,
                title,
                summary,
                entry_prompt,
                assigned_instance_id,
                created_at,
                updated_at,
                started_at,
                completed_at
            FROM role_queue_entries
            WHERE id = ?1
            "#,
            [queue_entry_id],
            read_role_queue_entry,
        )
        .optional()
        .map_err(|error| format!("Unable to query role queue entry {queue_entry_id}: {error}"))?
        .ok_or_else(|| format!("Role queue entry {queue_entry_id} was not found"))
}

pub fn find_open_workflow_lane_queue_entry(
    connection: &Connection,
    role_id: &str,
    task_id: &str,
    lane_id: &str,
) -> Result<Option<RoleQueueEntry>, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                role_id,
                status,
                source_type,
                source_task_id,
                source_workflow_id,
                source_lane_id,
                title,
                summary,
                entry_prompt,
                assigned_instance_id,
                created_at,
                updated_at,
                started_at,
                completed_at
            FROM role_queue_entries
            WHERE role_id = ?1
              AND source_type = 'workflow_lane'
              AND source_task_id = ?2
              AND source_lane_id = ?3
              AND status IN ('queued', 'assigned')
            ORDER BY CASE status WHEN 'assigned' THEN 0 ELSE 1 END,
                     created_at ASC,
                     id ASC
            LIMIT 1
            "#,
            params![role_id, task_id, lane_id],
            read_role_queue_entry,
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to query open workflow-lane queue entry for role {role_id} task {task_id} lane {lane_id}: {error}"
            )
        })
}

pub fn cancel_duplicate_open_workflow_lane_queue_entries(
    connection: &Connection,
    role_id: &str,
    task_id: &str,
    lane_id: &str,
    keep_queue_entry_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM role_queue_entries
            WHERE role_id = ?1
              AND source_type = 'workflow_lane'
              AND source_task_id = ?2
              AND source_lane_id = ?3
              AND status IN ('queued', 'assigned')
              AND id <> ?4
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| {
            format!(
                "Unable to prepare duplicate workflow-lane queue query for role {role_id} task {task_id} lane {lane_id}: {error}"
            )
        })?;
    let duplicate_ids = statement
        .query_map(params![role_id, task_id, lane_id, keep_queue_entry_id], |row| {
            row.get::<_, String>(0)
        })
        .map_err(|error| {
            format!(
                "Unable to query duplicate workflow-lane queue entries for role {role_id} task {task_id} lane {lane_id}: {error}"
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Unable to read duplicate workflow-lane queue entries for role {role_id} task {task_id} lane {lane_id}: {error}"
            )
        })?;

    if duplicate_ids.is_empty() {
        return Ok(duplicate_ids);
    }

    let now = now_iso();
    for duplicate_id in &duplicate_ids {
        connection
            .execute(
                r#"
                UPDATE role_queue_entries
                SET status = 'canceled',
                    assigned_instance_id = NULL,
                    started_at = NULL,
                    completed_at = ?2,
                    updated_at = ?2
                WHERE id = ?1 AND status IN ('queued', 'assigned')
                "#,
                params![duplicate_id, now],
            )
            .map_err(|error| {
                format!(
                    "Unable to cancel duplicate workflow-lane queue entry {duplicate_id}: {error}"
                )
            })?;
    }

    Ok(duplicate_ids)
}

pub fn delete_role_queue_entry(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<RoleQueueEntry, String> {
    let entry = get_role_queue_entry(connection, queue_entry_id)?;
    if entry.status != QUEUE_STATUS_QUEUED {
        return Err(format!(
            "Role queue entry {queue_entry_id} is {} and cannot be deleted unless it is queued",
            entry.status
        ));
    }

    let deleted = connection
        .execute(
            "DELETE FROM role_queue_entries WHERE id = ?1 AND status = 'queued'",
            params![queue_entry_id],
        )
        .map_err(|error| format!("Unable to delete role queue entry {queue_entry_id}: {error}"))?;
    if deleted == 0 {
        return Err(format!(
            "Role queue entry {queue_entry_id} could not be deleted"
        ));
    }

    Ok(entry)
}

pub fn queue_entry_source_is_valid(
    connection: &Connection,
    source_task_id: Option<&str>,
    source_workflow_id: Option<&str>,
    source_lane_id: Option<&str>,
) -> Result<bool, String> {
    let (Some(task_id), Some(lane_id)) = (source_task_id, source_lane_id) else {
        return Ok(true);
    };

    task_runtime::task_lane_queue_source_is_valid(connection, task_id, source_workflow_id, lane_id)
}

pub fn queue_entry_is_valid(
    connection: &Connection,
    entry: &RoleQueueEntry,
) -> Result<bool, String> {
    if entry.source_type != "workflow_lane" {
        return Ok(true);
    }

    queue_entry_source_is_valid(
        connection,
        entry.source_task_id.as_deref(),
        entry.source_workflow_id.as_deref(),
        entry.source_lane_id.as_deref(),
    )
}

pub fn list_role_instances(
    connection: &Connection,
    role_id: Option<&str>,
) -> Result<Vec<RoleInstance>, String> {
    let sql = if role_id.is_some() {
        r#"
        SELECT
            id,
            role_id,
            display_name,
            status,
            current_queue_entry_id,
            session_id,
            worktree_path,
            last_heartbeat_at,
            last_error,
            created_at,
            updated_at
        FROM role_instances
        WHERE role_id = ?1
        ORDER BY updated_at DESC, id ASC
        "#
    } else {
        r#"
        SELECT
            id,
            role_id,
            display_name,
            status,
            current_queue_entry_id,
            session_id,
            worktree_path,
            last_heartbeat_at,
            last_error,
            created_at,
            updated_at
        FROM role_instances
        ORDER BY updated_at DESC, id ASC
        "#
    };

    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Unable to prepare role instance query: {error}"))?;

    let rows = if let Some(role_id) = role_id {
        statement
            .query_map([role_id], read_role_instance)
            .map_err(|error| format!("Unable to query role instances for {role_id}: {error}"))?
    } else {
        statement
            .query_map([], read_role_instance)
            .map_err(|error| format!("Unable to query role instances: {error}"))?
    };

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read role instance rows: {error}"))
}

pub fn create_role_instance(
    connection: &mut Connection,
    input: RoleInstanceInput,
) -> Result<RoleInstance, String> {
    let normalized = normalize_role_instance_input(connection, input)?;
    ensure_role_is_assignable(connection, &normalized.role_id)?;

    let instance_id = role_instance_id();
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role instance transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO role_instances (
            id,
            role_id,
            display_name,
            status,
            current_queue_entry_id,
            session_id,
            worktree_path,
            last_heartbeat_at,
            last_error,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)
        "#,
        params![
            instance_id,
            normalized.role_id,
            normalized.display_name,
            normalized.status,
            normalized.current_queue_entry_id,
            normalized.session_id,
            normalized.worktree_path,
            normalized.last_heartbeat_at,
            normalized.last_error,
            now,
        ],
    )
    .map_err(|error| format!("Unable to create role instance: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit role instance transaction: {error}"))?;

    get_role_instance(connection, &instance_id)
}

pub fn get_role_instance(
    connection: &Connection,
    instance_id: &str,
) -> Result<RoleInstance, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                role_id,
                display_name,
                status,
                current_queue_entry_id,
                session_id,
                worktree_path,
                last_heartbeat_at,
                last_error,
                created_at,
                updated_at
            FROM role_instances
            WHERE id = ?1
            "#,
            [instance_id],
            read_role_instance,
        )
        .optional()
        .map_err(|error| format!("Unable to query role instance {instance_id}: {error}"))?
        .ok_or_else(|| format!("Role instance {instance_id} was not found"))
}

fn build_role_operations_snapshot(
    connection: &Connection,
    role: RoleSummary,
) -> Result<RoleOperationsSnapshot, String> {
    let counts = get_role_operations_counts(connection, &role.id)?;
    let latest_error = connection
        .query_row(
            r#"
            SELECT last_error
            FROM role_instances
            WHERE role_id = ?1
              AND last_error IS NOT NULL
              AND trim(last_error) != ''
            ORDER BY updated_at DESC, id DESC
            LIMIT 1
            "#,
            [role.id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query latest role error for {}: {error}", role.id))?;

    Ok(RoleOperationsSnapshot {
        role,
        queued_count: counts.0,
        assigned_count: counts.1,
        active_instance_count: counts.2,
        idle_instance_count: counts.3,
        latest_error,
    })
}

fn get_role_operations_counts(
    connection: &Connection,
    role_id: &str,
) -> Result<(i64, i64, i64, i64), String> {
    let queued_count = count_query(
        connection,
        "SELECT COUNT(*) FROM role_queue_entries WHERE role_id = ?1 AND status = 'queued'",
        role_id,
        "queued role work",
    )?;
    let assigned_count = count_query(
        connection,
        "SELECT COUNT(*) FROM role_queue_entries WHERE role_id = ?1 AND status = 'assigned'",
        role_id,
        "assigned role work",
    )?;
    let active_instance_count = count_query(
        connection,
        "SELECT COUNT(*) FROM role_instances WHERE role_id = ?1 AND status = 'running'",
        role_id,
        "active role instances",
    )?;
    let idle_instance_count = count_query(
        connection,
        "SELECT COUNT(*) FROM role_instances WHERE role_id = ?1 AND status = 'idle'",
        role_id,
        "idle role instances",
    )?;

    Ok((
        queued_count,
        assigned_count,
        active_instance_count,
        idle_instance_count,
    ))
}

fn count_query(
    connection: &Connection,
    sql: &str,
    role_id: &str,
    label: &str,
) -> Result<i64, String> {
    connection
        .query_row(sql, [role_id], |row| row.get(0))
        .map_err(|error| format!("Unable to query {label} for role {role_id}: {error}"))
}

fn normalize_role_queue_entry_input(
    input: RoleQueueEntryInput,
) -> Result<RoleQueueEntryInput, String> {
    let source_type = input.source_type.trim().to_string();
    if !matches!(source_type.as_str(), "manual" | "workflow_lane") {
        return Err("Role queue source type must be one of: manual, workflow_lane.".into());
    }

    let title = input.title.trim().to_string();
    if title.is_empty() {
        return Err("Role queue title is required.".into());
    }

    Ok(RoleQueueEntryInput {
        role_id: input.role_id,
        source_type,
        source_task_id: normalize_optional(input.source_task_id),
        source_workflow_id: normalize_optional(input.source_workflow_id),
        source_lane_id: normalize_optional(input.source_lane_id),
        title,
        summary: normalize_optional(input.summary),
        entry_prompt: normalize_optional(input.entry_prompt),
    })
}

fn normalize_role_instance_input(
    connection: &Connection,
    input: RoleInstanceInput,
) -> Result<RoleInstanceInput, String> {
    let role = roles::get_role(connection, &input.role_id)?;
    let status = normalize_optional(input.status).unwrap_or_else(|| INSTANCE_STATUS_IDLE.into());
    if !matches!(
        status.as_str(),
        INSTANCE_STATUS_IDLE
            | INSTANCE_STATUS_RUNNING
            | INSTANCE_STATUS_WAITING
            | INSTANCE_STATUS_COMPLETED
            | INSTANCE_STATUS_FAILED
            | INSTANCE_STATUS_CANCELED
    ) {
        return Err(
            "Role instance status must be one of: idle, running, waiting, completed, failed, canceled."
                .into(),
        );
    }

    let display_name = normalize_optional(input.display_name)
        .unwrap_or_else(|| format!("{} {}", role.name, short_role_instance_suffix()));

    Ok(RoleInstanceInput {
        role_id: input.role_id,
        display_name: Some(display_name),
        status: Some(status),
        current_queue_entry_id: normalize_optional(input.current_queue_entry_id),
        session_id: normalize_optional(input.session_id),
        worktree_path: normalize_optional(input.worktree_path),
        last_heartbeat_at: normalize_optional(input.last_heartbeat_at),
        last_error: normalize_optional(input.last_error),
    })
}

fn ensure_role_is_assignable(
    connection: &Connection,
    role_id: &str,
) -> Result<RoleDefinition, String> {
    let role = roles::get_role(connection, role_id)?;
    if role.archived {
        return Err(format!(
            "Role {role_id} is archived and cannot accept runtime work"
        ));
    }
    Ok(role)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn read_role_queue_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoleQueueEntry> {
    Ok(RoleQueueEntry {
        id: row.get(0)?,
        role_id: row.get(1)?,
        status: row.get(2)?,
        source_type: row.get(3)?,
        source_task_id: row.get(4)?,
        source_workflow_id: row.get(5)?,
        source_lane_id: row.get(6)?,
        title: row.get(7)?,
        summary: row.get(8)?,
        entry_prompt: row.get(9)?,
        assigned_instance_id: row.get(10)?,
        created_at: row.get(11)?,
        updated_at: row.get(12)?,
        started_at: row.get(13)?,
        completed_at: row.get(14)?,
    })
}

fn read_role_instance(row: &rusqlite::Row<'_>) -> rusqlite::Result<RoleInstance> {
    Ok(RoleInstance {
        id: row.get(0)?,
        role_id: row.get(1)?,
        display_name: row.get(2)?,
        status: row.get(3)?,
        current_queue_entry_id: row.get(4)?,
        session_id: row.get(5)?,
        worktree_path: row.get(6)?,
        last_heartbeat_at: row.get(7)?,
        last_error: row.get(8)?,
        created_at: row.get(9)?,
        updated_at: row.get(10)?,
    })
}

fn is_active_instance_status(status: &str) -> bool {
    matches!(status, INSTANCE_STATUS_RUNNING)
}

fn role_queue_entry_id() -> String {
    format!("queue-{}", Uuid::new_v4().simple())
}

fn role_instance_id() -> String {
    format!("instance-{}", Uuid::new_v4().simple())
}

fn short_role_instance_suffix() -> String {
    Uuid::new_v4().simple().to_string()[..6].to_string()
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{TaskUpsertInput, WorkflowLaneInput, WorkflowUpsertInput},
        services::{database::initialize_database_at, roles, tasks, workflows},
    };
    use std::{
        env,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix).join("orchestra.db")
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    fn create_role(connection: &mut Connection, name: &str, capacity: i64) -> RoleDefinition {
        roles::create_role(
            connection,
            crate::models::RoleUpsertInput {
                name: name.into(),
                description: Some(format!("{name} description")),
                system_prompt: Some(format!("{name} prompt")),
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create")
    }

    fn ensure_default_project(connection: &Connection) {
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("project should insert");
    }

    #[test]
    fn enqueues_runtime_work_and_lists_queue_entries() {
        let mut connection = open_test_connection("role-runtime-queue");
        let role = create_role(&mut connection, "Reviewer", 2);

        let entry = enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Review PR #10".into(),
                summary: Some("Inspect the current role management slice.".into()),
                entry_prompt: Some("Review the work carefully.".into()),
            },
        )
        .expect("queue entry should create");

        assert_eq!(entry.status, QUEUE_STATUS_QUEUED);
        assert_eq!(entry.source_type, "manual");

        let entries = list_role_queue_entries(&connection, Some(role.id.as_str()))
            .expect("role queue should list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, entry.id);
    }

    #[test]
    fn rejects_invalid_task_lane_role_work() {
        let mut connection = open_test_connection("role-runtime-invalid-task-lane");
        ensure_default_project(&connection);
        let role = create_role(&mut connection, "Reviewer", 2);
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Role Queue Guard Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-role-guard".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Guard invalid lane queueing".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-role-guard".into()),
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
        connection
            .execute(
                "UPDATE tasks SET current_lane_id = 'lane-other', updated_at = ?2 WHERE id = ?1",
                params![task.id.as_str(), now_iso()],
            )
            .expect("task lane should update");

        let error = enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "workflow_lane".into(),
                source_task_id: Some(task.id.clone()),
                source_workflow_id: Some(workflow.id.clone()),
                source_lane_id: Some("lane-role-guard".into()),
                title: "Invalid role lane work".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect_err("invalid task lane work should be rejected");
        assert!(error.contains("no longer valid"));
    }

    #[test]
    fn reuses_existing_workflow_lane_queue_entry_for_same_task_and_lane() {
        let mut connection = open_test_connection("role-runtime-dedup");
        ensure_default_project(&connection);
        let role = create_role(&mut connection, "Reviewer", 2);
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Role Dedup Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-role-dedup".into()),
                    key: "review".into(),
                    name: "Review".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Deduplicate queue entries".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-role-dedup".into()),
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

        let first = enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "workflow_lane".into(),
                source_task_id: Some(task.id.clone()),
                source_workflow_id: Some(workflow.id.clone()),
                source_lane_id: Some("lane-role-dedup".into()),
                title: "ORC-1 · Review lane".into(),
                summary: Some("First queue entry".into()),
                entry_prompt: Some("Review the lane work.".into()),
            },
        )
        .expect("first workflow-lane queue entry should create");

        let second = enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "workflow_lane".into(),
                source_task_id: Some(task.id.clone()),
                source_workflow_id: Some(workflow.id.clone()),
                source_lane_id: Some("lane-role-dedup".into()),
                title: "ORC-1 · Review lane".into(),
                summary: Some("Second queue entry".into()),
                entry_prompt: Some("Review the lane work again.".into()),
            },
        )
        .expect("duplicate workflow-lane queue entry should reuse existing row");

        assert_eq!(first.id, second.id);
        let entries = list_role_queue_entries(&connection, Some(role.id.as_str()))
            .expect("role queue should list");
        assert_eq!(entries.len(), 1);
        assert_eq!(entries[0].id, first.id);
    }

    #[test]
    fn deletes_only_queued_role_queue_entries() {
        let mut connection = open_test_connection("role-runtime-delete-queue");
        let role = create_role(&mut connection, "Reviewer", 2);

        let queued = enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Queued role work".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect("queued entry should create");

        let deleted = delete_role_queue_entry(&connection, &queued.id)
            .expect("queued role entry should delete");
        assert_eq!(deleted.id, queued.id);
        assert!(list_role_queue_entries(&connection, Some(role.id.as_str()))
            .expect("queue entries should list")
            .is_empty());

        let assigned = enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Assigned role work".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect("assigned seed entry should create");
        connection
            .execute(
                "UPDATE role_queue_entries SET status = 'assigned', updated_at = ?2 WHERE id = ?1",
                params![assigned.id.as_str(), now_iso()],
            )
            .expect("assigned state should update");

        let error = delete_role_queue_entry(&connection, &assigned.id)
            .expect_err("assigned role entry should not be deletable");
        assert!(error.contains("cannot be deleted unless it is queued"));
    }

    #[test]
    fn creates_role_instances_with_default_display_names() {
        let mut connection = open_test_connection("role-runtime-instance");
        let role = create_role(&mut connection, "Developer", 1);

        let instance = create_role_instance(
            &mut connection,
            RoleInstanceInput {
                role_id: role.id.clone(),
                display_name: None,
                status: Some(INSTANCE_STATUS_IDLE.into()),
                current_queue_entry_id: None,
                session_id: None,
                worktree_path: None,
                last_heartbeat_at: None,
                last_error: None,
            },
        )
        .expect("instance should create");

        assert_eq!(instance.role_id, role.id);
        assert!(instance.display_name.starts_with("Developer "));
        assert_eq!(instance.status, INSTANCE_STATUS_IDLE);
    }

    #[test]
    fn builds_role_operation_snapshots() {
        let mut connection = open_test_connection("role-runtime-snapshot");
        let role = create_role(&mut connection, "Planner", 2);

        enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Draft implementation plan".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect("queue entry should create");

        create_role_instance(
            &mut connection,
            RoleInstanceInput {
                role_id: role.id.clone(),
                display_name: Some("Planner Alpha".into()),
                status: Some(INSTANCE_STATUS_RUNNING.into()),
                current_queue_entry_id: None,
                session_id: Some("session-123".into()),
                worktree_path: Some("/tmp/worktree".into()),
                last_heartbeat_at: None,
                last_error: Some("Prompt timeout".into()),
            },
        )
        .expect("instance should create");

        let snapshots =
            list_role_operations(&connection, false).expect("role operations should list");
        assert_eq!(snapshots.len(), 1);
        assert_eq!(snapshots[0].queued_count, 1);
        assert_eq!(snapshots[0].active_instance_count, 1);
        assert_eq!(snapshots[0].latest_error.as_deref(), Some("Prompt timeout"));

        let detail = get_role_operations(&connection, role.id.as_str())
            .expect("role operations detail should load");
        assert_eq!(detail.queue_entries.len(), 1);
        assert_eq!(detail.instances.len(), 1);
    }
}
