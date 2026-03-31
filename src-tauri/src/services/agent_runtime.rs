use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        AgentOperationsDetail, AgentOperationsSnapshot, AgentQueueEntry, AgentQueueEntryInput,
        AgentRuntimeState,
    },
    services::agents,
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
    let agents = agents::list_agents(connection, include_archived)?;
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
    let agent = agents::get_agent(connection, agent_id)?;
    let runtime_state = ensure_agent_runtime_state_for_project(connection, project_id, agent_id)?;
    let queue_entries = list_agent_queue_entries_for_project(connection, project_id, Some(agent_id), false)?;

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
    if let Some(existing) = get_agent_runtime_state_for_project(connection, project_id, agent_id)? {
        return Ok(existing);
    }

    let now = now_iso();
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
            VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, NULL, ?4, ?4)
            "#,
            params![project_id, agent_id, RUNTIME_STATUS_IDLE, now],
        )
        .map_err(|error| format!("Unable to create agent runtime state for {agent_id} in project {project_id}: {error}"))?;

    get_agent_runtime_state_for_project(connection, project_id, agent_id)?
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
        .prepare(if agent_id.is_some() { sql_for_agent } else { sql_all })
        .map_err(|error| format!("Unable to prepare agent queue query: {error}"))?;

    let rows = if let Some(agent_id) = agent_id {
        statement
            .query_map(params![project_id, agent_id], read_agent_queue_entry)
            .map_err(|error| format!("Unable to query agent queue entries for {agent_id} in project {project_id}: {error}"))?
    } else {
        statement
            .query_map(params![project_id], read_agent_queue_entry)
            .map_err(|error| format!("Unable to query agent queue entries for project {project_id}: {error}"))?
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
    let agent = agents::get_agent(connection, &normalized.agent_id)?;
    if agent.archived {
        return Err(format!("Agent {} is archived and cannot accept runtime work", agent.name));
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
        .map_err(|error| format!("Unable to enqueue agent work in project {project_id}: {error}"))?;

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
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
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
        .map_err(|error| format!("Unable to mark agent queue entry {queue_entry_id} dispatched: {error}"))?;

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
        .map_err(|error| format!("Unable to query next agent queue entry for {agent_id}: {error}"))?;

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
        return Err(format!("Agent queue entry {queue_entry_id} could not be deleted"));
    }

    Ok(entry)
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
                project_id,
                agent_id,
                status,
                session_id,
                runtime_cwd,
                current_queue_entry_id,
                now,
                last_error,
            ],
        )
        .map_err(|error| format!("Unable to update agent runtime state for {agent_id} in project {project_id}: {error}"))?;

    get_agent_runtime_state_for_project(connection, project_id, agent_id)?
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
    let queue_entries = list_agent_queue_entries_for_project(connection, project_id, Some(agent_id), false)?;

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
    if !matches!(input.delivery_mode.as_str(), "prompt" | "follow_up" | "steer") {
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
    use crate::{models::AgentUpsertInput, services::database};
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
                thinking_level: Some("medium".into()),
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("agent should create")
        .id
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

        let entries = list_agent_queue_entries(&connection, Some(&agent_id), false).expect("queue entries");
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[0].title, "First");
        assert_eq!(entries[1].title, "Second");
    }

    #[test]
    fn project_scoped_agent_operations_are_isolated() {
        let mut connection = in_memory_connection();
        let agent_id = create_agent(&mut connection);
        let now = now_iso();

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
        update_agent_runtime_dispatch_state_for_project(
            &connection,
            "project-a",
            &agent_id,
            Some("session-project-a"),
            Some("/tmp/project-a"),
            None,
            "idle",
            None,
        )
        .expect("project a runtime update");
        update_agent_runtime_dispatch_state_for_project(
            &connection,
            "project-b",
            &agent_id,
            Some("session-project-b"),
            Some("/tmp/project-b"),
            None,
            "idle",
            Some(&format!("updated-{now}")),
        )
        .expect("project b runtime update");

        let project_a = get_agent_operations_for_project(&connection, "project-a", &agent_id)
            .expect("project a operations");
        let project_b = get_agent_operations_for_project(&connection, "project-b", &agent_id)
            .expect("project b operations");

        assert_eq!(project_a.runtime_state.main_session_id.as_deref(), Some("session-project-a"));
        assert_eq!(project_b.runtime_state.main_session_id.as_deref(), Some("session-project-b"));
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

        let deleted = delete_agent_queue_entry(&connection, &queued.id).expect("queued entry should delete");
        assert_eq!(deleted.id, queued.id);
        assert!(list_agent_queue_entries(&connection, Some(&agent_id), false)
            .expect("queue entries should load")
            .is_empty());

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
        let _ = mark_agent_queue_entry_dispatched(&connection, &dispatched.id, "session-1", "run-1")
            .expect("dispatch should succeed")
            .expect("entry should dispatch");

        let error = delete_agent_queue_entry(&connection, &dispatched.id)
            .expect_err("dispatched entry should not be deletable");
        assert!(error.contains("cannot be deleted unless it is queued"));
    }
}
