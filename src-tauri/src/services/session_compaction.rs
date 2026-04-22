#[cfg(test)]
use rusqlite::params;
use rusqlite::{Connection, OptionalExtension};

use crate::services::{agents, task_runtime};

pub const DEFAULT_COMPACTION_WINDOW: &str = "10%";

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum CompactionWindowSpec {
    RemainingPercent(u8),
    RemainingTokens(i64),
    Off,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ResolvedCompactionPolicy {
    pub window_spec: String,
    pub source: String,
}

pub fn parse_compaction_window_spec(value: &str) -> Result<CompactionWindowSpec, String> {
    let trimmed = value.trim().to_lowercase();
    if trimmed.is_empty() {
        return Err("Compaction window cannot be empty".into());
    }

    if trimmed == "off" {
        return Ok(CompactionWindowSpec::Off);
    }

    if let Some(percent_value) = trimmed.strip_suffix('%') {
        let percent = percent_value
            .parse::<u8>()
            .map_err(|_| format!("Invalid compaction window percentage: {value}"))?;
        if !(1..=99).contains(&percent) {
            return Err("Compaction window percentage must be between 1% and 99%".into());
        }
        return Ok(CompactionWindowSpec::RemainingPercent(percent));
    }

    let tokens = trimmed
        .parse::<i64>()
        .map_err(|_| format!("Invalid compaction window token reserve: {value}"))?;
    if tokens <= 0 {
        return Err("Compaction window token reserve must be greater than 0".into());
    }

    Ok(CompactionWindowSpec::RemainingTokens(tokens))
}

pub fn normalize_compaction_window_spec(value: Option<String>) -> Result<Option<String>, String> {
    let Some(value) = value else {
        return Ok(None);
    };
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Ok(None);
    }

    match parse_compaction_window_spec(trimmed)? {
        CompactionWindowSpec::Off => Ok(Some("off".into())),
        CompactionWindowSpec::RemainingPercent(percent) => Ok(Some(format!("{percent}%"))),
        CompactionWindowSpec::RemainingTokens(tokens) => Ok(Some(tokens.to_string())),
    }
}

pub fn resolve_session_compaction_policy(
    connection: &Connection,
    session_id: &str,
    global_default: Option<&str>,
) -> Result<ResolvedCompactionPolicy, String> {
    let global = normalize_compaction_window_spec(global_default.map(str::to_string))?
        .unwrap_or_else(|| DEFAULT_COMPACTION_WINDOW.to_string());

    let ownership = load_session_compaction_scope(connection, session_id)?;

    if let Some(agent_id) = ownership.agent_id.as_deref() {
        let agent_override = connection
            .query_row(
                "SELECT compaction_window FROM agents WHERE id = ?1 LIMIT 1",
                [agent_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| {
                format!("Unable to query agent compaction window {agent_id}: {error}")
            })?
            .flatten();
        if let Some(window_spec) = normalize_compaction_window_spec(agent_override)? {
            return Ok(ResolvedCompactionPolicy {
                window_spec,
                source: "agent".into(),
            });
        }
    }

    if let Some(role_id) = ownership.role_id.as_deref() {
        let role_override = connection
            .query_row(
                "SELECT compaction_window FROM roles WHERE id = ?1 LIMIT 1",
                [role_id],
                |row| row.get::<_, Option<String>>(0),
            )
            .optional()
            .map_err(|error| format!("Unable to query role compaction window {role_id}: {error}"))?
            .flatten();
        if let Some(window_spec) = normalize_compaction_window_spec(role_override)? {
            return Ok(ResolvedCompactionPolicy {
                window_spec,
                source: "role".into(),
            });
        }
    }

    Ok(ResolvedCompactionPolicy {
        window_spec: global,
        source: "global".into(),
    })
}

#[derive(Debug, Default)]
struct SessionCompactionScope {
    agent_id: Option<String>,
    role_id: Option<String>,
}

fn load_session_compaction_scope(
    connection: &Connection,
    session_id: &str,
) -> Result<SessionCompactionScope, String> {
    if let Some((agent_id, role_id)) = connection
        .query_row(
            r#"
            SELECT a.id, a.role_id
            FROM agent_runtime_states ars
            JOIN agents a ON a.id = ars.agent_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query agent session compaction scope {session_id}: {error}")
        })?
    {
        return Ok(SessionCompactionScope { agent_id, role_id });
    }

    if let Some(role_id) = connection
        .query_row(
            r#"
            SELECT role_id
            FROM role_instances
            WHERE session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query role session compaction scope {session_id}: {error}")
        })?
        .flatten()
    {
        return Ok(SessionCompactionScope {
            agent_id: None,
            role_id: Some(role_id),
        });
    }

    if let Some(assignment) =
        task_runtime::get_active_assignment_for_session(connection, session_id)?
    {
        return scope_from_worker_assignment(
            connection,
            assignment.worker_type.as_str(),
            assignment.worker_id.as_deref(),
            assignment.role_instance_id.as_deref(),
        );
    }

    let latest_assignment = connection
        .query_row(
            r#"
            SELECT worker_type, worker_id, role_instance_id
            FROM task_lane_assignments
            WHERE session_id = ?1
            ORDER BY COALESCE(completed_at, updated_at, created_at) DESC, id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query latest session assignment scope {session_id}: {error}")
        })?;

    if let Some((worker_type, worker_id, role_instance_id)) = latest_assignment {
        return scope_from_worker_assignment(
            connection,
            worker_type.as_deref().unwrap_or_default(),
            worker_id.as_deref(),
            role_instance_id.as_deref(),
        );
    }

    Ok(SessionCompactionScope::default())
}

fn scope_from_worker_assignment(
    connection: &Connection,
    worker_type: &str,
    worker_id: Option<&str>,
    role_instance_id: Option<&str>,
) -> Result<SessionCompactionScope, String> {
    match worker_type {
        "agent" => {
            let agent_id = worker_id.map(str::to_string);
            let role_id = if let Some(agent_id) = worker_id {
                agents::get_agent(connection, agent_id)
                    .ok()
                    .and_then(|agent| agent.role_id)
            } else {
                None
            };
            Ok(SessionCompactionScope { agent_id, role_id })
        }
        "role" => {
            let direct_role_id = worker_id.map(str::to_string);
            if direct_role_id.is_some() {
                return Ok(SessionCompactionScope {
                    agent_id: None,
                    role_id: direct_role_id,
                });
            }

            if let Some(role_instance_id) = role_instance_id {
                let role_id = connection
                    .query_row(
                        "SELECT role_id FROM role_instances WHERE id = ?1 LIMIT 1",
                        [role_instance_id],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!("Unable to query role instance scope {role_instance_id}: {error}")
                    })?
                    .flatten();
                return Ok(SessionCompactionScope {
                    agent_id: None,
                    role_id,
                });
            }

            Ok(SessionCompactionScope::default())
        }
        _ => Ok(SessionCompactionScope::default()),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::{AgentUpsertInput, RoleUpsertInput},
        services::{agents::create_agent, database::apply_migrations, roles::create_role},
    };

    #[test]
    fn parses_compaction_window_specs() {
        assert_eq!(
            parse_compaction_window_spec("10%").unwrap(),
            CompactionWindowSpec::RemainingPercent(10)
        );
        assert_eq!(
            parse_compaction_window_spec("16000").unwrap(),
            CompactionWindowSpec::RemainingTokens(16000)
        );
        assert_eq!(
            parse_compaction_window_spec("off").unwrap(),
            CompactionWindowSpec::Off
        );
        assert!(parse_compaction_window_spec("0%").is_err());
        assert!(parse_compaction_window_spec("0").is_err());
        assert!(parse_compaction_window_spec("10.5%").is_err());
    }

    #[test]
    fn normalizes_compaction_window_specs() {
        assert_eq!(
            normalize_compaction_window_spec(Some(" 10% ".into())).unwrap(),
            Some("10%".into())
        );
        assert_eq!(
            normalize_compaction_window_spec(Some(" 16000 ".into())).unwrap(),
            Some("16000".into())
        );
        assert_eq!(
            normalize_compaction_window_spec(Some(" OFF ".into())).unwrap(),
            Some("off".into())
        );
        assert_eq!(
            normalize_compaction_window_spec(Some("   ".into())).unwrap(),
            None
        );
        assert_eq!(normalize_compaction_window_spec(None).unwrap(), None);
    }

    #[test]
    fn resolves_compaction_window_precedence_global_role_agent() {
        let mut connection = Connection::open_in_memory().expect("in-memory db should open");
        apply_migrations(&connection).expect("migrations should apply");

        let role = create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Reviewer".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
                compaction_window: Some("20%".into()),
            },
        )
        .expect("role should create");

        let agent = create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Builder".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: Some(role.id.clone()),
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("off".into()),
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
                compaction_window: Some("5000".into()),
            },
        )
        .expect("agent should create");

        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES (?1, ?2, 'idle', ?3, NULL, NULL, NULL, NULL, ?4, ?4)",
                params!["project-1", agent.id, "session-1", "2026-04-21T00:00:00Z"],
            )
            .expect("agent runtime should insert");

        let resolved_agent =
            resolve_session_compaction_policy(&connection, "session-1", Some("10%"))
                .expect("agent policy should resolve");
        assert_eq!(resolved_agent.window_spec, "5000");
        assert_eq!(resolved_agent.source, "agent");

        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES (?1, ?2, ?3, 'idle', NULL, ?4, NULL, NULL, NULL, ?5, ?5)",
                params!["role-instance-1", role.id, "Reviewer #1", "session-2", "2026-04-21T00:00:00Z"],
            )
            .expect("role instance should insert");

        let resolved_role =
            resolve_session_compaction_policy(&connection, "session-2", Some("10%"))
                .expect("role policy should resolve");
        assert_eq!(resolved_role.window_spec, "20%");
        assert_eq!(resolved_role.source, "role");

        let resolved_global =
            resolve_session_compaction_policy(&connection, "session-3", Some("10%"))
                .expect("global policy should resolve");
        assert_eq!(resolved_global.window_spec, "10%");
        assert_eq!(resolved_global.source, "global");
    }

    #[test]
    fn resolves_explicit_off_override() {
        let mut connection = Connection::open_in_memory().expect("in-memory db should open");
        apply_migrations(&connection).expect("migrations should apply");

        let role = create_role(
            &mut connection,
            RoleUpsertInput {
                name: "Planner".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
                compaction_window: Some("off".into()),
            },
        )
        .expect("role should create");

        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES (?1, ?2, ?3, 'idle', NULL, ?4, NULL, NULL, NULL, ?5, ?5)",
                params!["role-instance-2", role.id, "Planner #1", "session-4", "2026-04-21T00:00:00Z"],
            )
            .expect("role instance should insert");

        let resolved = resolve_session_compaction_policy(&connection, "session-4", Some("10%"))
            .expect("role policy should resolve");
        assert_eq!(resolved.window_spec, "off");
        assert_eq!(resolved.source, "role");
    }
}
