use std::collections::HashSet;

use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::TaskLaneAssignment,
    services::{session_records, task_runtime},
};

pub const SESSION_HIDDEN_REASON_USER_DISMISSED: &str = "user_dismissed";
pub const SESSION_HIDDEN_REASON_TASK_COMPLETED: &str = "task_completed";
pub const SESSION_HIDDEN_REASON_TASK_CANCELED: &str = "task_canceled";
pub const SESSION_HIDDEN_REASON_STALE_ROLE_SESSION: &str = "stale_role_session";
pub const SESSION_HIDDEN_REASON_SUPERSEDED: &str = "superseded";

const DISMISSED_SESSION_RETENTION_DAYS: i64 = 30;

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum SessionListVisibility {
    Active,
    Closed,
    Unchanged,
    Hidden(String),
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct SessionListDecoration {
    pub task_id: Option<String>,
    pub task_project_id: Option<String>,
    pub task_number: Option<String>,
    pub task_title: Option<String>,
    pub active_task_id: Option<String>,
    pub active_task_project_id: Option<String>,
    pub active_task_number: Option<String>,
    pub active_task_title: Option<String>,
    pub worker_type: Option<String>,
    pub worker_name: Option<String>,
    pub persistent_agent_session: bool,
    pub visibility: Option<SessionListVisibility>,
}

#[derive(Debug, Clone, Default)]
struct HistoricalSessionBinding {
    current_task_id: Option<String>,
    task_id: Option<String>,
    task_project_id: Option<String>,
    task_number: Option<String>,
    task_title: Option<String>,
    task_status: Option<String>,
    assignment_status: Option<String>,
    worker_type: Option<String>,
    worker_name: Option<String>,
}

pub fn load_hidden_session_ids(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM sessions
            WHERE hidden_reason IS NOT NULL OR dismissed_at IS NOT NULL OR list_visibility = 'hidden'
            "#,
        )
        .map_err(|error| format!("Unable to prepare canonical hidden session query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query canonical hidden sessions: {error}"))?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to read canonical hidden session ids: {error}"))
}

pub fn hide_session_from_normal_list(reason: Option<&str>, dismissed_at: Option<&str>) -> bool {
    dismissed_at.is_some()
        || matches!(
            reason,
            Some(SESSION_HIDDEN_REASON_USER_DISMISSED | SESSION_HIDDEN_REASON_STALE_ROLE_SESSION)
        )
}

pub fn load_hidden_session_reason(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT COALESCE(hidden_reason, CASE WHEN dismissed_at IS NOT NULL THEN ?2 ELSE NULL END)
            FROM sessions
            WHERE id = ?1
            LIMIT 1
            "#,
            params![session_id, SESSION_HIDDEN_REASON_USER_DISMISSED],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query canonical hidden session reason for {session_id}: {error}")
        })
        .map(|value| value.flatten())
}

pub fn hide_session(connection: &Connection, session_id: &str, reason: &str) -> Result<(), String> {
    let now = crate::state::now_iso();
    let updated = connection
        .execute(
            r#"
            UPDATE sessions
            SET hidden_reason = ?2,
                dismissed_at = ?3,
                list_visibility = 'hidden',
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![session_id, reason, now],
        )
        .map_err(|error| {
            format!("Unable to update canonical hidden state for {session_id}: {error}")
        })?;
    if updated == 0 {
        return Err(format!(
            "Session {session_id} is missing its canonical session row; run reconcile_sessions before hiding it"
        ));
    }
    Ok(())
}

pub fn dismiss_session(connection: &Connection, session_id: &str) -> Result<(), String> {
    hide_session(connection, session_id, SESSION_HIDDEN_REASON_USER_DISMISSED)
}

pub fn restore_user_dismissed_session(
    connection: &Connection,
    session_id: &str,
) -> Result<(), String> {
    match load_hidden_session_reason(connection, session_id)? {
        Some(reason) if reason != SESSION_HIDDEN_REASON_USER_DISMISSED => Err(format!(
            "Session {session_id} was auto-archived ({reason}) and cannot be resumed from the session list"
        )),
        _ => {
            let now = crate::state::now_iso();
            let updated = connection
                .execute(
                    r#"
                    UPDATE sessions
                    SET hidden_reason = NULL,
                        dismissed_at = NULL,
                        list_visibility = CASE
                            WHEN lifecycle_state = 'active' THEN 'active'
                            ELSE 'closed'
                        END,
                        updated_at = ?2
                    WHERE id = ?1
                    "#,
                    params![session_id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to restore canonical session visibility for {session_id}: {error}"
                    )
                })?;
            if updated == 0 {
                return Err(format!(
                    "Session {session_id} is missing its canonical session row; run reconcile_sessions before restoring it"
                ));
            }
            Ok(())
        }
    }
}

pub fn cleanup_user_dismissed_sessions(connection: &Connection) -> Result<Vec<String>, String> {
    let cutoff = (Utc::now() - Duration::days(DISMISSED_SESSION_RETENTION_DAYS)).to_rfc3339();
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM sessions
            WHERE dismissed_at IS NOT NULL
              AND dismissed_at <= ?1
              AND COALESCE(hidden_reason, ?2) = ?2
            "#,
        )
        .map_err(|error| format!("Unable to prepare dismissed session cleanup query: {error}"))?;
    let rows = statement
        .query_map(
            params![cutoff, SESSION_HIDDEN_REASON_USER_DISMISSED],
            |row| row.get::<_, String>(0),
        )
        .map_err(|error| {
            format!("Unable to query dismissed session cleanup candidates: {error}")
        })?;
    let session_ids = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read dismissed session cleanup candidates: {error}"))?;

    for session_id in &session_ids {
        connection
            .execute(
                r#"
                UPDATE sessions
                SET hidden_reason = NULL,
                    dismissed_at = NULL,
                    list_visibility = CASE
                        WHEN lifecycle_state = 'active' THEN 'active'
                        ELSE 'closed'
                    END,
                    updated_at = ?2
                WHERE id = ?1
                "#,
                params![session_id, crate::state::now_iso()],
            )
            .map_err(|error| {
                format!(
                    "Unable to clear canonical dismissed session visibility for {session_id}: {error}"
                )
            })?;
    }

    Ok(session_ids)
}

pub fn auto_archive_session_for_task_status(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
    task_status: &str,
) -> Result<Option<String>, String> {
    if !matches!(assignment.worker_type.as_str(), "agent" | "role") {
        return Ok(None);
    }
    let Some(session_id) = assignment.session_id.as_deref() else {
        return Ok(None);
    };

    let canonical_row = session_records::load_session_row(connection, session_id)?;
    if canonical_row.as_ref().is_some_and(|row| {
        row.session_kind == session_records::SESSION_KIND_AGENT_MAIN
            && row.task_id.is_none()
            && row.primary_assignment_id.is_none()
    }) {
        return Ok(None);
    }

    if assignment.worker_type == "agent"
        && assignment
            .worker_id
            .as_deref()
            .is_some_and(|agent_id| {
                canonical_row.as_ref().is_some_and(|row| {
                    row.task_id.is_none()
                        && row.primary_assignment_id.is_none()
                        && connection
                            .query_row(
                                "SELECT 1 FROM agent_runtime_states WHERE agent_id = ?1 AND main_session_id = ?2 LIMIT 1",
                                params![agent_id, session_id],
                                |_| Ok(()),
                            )
                            .optional()
                            .ok()
                            .flatten()
                            .is_some()
                })
            })
    {
        return Ok(None);
    }

    if let Some(reason) = load_hidden_session_reason(connection, session_id)? {
        return Ok(Some(reason));
    }

    let reason = match task_status {
        "completed" => Some(SESSION_HIDDEN_REASON_TASK_COMPLETED),
        "canceled" => Some(SESSION_HIDDEN_REASON_TASK_CANCELED),
        _ => None,
    };

    if let Some(reason) = reason {
        hide_session(connection, session_id, reason)?;
        return Ok(Some(reason.to_string()));
    }

    Ok(None)
}

fn load_active_task_metadata(
    connection: &Connection,
    session_id: &str,
) -> Result<
    (
        (
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ),
        bool,
    ),
    String,
> {
    if let Some(metadata) = connection
        .query_row(
            r#"
            SELECT t.id, t.project_id, t.number, t.title
            FROM sessions s
            JOIN task_lane_assignments tla ON tla.id = s.assignment_id
            JOIN tasks t ON t.id = tla.task_id
            WHERE s.id = ?1
              AND tla.status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
              AND t.status NOT IN ('completed', 'canceled')
              AND (t.current_lane_id IS NULL OR tla.lane_id = t.current_lane_id)
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to load canonical active task metadata {session_id}: {error}")
        })?
    {
        return Ok((metadata, true));
    }

    let active_assignment =
        task_runtime::get_active_assignment_for_session(connection, session_id)?;
    let metadata = active_assignment
        .as_ref()
        .map(|assignment| load_task_metadata(connection, &assignment.task_id))
        .transpose()?
        .flatten()
        .unwrap_or((None, None, None, None));
    Ok((metadata, active_assignment.is_some()))
}

pub fn load_session_list_decoration(
    connection: &Connection,
    session_id: &str,
) -> Result<SessionListDecoration, String> {
    let (active_task_metadata, has_active_assignment) =
        load_active_task_metadata(connection, session_id)?;
    let mut historical_binding = load_historical_session_binding(connection, session_id)?;
    if historical_binding.task_id.is_none() {
        if let Some(lane_run_binding) = load_lane_run_session_binding(connection, session_id)? {
            historical_binding = lane_run_binding;
        }
    }
    let persistent_agent_name = load_persistent_agent_name(connection, session_id)?;
    let role_binding_name = load_role_binding_name(connection, session_id)?;

    let mut decoration = SessionListDecoration {
        task_id: historical_binding.task_id.clone(),
        task_project_id: historical_binding.task_project_id.clone(),
        task_number: historical_binding.task_number.clone(),
        task_title: historical_binding.task_title.clone(),
        active_task_id: active_task_metadata.0,
        active_task_project_id: active_task_metadata.1,
        active_task_number: active_task_metadata.2,
        active_task_title: active_task_metadata.3,
        worker_type: historical_binding
            .worker_type
            .clone()
            .or_else(|| persistent_agent_name.as_ref().map(|_| "agent".to_string()))
            .or_else(|| role_binding_name.as_ref().map(|_| "role".to_string())),
        worker_name: historical_binding
            .worker_name
            .clone()
            .or(persistent_agent_name.clone())
            .or(role_binding_name.clone()),
        persistent_agent_session: persistent_agent_name.is_some(),
        visibility: None,
    };

    let visibility = classify_session_visibility(
        connection,
        session_id,
        has_active_assignment,
        &historical_binding,
        persistent_agent_name.as_ref(),
        role_binding_name.as_ref(),
    )?;
    decoration.visibility = Some(visibility);
    Ok(decoration)
}

fn classify_session_visibility(
    connection: &Connection,
    session_id: &str,
    has_active_assignment: bool,
    historical_binding: &HistoricalSessionBinding,
    persistent_agent_name: Option<&String>,
    role_binding_name: Option<&String>,
) -> Result<SessionListVisibility, String> {
    if let Some(reason) = load_hidden_session_reason(connection, session_id)? {
        return Ok(SessionListVisibility::Hidden(reason));
    }

    if has_active_assignment {
        return Ok(SessionListVisibility::Active);
    }

    let persistent_agent_session = persistent_agent_name.is_some();
    if persistent_agent_session {
        return Ok(SessionListVisibility::Unchanged);
    }

    match historical_binding.task_status.as_deref() {
        Some("completed") | Some("canceled") | Some(_) => {
            if historical_binding.task_id.is_some() {
                return Ok(SessionListVisibility::Closed);
            }
        }
        None => {}
    }

    if historical_binding.worker_type.as_deref() == Some("role")
        && historical_binding.task_id.is_none()
    {
        hide_session(
            connection,
            session_id,
            SESSION_HIDDEN_REASON_STALE_ROLE_SESSION,
        )?;
        return Ok(SessionListVisibility::Hidden(
            SESSION_HIDDEN_REASON_STALE_ROLE_SESSION.to_string(),
        ));
    }

    if role_binding_name.is_some() && historical_binding.task_id.is_none() {
        hide_session(
            connection,
            session_id,
            SESSION_HIDDEN_REASON_STALE_ROLE_SESSION,
        )?;
        return Ok(SessionListVisibility::Hidden(
            SESSION_HIDDEN_REASON_STALE_ROLE_SESSION.to_string(),
        ));
    }

    if historical_binding.task_id.is_some() {
        return Ok(SessionListVisibility::Closed);
    }

    if persistent_agent_name.is_some() {
        return Ok(SessionListVisibility::Unchanged);
    }

    Ok(SessionListVisibility::Unchanged)
}

fn load_task_metadata(
    connection: &Connection,
    task_id: &str,
) -> Result<
    Option<(
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    )>,
    String,
> {
    connection
        .query_row(
            r#"
            SELECT id, project_id, number, title
            FROM tasks
            WHERE id = ?1
            LIMIT 1
            "#,
            [task_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task metadata {task_id}: {error}"))
}

fn load_historical_session_binding(
    connection: &Connection,
    session_id: &str,
) -> Result<HistoricalSessionBinding, String> {
    let mut binding = connection
        .query_row(
            r#"
            SELECT
                s.task_id,
                COALESCE(s.task_id, s.primary_task_id),
                t.project_id,
                t.number,
                t.title,
                t.status,
                tla.status,
                COALESCE(s.worker_type, s.owner_worker_type),
                CASE
                    WHEN COALESCE(s.worker_type, s.owner_worker_type) = 'agent' THEN a.name
                    WHEN COALESCE(s.worker_type, s.owner_worker_type) = 'role' THEN r.name
                    WHEN COALESCE(s.worker_type, s.owner_worker_type) = 'user' THEN 'User'
                    ELSE NULL
                END AS worker_name
            FROM sessions s
            LEFT JOIN tasks t ON t.id = COALESCE(s.task_id, s.primary_task_id)
            LEFT JOIN task_lane_assignments tla ON tla.id = COALESCE(s.assignment_id, s.primary_assignment_id)
            LEFT JOIN agents a ON COALESCE(s.worker_type, s.owner_worker_type) = 'agent'
                AND a.id = COALESCE(s.worker_id, s.owner_worker_id, s.agent_id)
            LEFT JOIN roles r ON COALESCE(s.worker_type, s.owner_worker_type) = 'role'
                AND r.id = COALESCE(s.worker_id, s.owner_worker_id, s.role_id)
            WHERE s.id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok(HistoricalSessionBinding {
                    current_task_id: row.get::<_, Option<String>>(0)?,
                    task_id: row.get::<_, Option<String>>(1)?,
                    task_project_id: row.get::<_, Option<String>>(2)?,
                    task_number: row.get::<_, Option<String>>(3)?,
                    task_title: row.get::<_, Option<String>>(4)?,
                    task_status: row.get::<_, Option<String>>(5)?,
                    assignment_status: row.get::<_, Option<String>>(6)?,
                    worker_type: row.get::<_, Option<String>>(7)?,
                    worker_name: row.get::<_, Option<String>>(8)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load canonical session list metadata {session_id}: {error}"))?
        .unwrap_or_default();

    let fallback = connection
        .query_row(
            r#"
            SELECT
                tla.task_id,
                t.project_id,
                t.number,
                t.title,
                t.status,
                tla.status,
                tla.worker_type,
                CASE
                    WHEN tla.worker_type = 'agent' THEN a.name
                    WHEN tla.worker_type = 'role' THEN r.name
                    WHEN tla.worker_type = 'user' THEN 'User'
                    ELSE NULL
                END AS worker_name
            FROM task_lane_assignments tla
            LEFT JOIN tasks t ON t.id = tla.task_id
            LEFT JOIN agents a ON tla.worker_type = 'agent' AND a.id = tla.worker_id
            LEFT JOIN roles r ON tla.worker_type = 'role' AND r.id = tla.worker_id
            WHERE tla.session_id = ?1
            ORDER BY
                CASE tla.status
                    WHEN 'active' THEN 0
                    WHEN 'awaiting_user_approval' THEN 1
                    WHEN 'awaiting_user_intervention' THEN 2
                    WHEN 'paused_by_user' THEN 3
                    WHEN 'queued' THEN 4
                    ELSE 5
                END,
                COALESCE(tla.completed_at, tla.updated_at, tla.created_at) DESC,
                tla.id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok(HistoricalSessionBinding {
                    current_task_id: row.get::<_, Option<String>>(0)?,
                    task_id: row.get::<_, Option<String>>(0)?,
                    task_project_id: row.get::<_, Option<String>>(1)?,
                    task_number: row.get::<_, Option<String>>(2)?,
                    task_title: row.get::<_, Option<String>>(3)?,
                    task_status: row.get::<_, Option<String>>(4)?,
                    assignment_status: row.get::<_, Option<String>>(5)?,
                    worker_type: row.get::<_, Option<String>>(6)?,
                    worker_name: row.get::<_, Option<String>>(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load session list metadata {session_id}: {error}"))?
        .unwrap_or_default();

    if binding.current_task_id.is_none() {
        binding.current_task_id = fallback.current_task_id;
    }
    if binding.task_id.is_none() {
        binding.task_id = fallback.task_id;
    }
    if binding.task_project_id.is_none() {
        binding.task_project_id = fallback.task_project_id;
    }
    if binding.task_number.is_none() {
        binding.task_number = fallback.task_number;
    }
    if binding.task_title.is_none() {
        binding.task_title = fallback.task_title;
    }
    if binding.task_status.is_none() {
        binding.task_status = fallback.task_status;
    }
    if binding.assignment_status.is_none() {
        binding.assignment_status = fallback.assignment_status;
    }
    if binding.worker_type.is_none() {
        binding.worker_type = fallback.worker_type;
    }
    if binding.worker_name.is_none() {
        binding.worker_name = fallback.worker_name;
    }

    Ok(binding)
}

fn load_lane_run_session_binding(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<HistoricalSessionBinding>, String> {
    connection
        .query_row(
            r#"
            SELECT
                lr.task_id,
                t.project_id,
                t.number,
                t.title,
                t.status
            FROM task_lane_runs lr
            LEFT JOIN tasks t ON t.id = lr.task_id
            WHERE lr.session_id = ?1
            ORDER BY COALESCE(lr.completed_at, lr.started_at) DESC, lr.id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok(HistoricalSessionBinding {
                    current_task_id: row.get::<_, Option<String>>(0)?,
                    task_id: row.get::<_, Option<String>>(0)?,
                    task_project_id: row.get::<_, Option<String>>(1)?,
                    task_number: row.get::<_, Option<String>>(2)?,
                    task_title: row.get::<_, Option<String>>(3)?,
                    task_status: row.get::<_, Option<String>>(4)?,
                    assignment_status: None,
                    worker_type: None,
                    worker_name: None,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load lane-run session metadata {session_id}: {error}"))
}

fn load_persistent_agent_name(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    if let Some(row) = session_records::load_session_row(connection, session_id)? {
        if row.session_kind == session_records::SESSION_KIND_AGENT_MAIN || row.task_id.is_none() {
            if let Some(agent_id) = row.agent_id.as_deref().or(row.effective_worker_id()) {
                let agent_name = connection
                    .query_row(
                        "SELECT name FROM agents WHERE id = ?1 LIMIT 1",
                        [agent_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!(
                            "Unable to load canonical agent session metadata {session_id}: {error}"
                        )
                    })?
                    .flatten();
                if agent_name.is_some() {
                    return Ok(agent_name);
                }
            }
        }
    }

    connection
        .query_row(
            r#"
            SELECT a.name
            FROM agent_runtime_states ars
            JOIN agents a ON a.id = ars.agent_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load agent session metadata {session_id}: {error}"))
        .map(|value| value.flatten())
}

fn load_role_binding_name(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    if let Some(row) = session_records::load_session_row(connection, session_id)? {
        if row.task_id.is_none() {
            if let Some(role_id) = row.role_id.as_deref().or(row.effective_worker_id()) {
                let role_name = connection
                    .query_row(
                        "SELECT name FROM roles WHERE id = ?1 LIMIT 1",
                        [role_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!(
                            "Unable to load canonical role session metadata {session_id}: {error}"
                        )
                    })?
                    .flatten();
                if role_name.is_some() {
                    return Ok(role_name);
                }
            }
        }
    }

    connection
        .query_row(
            r#"
            SELECT r.name
            FROM role_instances ri
            JOIN roles r ON r.id = ri.role_id
            WHERE ri.session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to load role session metadata {session_id}: {error}"))
        .map(|value| value.flatten())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;

    #[test]
    fn detached_persistent_agent_session_stays_visible_after_completed_task() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'ORC', NULL, ?4, ?4)",
                params!["project-1", "project-1", "Project 1", "2026-03-21T00:00:00Z"],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 'off', '[]', 0, 0, 0, ?4, ?4)",
                params!["agent-1", "agent-1", "Agent 1", "2026-03-21T00:00:00Z"],
            )
            .expect("agent should insert");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES (?1, ?2, 1, ?3, ?4, NULL, 'task', 'completed', 'P1', NULL, NULL, 'agent', ?5, NULL, NULL, 0, ?6, ?6)",
                params![
                    "task-1",
                    "project-1",
                    "ORC-1",
                    "Completed task",
                    "agent-1",
                    "2026-03-21T00:00:00Z"
                ],
            )
            .expect("task should insert");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, task_id, primary_task_id, worker_type, worker_id, owner_worker_type, owner_worker_id, agent_id, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, ?2, ?3, ?3, ?4, 'agent_main', 'active', 'active', NULL, ?5, 'agent', 'agent-1', 'agent', 'agent-1', 'agent-1', 0, 'active', ?6, ?6)",
                params![
                    "session-1",
                    "project-1",
                    "/tmp/session-1.jsonl",
                    "Agent 1 main session",
                    "task-1",
                    "2026-03-21T00:00:00Z"
                ],
            )
            .expect("session should insert");

        let decoration = load_session_list_decoration(&connection, "session-1")
            .expect("session decoration should load");

        assert!(decoration.persistent_agent_session);
        assert_eq!(
            decoration.visibility,
            Some(SessionListVisibility::Unchanged)
        );
        assert_eq!(
            load_hidden_session_reason(&connection, "session-1")
                .expect("hidden reason should load"),
            None
        );
    }

    #[test]
    fn task_bound_persistent_agent_session_stays_visible_after_completed_task() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'ORC', NULL, ?4, ?4)",
                params!["project-1", "project-1", "Project 1", "2026-03-21T00:00:00Z"],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, ?3, 'off', '[]', 0, 0, 0, ?4, ?4)",
                params!["agent-1", "agent-1", "Agent 1", "2026-03-21T00:00:00Z"],
            )
            .expect("agent should insert");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES (?1, ?2, 'idle', ?3, '/tmp/runtime', NULL, NULL, NULL, ?4, ?4)",
                params!["project-1", "agent-1", "session-1", "2026-03-21T00:00:00Z"],
            )
            .expect("agent runtime should insert");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, archived, created_at, updated_at) VALUES (?1, ?2, 1, ?3, ?4, NULL, 'task', 'completed', 'P1', NULL, NULL, 'agent', ?5, NULL, NULL, 0, ?6, ?6)",
                params![
                    "task-1",
                    "project-1",
                    "ORC-1",
                    "Completed task",
                    "agent-1",
                    "2026-03-21T00:00:00Z"
                ],
            )
            .expect("task should insert");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, task_id, primary_task_id, worker_type, worker_id, owner_worker_type, owner_worker_id, agent_id, transcript_exists, lifecycle_state, created_at, updated_at) VALUES (?1, ?2, ?3, ?3, ?4, 'agent_main', 'active', 'active', ?5, ?5, 'agent', 'agent-1', 'agent', 'agent-1', 'agent-1', 0, 'active', ?6, ?6)",
                params![
                    "session-1",
                    "project-1",
                    "/tmp/session-1.jsonl",
                    "Agent 1 main session",
                    "task-1",
                    "2026-03-21T00:00:00Z"
                ],
            )
            .expect("session should insert");

        let decoration = load_session_list_decoration(&connection, "session-1")
            .expect("session decoration should load");

        assert!(decoration.persistent_agent_session);
        assert_eq!(decoration.task_id.as_deref(), Some("task-1"));
        assert_eq!(
            decoration.visibility,
            Some(SessionListVisibility::Unchanged)
        );
        assert_eq!(
            load_hidden_session_reason(&connection, "session-1")
                .expect("hidden reason should load"),
            None
        );
    }

    #[test]
    fn auto_archive_skips_agent_main_sessions_even_after_task_completion() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");

        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'ORC', NULL, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', 'off', '[]', 0, 0, 0, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("agent should insert");
        connection
            .execute(
                "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, worker_type, worker_id, owner_worker_type, owner_worker_id, agent_id, transcript_exists, lifecycle_state, created_at, updated_at) VALUES ('session-1', 'project-1', '/tmp/session-1.jsonl', '/tmp/session-1.jsonl', 'Agent 1 main session', 'agent_main', 'active', 'active', 'agent', 'agent-1', 'agent', 'agent-1', 'agent-1', 0, 'active', '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("session should insert");
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-1', 'agent-1', 'idle', 'session-1', '/tmp/runtime', NULL, NULL, NULL, '2026-03-21T00:00:00Z', '2026-03-21T00:00:00Z')",
                [],
            )
            .expect("agent runtime should insert");

        let assignment = TaskLaneAssignment {
            id: "assignment-1".into(),
            task_id: "task-1".into(),
            workflow_id: "workflow-1".into(),
            lane_id: "lane-1".into(),
            worker_type: "agent".into(),
            worker_id: Some("agent-1".into()),
            status: "completed".into(),
            session_id: Some("session-1".into()),
            runtime_cwd: Some("/tmp/runtime".into()),
            role_queue_entry_id: None,
            role_instance_id: None,
            prompt: None,
            pending_outcome: None,
            completion_notes: None,
            whip_count: 0,
            last_whip_at: None,
            started_at: "2026-03-21T00:00:00Z".into(),
            completed_at: Some("2026-03-21T00:01:00Z".into()),
            created_at: "2026-03-21T00:00:00Z".into(),
            updated_at: "2026-03-21T00:01:00Z".into(),
        };

        assert_eq!(
            auto_archive_session_for_task_status(&connection, &assignment, "completed")
                .expect("auto archive should succeed"),
            None
        );
        assert_eq!(
            load_hidden_session_reason(&connection, "session-1")
                .expect("hidden reason should load"),
            None
        );
    }
}
