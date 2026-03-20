use std::collections::BTreeSet;

use rusqlite::Connection;

use crate::{
    models::ResolvedPermissions,
    services::{agents, policies, role_runtime, roles},
};

pub fn resolve_role_permissions(
    connection: &Connection,
    role_id: &str,
) -> Result<ResolvedPermissions, String> {
    let role = roles::get_role(connection, role_id)?;
    let mut permissions = BTreeSet::new();

    for policy_id in &role.policy_ids {
        let policy = policies::get_policy(connection, policy_id)?;
        for permission in policy.permissions {
            permissions.insert(permission);
        }
    }

    for permission in role.direct_permissions {
        permissions.insert(permission);
    }

    let permissions = permissions.into_iter().collect::<Vec<_>>();
    let grants_full_access = permissions.iter().any(|permission| permission == "*");

    Ok(ResolvedPermissions {
        actor_type: "role".into(),
        actor_id: role.id,
        inherited_role_id: None,
        policy_ids: role.policy_ids,
        permissions,
        grants_full_access,
    })
}

pub fn resolve_agent_permissions(
    connection: &Connection,
    agent_id: &str,
) -> Result<ResolvedPermissions, String> {
    let agent = agents::get_agent(connection, agent_id)?;
    let mut policy_ids = BTreeSet::new();
    let mut permissions = BTreeSet::new();

    if let Some(role_id) = agent.role_id.clone() {
        let role_permissions = resolve_role_permissions(connection, &role_id)?;
        for policy_id in role_permissions.policy_ids {
            policy_ids.insert(policy_id);
        }
        for permission in role_permissions.permissions {
            permissions.insert(permission);
        }
    }

    for policy_id in &agent.policy_ids {
        let policy = policies::get_policy(connection, policy_id)?;
        policy_ids.insert(policy_id.clone());
        for permission in policy.permissions {
            permissions.insert(permission);
        }
    }

    for permission in agent.direct_permissions {
        permissions.insert(permission);
    }

    let permissions = permissions.into_iter().collect::<Vec<_>>();
    let grants_full_access = permissions.iter().any(|permission| permission == "*");

    Ok(ResolvedPermissions {
        actor_type: "agent".into(),
        actor_id: agent.id,
        inherited_role_id: agent.role_id,
        policy_ids: policy_ids.into_iter().collect(),
        permissions,
        grants_full_access,
    })
}

pub fn resolve_role_instance_permissions(
    connection: &Connection,
    instance_id: &str,
) -> Result<ResolvedPermissions, String> {
    let instance = role_runtime::get_role_instance(connection, instance_id)?;
    let mut resolved = resolve_role_permissions(connection, &instance.role_id)?;
    resolved.actor_type = "role_instance".into();
    resolved.actor_id = instance.id;
    resolved.inherited_role_id = Some(instance.role_id);
    Ok(resolved)
}

pub fn has_permission(resolved: &ResolvedPermissions, permission: &str) -> bool {
    resolved.grants_full_access || resolved.permissions.iter().any(|entry| entry == permission)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{database::initialize_database_at, policies, roles};
    use chrono::Utc;
    use rusqlite::{params, Connection};
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

    fn now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    fn seed_role(
        connection: &mut Connection,
        name: &str,
        policy_ids: Vec<String>,
        direct_permissions: Vec<String>,
    ) -> String {
        let role = roles::create_role(
            connection,
            crate::models::RoleUpsertInput {
                name: name.into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity: 1,
                policy_ids,
                direct_permissions,
            },
        )
        .expect("role should create");
        role.id
    }

    fn seed_agent(
        connection: &Connection,
        role_id: Option<&str>,
        policy_ids: &[String],
        direct_permissions: &[String],
    ) -> String {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', NULL, NULL, NULL, NULL, ?1, 'off', ?2, 0, 0, 0, ?3, ?3)",
                params![role_id, policies::encode_string_list(direct_permissions).expect("permissions should encode"), now],
            )
            .expect("agent should seed");
        policies::sync_agent_policy_ids(connection, "agent-1", policy_ids, &now)
            .expect("agent policies should sync");
        "agent-1".into()
    }

    #[test]
    fn resolves_role_permissions_from_policies_and_direct_grants() {
        let mut connection = open_test_connection("resolve-role-permissions");
        let reviewer = policies::create_policy(
            &mut connection,
            "reviewer",
            "Reviewer",
            None,
            &["tasks.read".into(), "tasks.comment".into()],
            false,
            false,
        )
        .expect("policy should create");
        let role_id = seed_role(
            &mut connection,
            "Reviewer",
            vec![reviewer.id.clone()],
            vec!["tasks.transition".into(), "tasks.comment".into()],
        );

        let resolved =
            resolve_role_permissions(&connection, &role_id).expect("permissions should resolve");
        assert_eq!(resolved.actor_type, "role");
        assert_eq!(resolved.policy_ids, vec![reviewer.id]);
        assert_eq!(
            resolved.permissions,
            vec![
                "tasks.comment".to_string(),
                "tasks.read".to_string(),
                "tasks.transition".to_string()
            ]
        );
        assert!(!resolved.grants_full_access);
        assert!(has_permission(&resolved, "tasks.read"));
        assert!(!has_permission(&resolved, "roles.dispatch"));
    }

    #[test]
    fn resolves_agent_permissions_with_role_inheritance() {
        let mut connection = open_test_connection("resolve-agent-permissions");
        let worker = policies::create_policy(
            &mut connection,
            "worker",
            "Worker",
            None,
            &["tasks.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        let session_operator = policies::create_policy(
            &mut connection,
            "session-operator",
            "Session Operator",
            None,
            &["sessions.message".into()],
            false,
            false,
        )
        .expect("policy should create");
        let role_id = seed_role(
            &mut connection,
            "Developer",
            vec![worker.id.clone()],
            vec!["tasks.comment".into()],
        );
        let agent_id = seed_agent(
            &connection,
            Some(&role_id),
            std::slice::from_ref(&session_operator.id),
            &["tasks.transition".into()],
        );

        let resolved =
            resolve_agent_permissions(&connection, &agent_id).expect("permissions should resolve");
        assert_eq!(resolved.actor_type, "agent");
        assert_eq!(resolved.inherited_role_id, Some(role_id));
        assert_eq!(resolved.policy_ids.len(), 2);
        assert!(resolved.policy_ids.contains(&session_operator.id));
        assert!(resolved.policy_ids.contains(&worker.id));
        assert_eq!(
            resolved.permissions,
            vec![
                "sessions.message".to_string(),
                "tasks.comment".to_string(),
                "tasks.read".to_string(),
                "tasks.transition".to_string()
            ]
        );
    }

    #[test]
    fn resolves_role_instance_permissions_and_full_access() {
        let mut connection = open_test_connection("resolve-role-instance-permissions");
        let supervisor = policies::create_policy(
            &mut connection,
            "supervisor",
            "Supervisor",
            None,
            &["*".into()],
            true,
            true,
        )
        .expect("policy should create");
        let role_id = seed_role(
            &mut connection,
            "Operator",
            vec![supervisor.id.clone()],
            Vec::new(),
        );
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-1', ?1, 'Operator 1', 'idle', NULL, NULL, NULL, NULL, NULL, ?2, ?2)",
                params![role_id, now],
            )
            .expect("role instance should seed");

        let resolved = resolve_role_instance_permissions(&connection, "instance-1")
            .expect("permissions should resolve");
        assert_eq!(resolved.actor_type, "role_instance");
        assert!(resolved.grants_full_access);
        assert!(has_permission(&resolved, "roles.dispatch"));
    }
}
