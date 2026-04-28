use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput,
        AgentRuntimeState,
    },
    services::{agents, task_runtime},
};

const DEFAULT_PROJECT_ID: &str = "orchestra";
const RUNTIME_STATUS_IDLE: &str = "idle";
const RUNTIME_STATUS_RUNNING: &str = "running";
const RUNTIME_STATUS_NEEDS_ATTENTION: &str = "needs_attention";

const QUEUE_STATUS_QUEUED: &str = "queued";
const QUEUE_STATUS_DISPATCHED: &str = "dispatched";
const QUEUE_STATUS_COMPLETED: &str = "completed";
const QUEUE_STATUS_FAILED: &str = "failed";
const QUEUE_STATUS_CANCELED: &str = "canceled";

pub fn list_agent_operations(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<AgentOperationsSnapshot>, String> {
    list_agent_operations_for_project(connection, DEFAULT_PROJECT_ID, include_archived)
}

pub fn list_agent_operations_for_project(
    connection: &Connection,
    project_id: &str,
    include_archived: bool,
) -> Result<Vec<AgentOperationsSnapshot>, String> {
    let agents = agents::list_agents_for_project(connection, include_archived, Some(project_id))?;
    agents
        .into_iter()
        .map(|agent| build_agent_operations_snapshot(connection, project_id, &agent.id))
        .collect()
}

pub fn get_agent_operations(
    connection: &Connection,
    agent_id: &str,
) -> Result<AgentOperationsDetail, String> {
    get_agent_operations_for_project(connection, DEFAULT_PROJECT_ID, agent_id)
}

pub fn get_agent_operations_for_project(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
) -> Result<AgentOperationsDetail, String> {
    let agent = agents::require_agent_in_project(connection, project_id, agent_id)?;
    let runtime_state = ensure_agent_runtime_state_for_project(connection, project_id, agent_id)?;
    let queue_entries =
        list_agent_queue_entries_for_project(connection, project_id, Some(agent_id), false)?;

    Ok(AgentOperationsDetail {
        agent,
        runtime_state,
        queue_entries,
    })
}

pub fn ensure_agent_runtime_state(
    connection: &Connection,
    agent_id: &str,
) -> Result<AgentRuntimeState, String> {
    ensure_agent_runtime_state_for_project(connection, DEFAULT_PROJECT_ID, agent_id)
}

pub fn ensure_agent_runtime_state_for_project(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
) -> Result<AgentRuntimeState, String> {
    let agent = agents::require_agent_in_project(connection, project_id, agent_id)?;

    // For global agents, use the default project to ensure singleton behavior
    let effective_project_id = if agent.scope == "global" {
        DEFAULT_PROJECT_ID
    } else {
        project_id
    };

    if let Some(existing) =
        get_agent_runtime_state_for_project(connection, effective_project_id, agent_id)?
    {
        return Ok(existing);
    }

    let now = now_iso();
    let global_main_session_id = if agent.scope == "global" {
        find_global_main_session_id(connection, agent_id)?
    } else {
        None
    };
    connection
        .execute(
            r#"
            INSERT INTO agent_runtime_states (
                project_id,
                agent_id,
                status,
                main_session_id,
                runtime_cwd,
                current_queue_entry_id,
                last_dispatch_at,
                last_error,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, NULL, NULL, NULL, NULL, ?5, ?5)
            "#,
            params![effective_project_id, agent_id, RUNTIME_STATUS_IDLE, global_main_session_id, now],
        )
        .map_err(|error| format!("Unable to create agent runtime state for {agent_id} in project {effective_project_id}: {error}"))?;

    get_agent_runtime_state_for_project(connection, effective_project_id, agent_id)?
        .ok_or_else(|| format!("Agent runtime state for {agent_id} was not found after creation"))
}

pub fn get_agent_runtime_state(
    connection: &Connection,
    agent_id: &str,
) -> Result<Option<AgentRuntimeState>, String> {
    get_agent_runtime_state_for_project(connection, DEFAULT_PROJECT_ID, agent_id)
}

pub fn get_agent_runtime_state_for_project(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
) -> Result<Option<AgentRuntimeState>, String> {
    connection
        .query_row(
            r#"
            SELECT project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at
            FROM agent_runtime_states
            WHERE project_id = ?1 AND agent_id = ?2
            "#,
            params![project_id, agent_id],
            read_agent_runtime_state,
        )
        .optional()
        .map_err(|error| format!("Unable to query agent runtime state for {agent_id} in project {project_id}: {error}"))
}

pub fn find_global_main_session_id(
    connection: &Connection,
    agent_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT main_session_id
            FROM agent_runtime_states
            WHERE agent_id = ?1 AND main_session_id IS NOT NULL AND trim(main_session_id) != ''
            ORDER BY updated_at DESC, created_at DESC
            LIMIT 1
            "#,
            [agent_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query global main session for {agent_id}: {error}"))
}

pub fn list_agent_queue_entries(
    connection: &Connection,
    agent_id: Option<&str>,
    include_terminal: bool,
) -> Result<Vec<AgentQueueEntry>, String> {
    list_agent_queue_entries_for_project(connection, DEFAULT_PROJECT_ID, agent_id, include_terminal)
}

pub fn list_agent_queue_entries_for_project(
    connection: &Connection,
    project_id: &str,
    agent_id: Option<&str>,
    include_terminal: bool,
) -> Result<Vec<AgentQueueEntry>, String> {
    let sql_for_agent = if include_terminal {
        r#"
        SELECT id, project_id, agent_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, delivery_mode, title, message, session_id, run_id, dispatched_at, completed_at, created_at, updated_at
        FROM agent_queue_entries
        WHERE project_id = ?1 AND agent_id = ?2
        ORDER BY created_at ASC, id ASC
        "#
    } else {
        r#"
        SELECT id, project_id, agent_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, delivery_mode, title, message, session_id, run_id, dispatched_at, completed_at, created_at, updated_at
        FROM agent_queue_entries
        WHERE project_id = ?1 AND agent_id = ?2 AND status IN ('queued', 'dispatched')
        ORDER BY created_at ASC, id ASC
        "#
    };

    let sql_all = if include_terminal {
        r#"
        SELECT id, project_id, agent_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, delivery_mode, title, message, session_id, run_id, dispatched_at, completed_at, created_at, updated_at
        FROM agent_queue_entries
        WHERE project_id = ?1
        ORDER BY created_at ASC, id ASC
        "#
    } else {
        r#"
        SELECT id, project_id, agent_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, delivery_mode, title, message, session_id, run_id, dispatched_at, completed_at, created_at, updated_at
        FROM agent_queue_entries
        WHERE project_id = ?1 AND status IN ('queued', 'dispatched')
        ORDER BY created_at ASC, id ASC
        "#
    };

    let mut statement = connection
        .prepare(if agent_id.is_some() {
            sql_for_agent
        } else {
            sql_all
        })
        .map_err(|error| format!("Unable to prepare agent queue query: {error}"))?;

    let rows = if let Some(agent_id) = agent_id {
        statement
            .query_map(params![project_id, agent_id], read_agent_queue_entry)
            .map_err(|error| format!("Unable to query agent queue entries for {agent_id} in project {project_id}: {error}"))?
    } else {
        statement
            .query_map(params![project_id], read_agent_queue_entry)
            .map_err(|error| {
                format!("Unable to query agent queue entries for project {project_id}: {error}")
            })?
    };

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read agent queue entries: {error}"))
}

pub fn enqueue_agent_work(
    connection: &Connection,
    input: AgentQueueEntryInput,
) -> Result<AgentQueueEntry, String> {
    enqueue_agent_work_for_project(connection, DEFAULT_PROJECT_ID, input)
}

pub fn enqueue_agent_work_for_project(
    connection: &Connection,
    project_id: &str,
    input: AgentQueueEntryInput,
) -> Result<AgentQueueEntry, String> {
    let normalized = normalize_agent_queue_entry_input(input)?;
    let agent = agents::require_agent_in_project(connection, project_id, &normalized.agent_id)?;
    if agent.archived {
        return Err(format!(
            "Agent {} is archived and cannot accept runtime work",
            agent.name
        ));
    }

    if normalized.source_type == "workflow_lane"
        && !queue_entry_source_is_valid(
            connection,
            normalized.source_task_id.as_deref(),
            normalized.source_workflow_id.as_deref(),
            normalized.source_lane_id.as_deref(),
        )?
    {
        return Err(format!(
            "Task/lane source for agent work is no longer valid: task={:?} workflow={:?} lane={:?}",
            normalized.source_task_id, normalized.source_workflow_id, normalized.source_lane_id
        ));
    }

    ensure_agent_runtime_state_for_project(connection, project_id, &normalized.agent_id)?;

    let entry_id = format!("agent-queue-{}", Uuid::new_v4().simple());
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO agent_queue_entries (
                id,
                project_id,
                agent_id,
                status,
                source_type,
                source_task_id,
                source_workflow_id,
                source_lane_id,
                delivery_mode,
                title,
                message,
                session_id,
                run_id,
                dispatched_at,
                completed_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, NULL, NULL, NULL, NULL, ?12, ?12)
            "#,
            params![
                entry_id,
                project_id,
                normalized.agent_id,
                QUEUE_STATUS_QUEUED,
                normalized.source_type,
                normalized.source_task_id,
                normalized.source_workflow_id,
                normalized.source_lane_id,
                normalized.delivery_mode,
                normalized.title,
                normalized.message,
                now,
            ],
        )
        .map_err(|error| {
            format!("Unable to enqueue agent work in project {project_id}: {error}")
        })?;

    get_agent_queue_entry(connection, &entry_id)
}

pub fn list_agent_queue_targets(connection: &Connection) -> Result<Vec<(String, String)>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT DISTINCT project_id, agent_id
            FROM agent_queue_entries
            WHERE status IN ('queued', 'dispatched')
            ORDER BY project_id ASC, agent_id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare agent queue target query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Unable to query agent queue targets: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read agent queue targets: {error}"))
}

pub fn get_agent_queue_entry(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<AgentQueueEntry, String> {
    connection
        .query_row(
            r#"
            SELECT id, project_id, agent_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, delivery_mode, title, message, session_id, run_id, dispatched_at, completed_at, created_at, updated_at
            FROM agent_queue_entries
            WHERE id = ?1
            "#,
            [queue_entry_id],
            read_agent_queue_entry,
        )
        .optional()
        .map_err(|error| format!("Unable to query agent queue entry {queue_entry_id}: {error}"))?
        .ok_or_else(|| format!("Agent queue entry {queue_entry_id} was not found"))
}

pub fn mark_agent_queue_entry_dispatched(
    connection: &Connection,
    queue_entry_id: &str,
    session_id: &str,
    run_id: &str,
) -> Result<Option<AgentQueueEntry>, String> {
    let now = now_iso();
    let updated = connection
        .execute(
            r#"
            UPDATE agent_queue_entries
            SET status = 'dispatched',
                session_id = ?2,
                run_id = ?3,
                dispatched_at = ?4,
                updated_at = ?4
            WHERE id = ?1 AND status = 'queued'
            "#,
            params![queue_entry_id, session_id, run_id, now],
        )
        .map_err(|error| {
            format!("Unable to mark agent queue entry {queue_entry_id} dispatched: {error}")
        })?;

    if updated == 0 {
        return Ok(None);
    }

    get_agent_queue_entry(connection, queue_entry_id).map(Some)
}

pub fn claim_next_agent_queue_entry(
    connection: &Connection,
    agent_id: &str,
    session_id: &str,
    run_id: &str,
) -> Result<Option<AgentQueueEntry>, String> {
    let next_id = connection
        .query_row(
            r#"
            SELECT id
            FROM agent_queue_entries
            WHERE project_id = ?1 AND agent_id = ?2 AND status = 'queued'
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            "#,
            params![DEFAULT_PROJECT_ID, agent_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query next agent queue entry for {agent_id}: {error}")
        })?;

    let Some(next_id) = next_id else {
        return Ok(None);
    };

    mark_agent_queue_entry_dispatched(connection, &next_id, session_id, run_id)
}

pub fn mark_agent_queue_entry_completed(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE agent_queue_entries SET status = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![queue_entry_id, QUEUE_STATUS_COMPLETED, now],
        )
        .map_err(|error| format!("Unable to complete agent queue entry {queue_entry_id}: {error}"))?;
    Ok(())
}

pub fn mark_agent_queue_entry_failed(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE agent_queue_entries SET status = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![queue_entry_id, QUEUE_STATUS_FAILED, now],
        )
        .map_err(|error| format!("Unable to fail agent queue entry {queue_entry_id}: {error}"))?;
    Ok(())
}

pub fn delete_agent_queue_entry(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<AgentQueueEntry, String> {
    let entry = get_agent_queue_entry(connection, queue_entry_id)?;
    if entry.status != QUEUE_STATUS_QUEUED {
        return Err(format!(
            "Agent queue entry {queue_entry_id} is {} and cannot be deleted unless it is queued",
            entry.status
        ));
    }

    let deleted = connection
        .execute(
            "DELETE FROM agent_queue_entries WHERE id = ?1 AND status = 'queued'",
            params![queue_entry_id],
        )
        .map_err(|error| format!("Unable to delete agent queue entry {queue_entry_id}: {error}"))?;
    if deleted == 0 {
        return Err(format!(
            "Agent queue entry {queue_entry_id} could not be deleted"
        ));
    }

    Ok(entry)
}

pub fn cancel_agent_queue_entry(
    connection: &Connection,
    queue_entry_id: &str,
) -> Result<AgentQueueEntry, String> {
    let entry = get_agent_queue_entry(connection, queue_entry_id)?;
    if !matches!(
        entry.status.as_str(),
        QUEUE_STATUS_QUEUED | QUEUE_STATUS_DISPATCHED
    ) {
        return Err(format!(
            "Agent queue entry {queue_entry_id} is {} and cannot be canceled unless it is queued or dispatched",
            entry.status
        ));
    }

    let now = now_iso();
    connection
        .execute(
            r#"
            UPDATE agent_queue_entries
            SET status = 'canceled',
                completed_at = ?2,
                updated_at = ?2
            WHERE id = ?1 AND status IN ('queued', 'dispatched')
            "#,
            params![queue_entry_id, now],
        )
        .map_err(|error| format!("Unable to cancel agent queue entry {queue_entry_id}: {error}"))?;

    get_agent_queue_entry(connection, queue_entry_id)
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
    entry: &AgentQueueEntry,
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

pub fn update_agent_runtime_dispatch_state(
    connection: &Connection,
    agent_id: &str,
    session_id: Option<&str>,
    runtime_cwd: Option<&str>,
    current_queue_entry_id: Option<&str>,
    status: &str,
    last_error: Option<&str>,
) -> Result<AgentRuntimeState, String> {
    update_agent_runtime_dispatch_state_for_project(
        connection,
        DEFAULT_PROJECT_ID,
        agent_id,
        session_id,
        runtime_cwd,
        current_queue_entry_id,
        status,
        last_error,
    )
}

pub fn update_agent_runtime_dispatch_state_for_project(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
    session_id: Option<&str>,
    runtime_cwd: Option<&str>,
    current_queue_entry_id: Option<&str>,
    status: &str,
    last_error: Option<&str>,
) -> Result<AgentRuntimeState, String> {
    let runtime_state = ensure_agent_runtime_state_for_project(connection, project_id, agent_id)?;
    let effective_project_id = runtime_state.project_id;
    let now = now_iso();

    connection
        .execute(
            r#"
            UPDATE agent_runtime_states
            SET status = ?3,
                main_session_id = COALESCE(?4, main_session_id),
                runtime_cwd = COALESCE(?5, runtime_cwd),
                current_queue_entry_id = ?6,
                last_dispatch_at = CASE WHEN ?6 IS NOT NULL THEN ?7 ELSE last_dispatch_at END,
                last_error = ?8,
                updated_at = ?7
            WHERE project_id = ?1 AND agent_id = ?2
            "#,
            params![
                effective_project_id,
                agent_id,
                status,
                session_id,
                runtime_cwd,
                current_queue_entry_id,
                now,
                last_error,
            ],
        )
        .map_err(|error| format!("Unable to update agent runtime state for {agent_id} in project {effective_project_id}: {error}"))?;

    get_agent_runtime_state_for_project(connection, &effective_project_id, agent_id)?
        .ok_or_else(|| format!("Agent runtime state for {agent_id} was not found after update"))
}

pub fn reconcile_agent_runtime_states(connection: &Connection) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            r#"
            UPDATE agent_runtime_states
            SET status = 'idle',
                current_queue_entry_id = NULL,
                updated_at = ?1
            WHERE status = 'running'
            "#,
            [now],
        )
        .map_err(|error| format!("Unable to reconcile agent runtime states: {error}"))?;
    Ok(())
}

fn build_agent_operations_snapshot(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
) -> Result<AgentOperationsSnapshot, String> {
    let agent = agents::get_agent(connection, agent_id)?;
    let runtime_state = ensure_agent_runtime_state_for_project(connection, project_id, agent_id)?;
    let queue_entries =
        list_agent_queue_entries_for_project(connection, project_id, Some(agent_id), false)?;

    Ok(AgentOperationsSnapshot {
        agent,
        runtime_state,
        queued_count: queue_entries
            .iter()
            .filter(|entry| entry.status == QUEUE_STATUS_QUEUED)
            .count() as i64,
        dispatched_count: queue_entries
            .iter()
            .filter(|entry| entry.status == QUEUE_STATUS_DISPATCHED)
            .count() as i64,
    })
}

fn normalize_agent_queue_entry_input(
    mut input: AgentQueueEntryInput,
) -> Result<AgentQueueEntryInput, String> {
    input.agent_id = input.agent_id.trim().to_string();
    input.source_type = normalize_string(input.source_type);
    input.source_task_id = normalize_optional(input.source_task_id);
    input.source_workflow_id = normalize_optional(input.source_workflow_id);
    input.source_lane_id = normalize_optional(input.source_lane_id);
    input.delivery_mode = normalize_string(input.delivery_mode);
    input.title = normalize_string(input.title);
    input.message = normalize_string(input.message);

    if input.agent_id.is_empty() {
        return Err("agentId: Agent id is required.".into());
    }
    if input.title.is_empty() {
        return Err("title: Queue entry title is required.".into());
    }
    if input.message.is_empty() {
        return Err("message: Queue entry message is required.".into());
    }
    if !matches!(
        input.delivery_mode.as_str(),
        "prompt" | "follow_up" | "steer"
    ) {
        return Err("deliveryMode: Must be one of prompt, follow_up, steer.".into());
    }
    Ok(input)
}

fn normalize_string(value: String) -> String {
    value.trim().to_string()
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn read_agent_runtime_state(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentRuntimeState> {
    Ok(AgentRuntimeState {
        project_id: row.get(0)?,
        agent_id: row.get(1)?,
        status: row.get(2)?,
        main_session_id: row.get(3)?,
        runtime_cwd: row.get(4)?,
        current_queue_entry_id: row.get(5)?,
        last_dispatch_at: row.get(6)?,
        last_error: row.get(7)?,
        terminal_attached: false,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn read_agent_queue_entry(row: &rusqlite::Row<'_>) -> rusqlite::Result<AgentQueueEntry> {
    Ok(AgentQueueEntry {
        id: row.get(0)?,
        project_id: row.get(1)?,
        agent_id: row.get(2)?,
        status: row.get(3)?,
        source_type: row.get(4)?,
        source_task_id: row.get(5)?,
        source_workflow_id: row.get(6)?,
        source_lane_id: row.get(7)?,
        delivery_mode: row.get(8)?,
        title: row.get(9)?,
        message: row.get(10)?,
        session_id: row.get(11)?,
        run_id: row.get(12)?,
        dispatched_at: row.get(13)?,
        completed_at: row.get(14)?,
        created_at: row.get(15)?,
        updated_at: row.get(16)?,
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{AgentUpsertInput, TaskUpsertInput, WorkflowLaneInput, WorkflowUpsertInput},
        services::{database, tasks, workflows},
    };
    use rusqlite::Connection;

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn create_agent(connection: &mut Connection) -> String {
        agents::create_agent(
            connection,
            AgentUpsertInput {
                name: "Worker".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create")
        .id
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
    fn ensures_runtime_state_once_per_agent() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);
        let first = ensure_agent_runtime_state(&connection, &agent_id).expect("runtime state");
        let second = ensure_agent_runtime_state(&connection, &agent_id).expect("runtime state");
        assert_eq!(first.agent_id, second.agent_id);
        assert_eq!(first.status, RUNTIME_STATUS_IDLE);
    }

    #[test]
    fn rejects_invalid_task_lane_agent_work() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let agent_id = create_agent(&mut connection);
        let agent = agents::get_agent(&connection, &agent_id).expect("agent should load");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Agent Queue Guard Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-agent-guard".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some(agent.slug.clone()),
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
                title: "Guard invalid agent queueing".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-agent-guard".into()),
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

        let error = enqueue_agent_work(
            &connection,
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "workflow_lane".into(),
                source_task_id: Some(task.id.clone()),
                source_workflow_id: Some(workflow.id.clone()),
                source_lane_id: Some("lane-agent-guard".into()),
                delivery_mode: "prompt".into(),
                title: "Invalid agent lane work".into(),
                message: "This should not queue.".into(),
            },
        )
        .expect_err("invalid task lane work should be rejected");
        assert!(error.contains("no longer valid"));
    }

    #[test]
    fn enqueues_agent_work_fifo() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);
        enqueue_agent_work(
            &connection,
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                delivery_mode: "prompt".into(),
                title: "First".into(),
                message: "Do the first thing".into(),
            },
        )
        .expect("first queue entry");
        enqueue_agent_work(
            &connection,
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                delivery_mode: "follow_up".into(),
                title: "Second".into(),
                message: "Do the second thing".into(),
            },
        )
        .expect("second queue entry");

        let entries =
            list_agent_queue_entries(&connection, Some(&agent_id), false).expect("queue entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "First");
        assert_eq!(entries[1].title, "Second");
    }

    #[test]
    fn project_scoped_agent_operations_are_isolated() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);

        // Create the required projects first
        let now = now_iso();
        for (project_id, task_prefix) in [("project-a", "TESTA"), ("project-b", "TESTB")] {
            connection
                .execute(
                    "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, ?4, NULL, ?5, ?5)",
                    params![project_id, project_id, project_id.to_uppercase(), task_prefix, now],
                )
                .expect("project should insert");
        }

        enqueue_agent_work_for_project(
            &connection,
            "project-a",
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                delivery_mode: "prompt".into(),
                title: "Project A work".into(),
                message: "Run in project A".into(),
            },
        )
        .expect("project a queue entry");
        ensure_agent_runtime_state_for_project(&connection, "project-b", &agent_id)
            .expect("project b runtime state");

        // Update the runtime state - for global agents this updates the single global state
        update_agent_runtime_dispatch_state_for_project(
            &connection,
            "orchestra", // Global agents always use the default project
            &agent_id,
            Some("session-global"),
            Some("/tmp/global"),
            None,
            "idle",
            None,
        )
        .expect("global runtime update");

        // Request operations for project-b - should get the same global state
        let project_a = get_agent_operations_for_project(&connection, "project-a", &agent_id)
            .expect("project a operations");
        let project_b = get_agent_operations_for_project(&connection, "project-b", &agent_id)
            .expect("project b operations");

        // Both projects should see the same runtime state (singleton behavior)
        assert_eq!(
            project_a.runtime_state.main_session_id.as_deref(),
            Some("session-global")
        );
        assert_eq!(
            project_b.runtime_state.main_session_id.as_deref(),
            Some("session-global")
        );
        assert_eq!(project_a.runtime_state.project_id, "orchestra");
        assert_eq!(project_b.runtime_state.project_id, "orchestra");
        // Queue entries are still per-project
        assert_eq!(project_a.queue_entries.len(), 1);
        assert!(project_b.queue_entries.is_empty());
    }

    #[test]
    fn claims_queue_entries_once() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);
        let queued = enqueue_agent_work(
            &connection,
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                delivery_mode: "prompt".into(),
                title: "Queued".into(),
                message: "Run me".into(),
            },
        )
        .expect("queue entry");

        let claimed = claim_next_agent_queue_entry(&connection, &agent_id, "session-1", "run-1")
            .expect("claim should succeed")
            .expect("entry should be claimed");
        assert_eq!(claimed.id, queued.id);
        assert_eq!(claimed.status, QUEUE_STATUS_DISPATCHED);

        let second = claim_next_agent_queue_entry(&connection, &agent_id, "session-1", "run-2")
            .expect("second claim should succeed");
        assert!(second.is_none());
    }

    #[test]
    fn deletes_only_queued_agent_queue_entries() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);
        let queued = enqueue_agent_work(
            &connection,
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                delivery_mode: "follow_up".into(),
                title: "Queued".into(),
                message: "Delete me".into(),
            },
        )
        .expect("queued entry");

        let deleted =
            delete_agent_queue_entry(&connection, &queued.id).expect("queued entry should delete");
        assert_eq!(deleted.id, queued.id);
        assert!(
            list_agent_queue_entries(&connection, Some(&agent_id), false)
                .expect("queue entries should load")
                .is_empty()
        );

        let dispatched = enqueue_agent_work(
            &connection,
            AgentQueueEntryInput {
                agent_id: agent_id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                delivery_mode: "prompt".into(),
                title: "Dispatched".into(),
                message: "Do not delete me".into(),
            },
        )
        .expect("dispatched seed entry");
        let _ =
            mark_agent_queue_entry_dispatched(&connection, &dispatched.id, "session-1", "run-1")
                .expect("dispatch should succeed")
                .expect("entry should dispatch");

        let error = delete_agent_queue_entry(&connection, &dispatched.id)
            .expect_err("dispatched entry should not be deletable");
        assert!(error.contains("cannot be deleted unless it is queued"));
    }

    #[test]
    fn global_agents_have_single_runtime_state_across_projects() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);

        let agent = agents::get_agent(&connection, &agent_id).expect("agent should load");
        assert_eq!(agent.scope, "global", "Test agent should be global");

        let state_a = ensure_agent_runtime_state_for_project(&connection, "project-a", &agent_id)
            .expect("project a runtime state");
        let state_b = ensure_agent_runtime_state_for_project(&connection, "project-b", &agent_id)
            .expect("project b runtime state");
        let state_c = ensure_agent_runtime_state_for_project(&connection, "project-c", &agent_id)
            .expect("project c runtime state");

        assert_eq!(state_a.project_id, "orchestra");
        assert_eq!(state_b.project_id, "orchestra");
        assert_eq!(state_c.project_id, "orchestra");
        assert_eq!(state_a.agent_id, state_b.agent_id);
        assert_eq!(state_b.agent_id, state_c.agent_id);
        assert_eq!(state_a.project_id, state_b.project_id);
        assert_eq!(state_b.project_id, state_c.project_id);

        let all_states = connection
            .prepare("SELECT COUNT(*) FROM agent_runtime_states WHERE agent_id = ?1")
            .expect("query should prepare")
            .query_map([&agent_id], |row| row.get::<_, i64>(0))
            .expect("query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("rows should collect");
        assert_eq!(
            all_states,
            vec![1],
            "Should have exactly one runtime state for global agent"
        );
    }

    #[test]
    fn updating_global_agent_runtime_state_uses_singleton_runtime_row() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);

        let updated = update_agent_runtime_dispatch_state_for_project(
            &connection,
            "project-a",
            &agent_id,
            Some("session-123"),
            None,
            None,
            "",
            None,
        )
        .expect("global runtime update should succeed");

        assert_eq!(updated.project_id, "orchestra");
        assert_eq!(updated.main_session_id.as_deref(), Some("session-123"));
        assert!(
            get_agent_runtime_state_for_project(&connection, "project-a", &agent_id)
                .expect("project runtime lookup should succeed")
                .is_none(),
            "global agents should not get project-scoped runtime rows on update",
        );
    }
}
