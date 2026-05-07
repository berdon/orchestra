use rusqlite::{Connection, OptionalExtension};

use crate::{
    models::{AuthorizationContext, TaskLaneAssignment},
    services::{pi_sessions, projects, task_runtime},
};

pub const CONTEXT_SOURCE_TASK_ASSIGNMENT: &str = "task_assignment";
pub const CONTEXT_SOURCE_TASK_SESSION: &str = "task_session";
pub const CONTEXT_SOURCE_AGENT_MAIN_SESSION: &str = "agent_main_session";
pub const CONTEXT_SOURCE_ROLE_INSTANCE_SESSION: &str = "role_instance_session";
pub const CONTEXT_SOURCE_PROJECT_SESSION: &str = "project_session";

const ACTOR_AGENT: &str = "agent";
const ACTOR_ROLE_INSTANCE: &str = "role_instance";
const ACTOR_USER: &str = "user";
const DEFAULT_USER_ID: &str = "desktop-user";
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SessionWorkerContext {
    pub session_id: String,
    pub project_id: String,
    pub task_id: Option<String>,
    pub workflow_id: Option<String>,
    pub workflow_lane_id: Option<String>,
    pub current_assignment_id: Option<String>,
    pub primary_assignment_id: Option<String>,
    pub lane_worker_type: Option<String>,
    pub lane_worker_id: Option<String>,
    pub owner_worker_type: Option<String>,
    pub owner_worker_id: Option<String>,
    pub agent_id: Option<String>,
    pub role_id: Option<String>,
    pub role_instance_id: Option<String>,
    pub runtime_cwd: Option<String>,
    pub context_source: String,
}

#[derive(Debug, Clone)]
struct SessionRow {
    project_id: Option<String>,
    task_id: Option<String>,
    assignment_id: Option<String>,
    primary_task_id: Option<String>,
    primary_workflow_id: Option<String>,
    primary_lane_id: Option<String>,
    primary_assignment_id: Option<String>,
    worker_type: Option<String>,
    worker_id: Option<String>,
    owner_worker_type: Option<String>,
    owner_worker_id: Option<String>,
    agent_id: Option<String>,
    role_id: Option<String>,
    role_instance_id: Option<String>,
    runtime_cwd: Option<String>,
}

pub fn load_session_project_id(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    if let Some(project_id) =
        load_session_row(connection, session_id)?.and_then(|row| row.project_id)
    {
        return Ok(Some(project_id));
    }

    if let Some(context) = load_session_worker_context(connection, session_id)? {
        return Ok(Some(context.project_id));
    }

    load_project_id_from_session_context(connection, session_id)
}

pub fn load_session_open_assignment(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    if let Some(row) = load_session_row(connection, session_id)? {
        if let Some(assignment_id) = row.assignment_id.as_deref() {
            if let Some(assignment) = load_open_assignment_by_id(connection, assignment_id)? {
                return Ok(Some(assignment));
            }
        }
    }

    task_runtime::get_active_assignment_for_session(connection, session_id)
}

pub fn load_session_worker_context(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<SessionWorkerContext>, String> {
    if let Some(row) = load_session_row(connection, session_id)? {
        if let Some(assignment_id) = row.assignment_id.as_deref() {
            if let Some(assignment) = load_open_assignment_by_id(connection, assignment_id)? {
                return Ok(Some(build_context_from_assignment(
                    connection,
                    session_id,
                    row.project_id,
                    row.primary_assignment_id,
                    row.owner_worker_type,
                    row.owner_worker_id,
                    row.role_instance_id,
                    row.runtime_cwd,
                    assignment,
                )?));
            }
        }

        if let Some(context) = build_context_from_session_row(connection, session_id, row)? {
            return Ok(Some(context));
        }
    }

    load_legacy_session_worker_context(connection, session_id)
}

pub fn load_session_authorization_actor(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<AuthorizationContext>, String> {
    let Some(context) = load_session_worker_context(connection, session_id)? else {
        return Ok(None);
    };

    if context.current_assignment_id.is_some() {
        match context.lane_worker_type.as_deref() {
            Some("role") => {
                if let Some(role_instance_id) = context.role_instance_id {
                    return Ok(Some(AuthorizationContext {
                        actor_type: ACTOR_ROLE_INSTANCE.into(),
                        actor_id: role_instance_id,
                    }));
                }
            }
            Some("agent") => {
                if let Some(agent_id) = context.agent_id {
                    return Ok(Some(AuthorizationContext {
                        actor_type: ACTOR_AGENT.into(),
                        actor_id: agent_id,
                    }));
                }
            }
            _ => {}
        }
    }

    if let Some(agent_id) = context.agent_id {
        return Ok(Some(AuthorizationContext {
            actor_type: ACTOR_AGENT.into(),
            actor_id: agent_id,
        }));
    }

    if let Some(role_instance_id) = context.role_instance_id {
        return Ok(Some(AuthorizationContext {
            actor_type: ACTOR_ROLE_INSTANCE.into(),
            actor_id: role_instance_id,
        }));
    }

    if context.owner_worker_type.is_none() {
        return Ok(Some(AuthorizationContext {
            actor_type: ACTOR_USER.into(),
            actor_id: DEFAULT_USER_ID.into(),
        }));
    }

    Ok(None)
}

pub fn load_worker_session_from_authorization(
    connection: &Connection,
    authorization: &AuthorizationContext,
) -> Result<Option<String>, String> {
    let canonical = match authorization.actor_type.as_str() {
        ACTOR_AGENT => connection
            .query_row(
                r#"
                SELECT id
                FROM sessions
                WHERE lifecycle_state = 'active'
                  AND (
                    agent_id = ?1
                    OR (owner_worker_type = 'agent' AND owner_worker_id = ?1)
                    OR (worker_type = 'agent' AND worker_id = ?1)
                  )
                ORDER BY CASE
                    WHEN assignment_id IS NOT NULL THEN 0
                    WHEN session_kind = 'agent_main' THEN 1
                    ELSE 2
                END,
                updated_at DESC,
                created_at DESC,
                id DESC
                LIMIT 1
                "#,
                [authorization.actor_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve canonical agent session {}: {error}",
                    authorization.actor_id
                )
            })?,
        ACTOR_ROLE_INSTANCE => connection
            .query_row(
                r#"
                SELECT id
                FROM sessions
                WHERE lifecycle_state = 'active'
                  AND role_instance_id = ?1
                ORDER BY CASE WHEN assignment_id IS NOT NULL THEN 0 ELSE 1 END,
                         updated_at DESC,
                         created_at DESC,
                         id DESC
                LIMIT 1
                "#,
                [authorization.actor_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve canonical role session {}: {error}",
                    authorization.actor_id
                )
            })?,
        _ => None,
    };
    if canonical.is_some() {
        return Ok(canonical);
    }

    match authorization.actor_type.as_str() {
        ACTOR_AGENT => connection
            .query_row(
                "SELECT main_session_id FROM agent_runtime_states WHERE agent_id = ?1 ORDER BY updated_at DESC LIMIT 1",
                [authorization.actor_id.as_str()],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve fallback agent session {}: {error}",
                    authorization.actor_id
                )
            })
            .map(|value| value.flatten()),
        ACTOR_ROLE_INSTANCE => connection
            .query_row(
                "SELECT session_id FROM role_instances WHERE id = ?1 LIMIT 1",
                [authorization.actor_id.as_str()],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!(
                    "Unable to resolve fallback role session {}: {error}",
                    authorization.actor_id
                )
            })
            .map(|value| value.flatten()),
        _ => Ok(None),
    }
}

fn build_context_from_assignment(
    connection: &Connection,
    session_id: &str,
    session_project_id: Option<String>,
    primary_assignment_id: Option<String>,
    owner_worker_type: Option<String>,
    owner_worker_id: Option<String>,
    fallback_role_instance_id: Option<String>,
    fallback_runtime_cwd: Option<String>,
    assignment: TaskLaneAssignment,
) -> Result<SessionWorkerContext, String> {
    let project_id = session_project_id
        .or_else(|| {
            project_id_for_task(connection, assignment.task_id.as_str())
                .ok()
                .flatten()
        })
        .ok_or_else(|| {
            format!("Unable to resolve project for assignment-backed session {session_id}")
        })?;

    let lane_worker_type = Some(assignment.worker_type.clone());
    let lane_worker_id = assignment.worker_id.clone();
    let role_instance_id = if assignment.worker_type == "role" {
        assignment
            .role_instance_id
            .clone()
            .or(fallback_role_instance_id)
    } else {
        assignment.role_instance_id.clone()
    };
    let runtime_cwd = assignment.runtime_cwd.clone().or(fallback_runtime_cwd);

    let (agent_id, role_id, owner_worker_type, owner_worker_id) =
        match assignment.worker_type.as_str() {
            "agent" => {
                let agent_id = assignment.worker_id.clone();
                let role_id = if let Some(agent_id) = assignment.worker_id.as_deref() {
                    agent_role_id(connection, agent_id)?
                } else {
                    None
                };
                (
                    agent_id,
                    role_id,
                    Some("agent".into()),
                    assignment.worker_id.clone(),
                )
            }
            "role" => (
                None,
                assignment.worker_id.clone(),
                Some("role".into()),
                assignment.worker_id.clone(),
            ),
            _ => (None, None, owner_worker_type, owner_worker_id),
        };

    Ok(SessionWorkerContext {
        session_id: session_id.to_string(),
        project_id,
        task_id: Some(assignment.task_id),
        workflow_id: Some(assignment.workflow_id),
        workflow_lane_id: Some(assignment.lane_id),
        current_assignment_id: Some(assignment.id),
        primary_assignment_id,
        lane_worker_type,
        lane_worker_id,
        owner_worker_type,
        owner_worker_id,
        agent_id,
        role_id,
        role_instance_id,
        runtime_cwd,
        context_source: CONTEXT_SOURCE_TASK_ASSIGNMENT.into(),
    })
}

fn build_context_from_session_row(
    connection: &Connection,
    session_id: &str,
    row: SessionRow,
) -> Result<Option<SessionWorkerContext>, String> {
    let project_id = row.project_id.clone().or_else(|| {
        row.primary_task_id
            .as_deref()
            .or(row.task_id.as_deref())
            .and_then(|task_id| project_id_for_task(connection, task_id).ok().flatten())
    });

    let Some(project_id) = project_id else {
        return Ok(None);
    };

    if let Some(agent_id) =
        row.agent_id
            .clone()
            .or_else(|| match row.owner_worker_type.as_deref() {
                Some("agent") => row.owner_worker_id.clone(),
                _ => None,
            })
    {
        let role_id = row
            .role_id
            .clone()
            .or(agent_role_id(connection, agent_id.as_str())?);
        return Ok(Some(SessionWorkerContext {
            session_id: session_id.to_string(),
            project_id,
            task_id: row.primary_task_id,
            workflow_id: row.primary_workflow_id,
            workflow_lane_id: row.primary_lane_id,
            current_assignment_id: None,
            primary_assignment_id: row.primary_assignment_id,
            lane_worker_type: row.worker_type,
            lane_worker_id: row.worker_id,
            owner_worker_type: row.owner_worker_type,
            owner_worker_id: row.owner_worker_id,
            agent_id: Some(agent_id),
            role_id,
            role_instance_id: row.role_instance_id,
            runtime_cwd: row.runtime_cwd,
            context_source: CONTEXT_SOURCE_AGENT_MAIN_SESSION.into(),
        }));
    }

    if let Some(role_instance_id) = row.role_instance_id.clone() {
        let role_id = row.role_id.clone().or(role_instance_role_id(
            connection,
            role_instance_id.as_str(),
        )?);
        let context_source = if row.primary_assignment_id.is_some() || row.primary_task_id.is_some()
        {
            CONTEXT_SOURCE_TASK_SESSION
        } else {
            CONTEXT_SOURCE_ROLE_INSTANCE_SESSION
        };
        let owner_worker_id = row.owner_worker_id.clone().or_else(|| role_id.clone());
        return Ok(Some(SessionWorkerContext {
            session_id: session_id.to_string(),
            project_id,
            task_id: row.primary_task_id,
            workflow_id: row.primary_workflow_id,
            workflow_lane_id: row.primary_lane_id,
            current_assignment_id: None,
            primary_assignment_id: row.primary_assignment_id,
            lane_worker_type: row.worker_type,
            lane_worker_id: row.worker_id,
            owner_worker_type: row.owner_worker_type.or_else(|| Some("role".into())),
            owner_worker_id,
            agent_id: None,
            role_id,
            role_instance_id: Some(role_instance_id),
            runtime_cwd: row.runtime_cwd,
            context_source: context_source.into(),
        }));
    }

    if row.primary_assignment_id.is_some() || row.primary_task_id.is_some() {
        let owner_worker_type = row.owner_worker_type.clone();
        let owner_worker_id = row.owner_worker_id.clone();
        let (agent_id, role_id) = match owner_worker_type.as_deref() {
            Some("agent") => {
                let agent_id = owner_worker_id.clone();
                let role_id = if let Some(agent_id) = agent_id.as_deref() {
                    row.role_id.clone().or(agent_role_id(connection, agent_id)?)
                } else {
                    row.role_id.clone()
                };
                (agent_id, role_id)
            }
            Some("role") => (None, owner_worker_id.clone().or(row.role_id.clone())),
            _ => (row.agent_id.clone(), row.role_id.clone()),
        };
        return Ok(Some(SessionWorkerContext {
            session_id: session_id.to_string(),
            project_id,
            task_id: row.primary_task_id,
            workflow_id: row.primary_workflow_id,
            workflow_lane_id: row.primary_lane_id,
            current_assignment_id: None,
            primary_assignment_id: row.primary_assignment_id,
            lane_worker_type: row.worker_type,
            lane_worker_id: row.worker_id,
            owner_worker_type,
            owner_worker_id,
            agent_id,
            role_id,
            role_instance_id: row.role_instance_id,
            runtime_cwd: row.runtime_cwd,
            context_source: CONTEXT_SOURCE_TASK_SESSION.into(),
        }));
    }

    Ok(Some(SessionWorkerContext {
        session_id: session_id.to_string(),
        project_id,
        task_id: None,
        workflow_id: None,
        workflow_lane_id: None,
        current_assignment_id: None,
        primary_assignment_id: None,
        lane_worker_type: row.worker_type,
        lane_worker_id: row.worker_id,
        owner_worker_type: row.owner_worker_type,
        owner_worker_id: row.owner_worker_id,
        agent_id: None,
        role_id: row.role_id,
        role_instance_id: row.role_instance_id,
        runtime_cwd: row.runtime_cwd,
        context_source: CONTEXT_SOURCE_PROJECT_SESSION.into(),
    }))
}

fn load_legacy_session_worker_context(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<SessionWorkerContext>, String> {
    if let Some(assignment) =
        task_runtime::get_active_assignment_for_session(connection, session_id)?
    {
        return build_context_from_assignment(
            connection, session_id, None, None, None, None, None, None, assignment,
        )
        .map(Some);
    }

    if let Some((project_id, agent_id, role_id)) = connection
        .query_row(
            r#"
            SELECT ars.project_id, ars.agent_id, a.role_id
            FROM agent_runtime_states ars
            LEFT JOIN agents a ON a.id = ars.agent_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to resolve fallback agent runtime scope for session {session_id}: {error}"
            )
        })?
    {
        return Ok(Some(SessionWorkerContext {
            session_id: session_id.to_string(),
            project_id,
            task_id: None,
            workflow_id: None,
            workflow_lane_id: None,
            current_assignment_id: None,
            primary_assignment_id: None,
            lane_worker_type: None,
            lane_worker_id: None,
            owner_worker_type: Some("agent".into()),
            owner_worker_id: Some(agent_id.clone()),
            agent_id: Some(agent_id),
            role_id,
            role_instance_id: None,
            runtime_cwd: None,
            context_source: CONTEXT_SOURCE_AGENT_MAIN_SESSION.into(),
        }));
    }

    if let Some(role_instance_id) = connection
        .query_row(
            "SELECT id FROM role_instances WHERE session_id = ?1 AND status IN ('running', 'waiting', 'idle') LIMIT 1",
            [session_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to resolve fallback role instance scope for session {session_id}: {error}"
            )
        })?
    {
        let role_id = role_instance_role_id(connection, role_instance_id.as_str())?;
        let project_id = load_project_id_from_session_context(connection, session_id)?
            .ok_or_else(|| {
                format!(
                    "Session {session_id} is bound to a role instance but has no project session context"
                )
            })?;
        return Ok(Some(SessionWorkerContext {
            session_id: session_id.to_string(),
            project_id,
            task_id: None,
            workflow_id: None,
            workflow_lane_id: None,
            current_assignment_id: None,
            primary_assignment_id: None,
            lane_worker_type: None,
            lane_worker_id: None,
            owner_worker_type: Some("role".into()),
            owner_worker_id: role_id.clone(),
            agent_id: None,
            role_id,
            role_instance_id: Some(role_instance_id),
            runtime_cwd: None,
            context_source: CONTEXT_SOURCE_ROLE_INSTANCE_SESSION.into(),
        }));
    }

    let Some(project_id) = load_project_id_from_session_context(connection, session_id)? else {
        return Ok(None);
    };
    Ok(Some(SessionWorkerContext {
        session_id: session_id.to_string(),
        project_id,
        task_id: None,
        workflow_id: None,
        workflow_lane_id: None,
        current_assignment_id: None,
        primary_assignment_id: None,
        lane_worker_type: None,
        lane_worker_id: None,
        owner_worker_type: None,
        owner_worker_id: None,
        agent_id: None,
        role_id: None,
        role_instance_id: None,
        runtime_cwd: None,
        context_source: CONTEXT_SOURCE_PROJECT_SESSION.into(),
    }))
}

fn load_session_row(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<SessionRow>, String> {
    connection
        .query_row(
            r#"
            SELECT
                project_id,
                task_id,
                assignment_id,
                primary_task_id,
                primary_workflow_id,
                primary_lane_id,
                primary_assignment_id,
                worker_type,
                worker_id,
                owner_worker_type,
                owner_worker_id,
                agent_id,
                role_id,
                role_instance_id,
                COALESCE(runtime_cwd, transcript_cwd)
            FROM sessions
            WHERE id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok(SessionRow {
                    project_id: row.get(0)?,
                    task_id: row.get(1)?,
                    assignment_id: row.get(2)?,
                    primary_task_id: row.get(3)?,
                    primary_workflow_id: row.get(4)?,
                    primary_lane_id: row.get(5)?,
                    primary_assignment_id: row.get(6)?,
                    worker_type: row.get(7)?,
                    worker_id: row.get(8)?,
                    owner_worker_type: row.get(9)?,
                    owner_worker_id: row.get(10)?,
                    agent_id: row.get(11)?,
                    role_id: row.get(12)?,
                    role_instance_id: row.get(13)?,
                    runtime_cwd: row.get(14)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load canonical session row {session_id}: {error}"))
}

fn load_open_assignment_by_id(
    connection: &Connection,
    assignment_id: &str,
) -> Result<Option<TaskLaneAssignment>, String> {
    connection
        .query_row(
            r#"
            SELECT
                tla.id,
                tla.task_id,
                tla.workflow_id,
                tla.lane_id,
                tla.worker_type,
                tla.worker_id,
                tla.status,
                tla.session_id,
                tla.runtime_cwd,
                tla.role_queue_entry_id,
                tla.role_instance_id,
                tla.prompt,
                tla.pending_outcome,
                tla.completion_summary,
                tla.completion_notes,
                tla.whip_count,
                tla.last_whip_at,
                tla.started_at,
                tla.completed_at,
                tla.created_at,
                tla.updated_at
            FROM task_lane_assignments tla
            INNER JOIN tasks t ON t.id = tla.task_id
            WHERE tla.id = ?1
              AND tla.status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention', 'paused_by_user')
              AND t.status NOT IN ('completed', 'canceled')
              AND (t.current_lane_id IS NULL OR tla.lane_id = t.current_lane_id)
            LIMIT 1
            "#,
            [assignment_id],
            |row| {
                Ok(TaskLaneAssignment {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    workflow_id: row.get(2)?,
                    lane_id: row.get(3)?,
                    worker_type: row.get(4)?,
                    worker_id: row.get(5)?,
                    status: row.get(6)?,
                    session_id: row.get(7)?,
                    runtime_cwd: row.get(8)?,
                    role_queue_entry_id: row.get(9)?,
                    role_instance_id: row.get(10)?,
                    prompt: row.get(11)?,
                    pending_outcome: row.get(12)?,
                    completion_summary: row.get(13)?,
                    completion_notes: row.get(14)?,
                    whip_count: row.get(15)?,
                    last_whip_at: row.get(16)?,
                    started_at: row.get(17)?,
                    completed_at: row.get(18)?,
                    created_at: row.get(19)?,
                    updated_at: row.get(20)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load assignment {assignment_id}: {error}"))
}

fn project_id_for_task(connection: &Connection, task_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1 LIMIT 1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve project for task {task_id}: {error}"))
}

fn agent_role_id(connection: &Connection, agent_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT role_id FROM agents WHERE id = ?1 LIMIT 1",
            [agent_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve role for agent {agent_id}: {error}"))
        .map(|value| value.flatten())
}

fn role_instance_role_id(
    connection: &Connection,
    role_instance_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT role_id FROM role_instances WHERE id = ?1 LIMIT 1",
            [role_instance_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to resolve role for role instance {role_instance_id}: {error}")
        })
        .map(|value| value.flatten())
}

fn load_project_id_from_session_context(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    let context = match pi_sessions::find_session_context_for_session(session_id) {
        Ok(context) => context,
        Err(_) => return Ok(None),
    };
    Ok(
        projects::get_project_by_slug(connection, &context.project_slug)
            .map_err(|error| {
                format!(
                    "Unable to resolve project {} for session {session_id}: {error}",
                    context.project_slug
                )
            })?
            .map(|project| project.id),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::apply_migrations;

    #[test]
    fn canonical_assignment_beats_stable_owner_binding() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        apply_migrations(&connection).expect("migrations should apply");
        connection.execute("INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'P', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, direct_permissions, archived, created_at, updated_at) VALUES ('role-1', 'role-1', 'Role 1', NULL, NULL, NULL, NULL, 'off', 1, '[]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', NULL, NULL, NULL, NULL, 'role-1', 'off', '[]', 0, 0, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES ('workflow-1', 'workflow-1', 'Workflow 1', NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, description, lane_order, assigned_entity_type, assigned_entity_id, entry_prompt_template, use_separate_worktree, require_user_approval_on_success, success_transition_type, success_target_lane_id, failure_transition_type, failure_target_lane_id, user_intervention_target_lane_id, created_at, updated_at) VALUES ('lane-1', 'workflow-1', 'implement', 'Implement', NULL, 0, 'agent', 'agent-1', NULL, 0, 0, 'end', NULL, 'end', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, auto_blocked_by_dependencies, archived, source_schedule_id, source_schedule_occurrence_id, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'P-1', 'Task 1', NULL, 'task', 'in_progress', 'P1', 'workflow-1', 'lane-1', 'agent', 'agent-1', NULL, NULL, 10, 0, 0, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('role-instance-1', 'role-1', 'Role Instance 1', 'idle', NULL, 'session-1', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-1', 'workflow-1', 'lane-1', 'agent', 'agent-1', 'active', 'session-1', '/tmp/runtime', NULL, NULL, 'Prompt', NULL, NULL, 0, NULL, '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, owner_worker_type, owner_worker_id, role_id, role_instance_id, task_id, workflow_id, lane_id, assignment_id, primary_task_id, primary_workflow_id, primary_lane_id, primary_assignment_id, worker_type, worker_id, runtime_cwd, transcript_cwd, transcript_exists, lifecycle_state, created_at, updated_at) VALUES ('session-1', 'project-1', '/tmp/session-1.jsonl', '/tmp/session-1.jsonl', 'Session 1', 'role_instance', 'active', 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'role', 'role-1', 'role-1', 'role-instance-1', 'task-1', 'workflow-1', 'lane-1', 'assignment-1', 'task-1', 'workflow-1', 'lane-1', 'assignment-1', 'role', 'role-1', '/tmp/runtime', '/tmp/runtime', 0, 'active', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();

        let context = load_session_worker_context(&connection, "session-1")
            .expect("context should resolve")
            .expect("context should exist");
        let authorization = load_session_authorization_actor(&connection, "session-1")
            .expect("authorization should resolve")
            .expect("authorization should exist");

        assert_eq!(context.context_source, CONTEXT_SOURCE_TASK_ASSIGNMENT);
        assert_eq!(context.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(context.role_id.as_deref(), Some("role-1"));
        assert_eq!(authorization.actor_type, ACTOR_AGENT);
        assert_eq!(authorization.actor_id, "agent-1");
    }

    #[test]
    fn canonical_role_task_session_uses_primary_binding_after_close() {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        apply_migrations(&connection).expect("migrations should apply");
        connection.execute("INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'P', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, direct_permissions, archived, created_at, updated_at) VALUES ('role-1', 'role-1', 'Role 1', NULL, NULL, NULL, NULL, 'off', 1, '[]', 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES ('workflow-1', 'workflow-1', 'Workflow 1', NULL, 0, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, description, lane_order, assigned_entity_type, assigned_entity_id, entry_prompt_template, use_separate_worktree, require_user_approval_on_success, success_transition_type, success_target_lane_id, failure_transition_type, failure_target_lane_id, user_intervention_target_lane_id, created_at, updated_at) VALUES ('lane-1', 'workflow-1', 'implement', 'Implement', NULL, 0, 'role', 'role-1', NULL, 0, 0, 'end', NULL, 'end', NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, auto_blocked_by_dependencies, archived, source_schedule_id, source_schedule_occurrence_id, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'P-1', 'Task 1', NULL, 'task', 'completed', 'P1', 'workflow-1', 'lane-1', 'role', 'role-1', NULL, NULL, 10, 0, 0, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('role-instance-1', 'role-1', 'Role Instance 1', 'idle', NULL, 'session-closed', NULL, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-1', 'workflow-1', 'lane-1', 'role', 'role-1', 'completed', NULL, '/tmp/runtime', NULL, 'role-instance-1', 'Prompt', NULL, NULL, 0, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, owner_worker_type, owner_worker_id, role_id, role_instance_id, task_id, workflow_id, lane_id, assignment_id, primary_task_id, primary_workflow_id, primary_lane_id, primary_assignment_id, worker_type, worker_id, runtime_cwd, transcript_cwd, transcript_exists, lifecycle_state, created_at, updated_at) VALUES ('session-closed', 'project-1', '/tmp/session-closed.jsonl', '/tmp/session-closed.jsonl', 'Session Closed', 'role_instance', 'closed', 'closed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', 'role', 'role-1', 'role-1', 'role-instance-1', NULL, NULL, NULL, NULL, 'task-1', 'workflow-1', 'lane-1', 'assignment-1', 'role', 'role-1', '/tmp/runtime', '/tmp/runtime', 0, 'closed', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();

        let context = load_session_worker_context(&connection, "session-closed")
            .expect("context should resolve")
            .expect("context should exist");

        assert_eq!(context.context_source, CONTEXT_SOURCE_TASK_SESSION);
        assert_eq!(
            context.primary_assignment_id.as_deref(),
            Some("assignment-1")
        );
        assert_eq!(context.role_instance_id.as_deref(), Some("role-instance-1"));
        assert_eq!(context.role_id.as_deref(), Some("role-1"));
    }
}
