use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::{AgentDefinition, PolicyDefinition},
    services::{agent_files, agents, policies},
};

const SUPERVISOR_POLICY_ID: &str = "policy-supervisor";
const SUPERVISOR_POLICY_SLUG: &str = "supervisor";
const SUPERVISOR_AGENT_ID: &str = "agent-supervisor";
const SUPERVISOR_AGENT_SLUG: &str = "supervisor";
const SUPERVISOR_AGENT_NAME: &str = "Supervisor";
const SUPERVISOR_SYSTEM_PROMPT: &str = "You are Orchestra's built-in supervisor agent. You coordinate work across the project, maintain continuity, and act with full orchestration authority. Orchestra is the source of truth for tasks, workflows, lanes, runtime sessions, comments, attachments, workers, roles, and policies. A task is the tracked unit of work. A workflow is the process attached to a task. A lane is the task's current step and owner. A session is the runtime conversation for a worker. Your job is to help operators and workers understand that model, use the Orchestra tools correctly, keep state accurate, preserve newer warranted changes, and keep the system coherent. When helping, prefer concrete tool-driven guidance: inspect current context first, explain what tool to use and why, tell users or workers how transitions work, and ensure work ends with the correct task-lane transition. You should be able to explain and use the full Orchestra tool surface, including agents, roles, tasks, workflows, sessions, policies, overlays, and logs.";
const SUPERVISOR_DESCRIPTION: &str = "Built-in protected Orchestra supervisor agent.";
const SUPERVISOR_THINKING_LEVEL: &str = "medium";

pub fn ensure_system_authorization_state(
    connection: &mut Connection,
    orchestra_root: Option<&std::path::Path>,
) -> Result<(PolicyDefinition, AgentDefinition), String> {
    let policy = ensure_supervisor_policy(connection)?;
    let agent = ensure_supervisor_agent(connection, &policy, orchestra_root)?;
    Ok((policy, agent))
}

pub fn ensure_supervisor_policy(connection: &mut Connection) -> Result<PolicyDefinition, String> {
    let now = now_iso();
    let permissions_json = policies::encode_string_list(&["*".to_string()])?;

    let existing = connection
        .query_row(
            "SELECT id FROM policies WHERE id = ?1 OR slug = ?2 LIMIT 1",
            params![SUPERVISOR_POLICY_ID, SUPERVISOR_POLICY_SLUG],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query supervisor policy: {error}"))?;

    match existing {
        Some(existing_id) => {
            connection
                .execute(
                    r#"
                    UPDATE policies
                    SET id = ?1,
                        slug = ?2,
                        name = ?3,
                        description = ?4,
                        permissions = ?5,
                        system = 1,
                        immutable = 1,
                        updated_at = ?6
                    WHERE id = ?7
                    "#,
                    params![
                        SUPERVISOR_POLICY_ID,
                        SUPERVISOR_POLICY_SLUG,
                        SUPERVISOR_AGENT_NAME,
                        "Built-in protected Orchestra supervisor policy.",
                        permissions_json,
                        now,
                        existing_id,
                    ],
                )
                .map_err(|error| format!("Unable to update supervisor policy: {error}"))?;
        }
        None => {
            connection
                .execute(
                    r#"
                    INSERT INTO policies (
                        id,
                        slug,
                        name,
                        description,
                        permissions,
                        system,
                        immutable,
                        created_at,
                        updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, 1, 1, ?6, ?6)
                    "#,
                    params![
                        SUPERVISOR_POLICY_ID,
                        SUPERVISOR_POLICY_SLUG,
                        SUPERVISOR_AGENT_NAME,
                        "Built-in protected Orchestra supervisor policy.",
                        permissions_json,
                        now,
                    ],
                )
                .map_err(|error| format!("Unable to create supervisor policy: {error}"))?;
        }
    }

    policies::get_policy(connection, SUPERVISOR_POLICY_ID)
}

pub fn ensure_supervisor_agent(
    connection: &mut Connection,
    policy: &PolicyDefinition,
    orchestra_root: Option<&std::path::Path>,
) -> Result<AgentDefinition, String> {
    let now = now_iso();
    let direct_permissions = policies::encode_string_list(&[])?;

    let existing = connection
        .query_row(
            "SELECT id FROM agents WHERE id = ?1 OR slug = ?2 LIMIT 1",
            params![SUPERVISOR_AGENT_ID, SUPERVISOR_AGENT_SLUG],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query supervisor agent: {error}"))?;

    let resolved_agent_id = match existing {
        Some(existing_id) => {
            connection
                .execute(
                    r#"
                    UPDATE agents
                    SET slug = ?1,
                        name = ?2,
                        description = ?3,
                        system_prompt = ?4,
                        role_id = NULL,
                        direct_permissions = ?5,
                        system = 1,
                        immutable = 1,
                        archived = 0,
                        updated_at = ?6
                    WHERE id = ?7
                    "#,
                    params![
                        SUPERVISOR_AGENT_SLUG,
                        SUPERVISOR_AGENT_NAME,
                        SUPERVISOR_DESCRIPTION,
                        SUPERVISOR_SYSTEM_PROMPT,
                        direct_permissions,
                        now,
                        existing_id,
                    ],
                )
                .map_err(|error| format!("Unable to update supervisor agent: {error}"))?;
            existing_id
        }
        None => {
            connection
                .execute(
                    r#"
                    INSERT INTO agents (
                        id,
                        slug,
                        name,
                        description,
                        system_prompt,
                        provider,
                        model,
                        role_id,
                        thinking_level,
                        direct_permissions,
                        system,
                        immutable,
                        archived,
                        created_at,
                        updated_at
                    )
                    VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, ?6, ?7, 1, 1, 0, ?8, ?8)
                    "#,
                    params![
                        SUPERVISOR_AGENT_ID,
                        SUPERVISOR_AGENT_SLUG,
                        SUPERVISOR_AGENT_NAME,
                        SUPERVISOR_DESCRIPTION,
                        SUPERVISOR_SYSTEM_PROMPT,
                        SUPERVISOR_THINKING_LEVEL,
                        direct_permissions,
                        now,
                    ],
                )
                .map_err(|error| format!("Unable to create supervisor agent: {error}"))?;
            SUPERVISOR_AGENT_ID.to_string()
        }
    };

    policies::sync_agent_policy_ids(
        connection,
        &resolved_agent_id,
        std::slice::from_ref(&policy.id),
        &now,
    )?;

    let agent = agents::get_agent(connection, &resolved_agent_id)?;
    if let Some(root) = orchestra_root {
        agent_files::bootstrap_agent_files_in(root, &agent.id, &agent.slug, &agent.name)?;
    } else {
        agent_files::bootstrap_agent_files(&agent.id, &agent.slug, &agent.name)?;
    }

    Ok(agent)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::initialize_database_at;
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

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix)
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    #[test]
    fn seeds_supervisor_policy_and_agent() {
        let mut connection = open_test_connection("supervisor-bootstrap");
        let root = unique_temp_dir("supervisor-bootstrap-root");

        let (policy, agent) = ensure_system_authorization_state(&mut connection, Some(&root))
            .expect("system auth state should seed");

        assert_eq!(policy.id, SUPERVISOR_POLICY_ID);
        assert_eq!(policy.slug, SUPERVISOR_POLICY_SLUG);
        assert_eq!(policy.permissions, vec!["*".to_string()]);
        assert!(policy.system);
        assert!(policy.immutable);

        assert_eq!(agent.id, SUPERVISOR_AGENT_ID);
        assert_eq!(agent.slug, SUPERVISOR_AGENT_SLUG);
        assert_eq!(agent.name, SUPERVISOR_AGENT_NAME);
        assert!(agent.system);
        assert!(agent.immutable);
        assert_eq!(agent.policy_ids, vec![policy.id.clone()]);
        assert!(agent.system_prompt.as_deref().unwrap_or_default().contains("Orchestra is the source of truth for tasks, workflows, lanes, runtime sessions"));
        let agent_context = std::fs::read_to_string(root.join("agents/supervisor/AGENTS.md"))
            .expect("supervisor context file should be readable");
        assert!(agent_context.contains("## What Orchestra Is"));
        assert!(agent_context.contains("A **workflow** is the process attached to a task."));
    }

    #[test]
    fn repairs_existing_supervisor_records() {
        let mut connection = open_test_connection("supervisor-repair");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO policies (id, slug, name, description, permissions, system, immutable, created_at, updated_at) VALUES ('custom-policy', 'supervisor', 'Oops', NULL, '[]', 0, 0, ?1, ?1)",
                params![now],
            )
            .expect("policy should seed");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('custom-agent', 'supervisor', 'Oops', NULL, NULL, 'anthropic', 'claude', 'role-x', 'off', '[\"tasks.read\"]', 0, 0, 1, ?1, ?1)",
                params![now],
            )
            .expect("agent should seed");

        let (policy, agent) = ensure_system_authorization_state(&mut connection, None)
            .expect("system auth state should repair");

        assert_eq!(policy.slug, SUPERVISOR_POLICY_SLUG);
        assert!(policy.system);
        assert!(policy.immutable);
        assert_eq!(policy.permissions, vec!["*".to_string()]);

        assert_eq!(agent.slug, SUPERVISOR_AGENT_SLUG);
        assert_eq!(agent.role_id, None);
        assert_eq!(agent.direct_permissions, Vec::<String>::new());
        assert!(agent.system);
        assert!(agent.immutable);
        assert!(!agent.archived);
        assert_eq!(agent.policy_ids, vec![policy.id.clone()]);
        assert!(agent.system_prompt.as_deref().unwrap_or_default().contains("You should be able to explain and use the full Orchestra tool surface"));
        assert_eq!(agent.provider.as_deref(), Some("anthropic"));
        assert_eq!(agent.model.as_deref(), Some("claude"));
        assert_eq!(agent.thinking_level, "off");
    }
}
