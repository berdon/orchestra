use std::collections::BTreeSet;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{PolicyDefinition, PolicySummary};

pub fn list_policies(connection: &Connection) -> Result<Vec<PolicySummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, description, system, immutable, created_at, updated_at
            FROM policies
            ORDER BY system DESC, updated_at DESC, name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare policy list query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(PolicySummary {
                id: row.get(0)?,
                slug: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                system: row.get::<_, i64>(4)? != 0,
                immutable: row.get::<_, i64>(5)? != 0,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Unable to query policies: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read policy rows: {error}"))
}

pub fn get_policy(connection: &Connection, policy_id: &str) -> Result<PolicyDefinition, String> {
    let row = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, permissions, system, immutable, created_at, updated_at
            FROM policies
            WHERE id = ?1
            "#,
            [policy_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query policy {policy_id}: {error}"))?
        .ok_or_else(|| format!("Policy {policy_id} was not found"))?;

    Ok(PolicyDefinition {
        id: row.0,
        slug: row.1,
        name: row.2,
        description: row.3,
        permissions: decode_string_list(row.4)?,
        system: row.5 != 0,
        immutable: row.6 != 0,
        created_at: row.7,
        updated_at: row.8,
    })
}

pub fn create_policy(
    connection: &mut Connection,
    slug: &str,
    name: &str,
    description: Option<&str>,
    permissions: &[String],
    system: bool,
    immutable: bool,
) -> Result<PolicyDefinition, String> {
    let now = now_iso();
    let policy_id = format!("policy-{}", Uuid::new_v4().simple());
    let normalized_permissions = normalize_string_list(permissions.iter().cloned().collect());
    let permissions_json = encode_string_list(&normalized_permissions)?;

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start policy creation transaction: {error}"))?;
    tx.execute(
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
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
        "#,
        params![
            policy_id,
            slug,
            name,
            description,
            permissions_json,
            if system { 1 } else { 0 },
            if immutable { 1 } else { 0 },
            now,
        ],
    )
    .map_err(|error| format!("Unable to create policy {slug}: {error}"))?;
    tx.commit()
        .map_err(|error| format!("Unable to commit policy creation: {error}"))?;

    get_policy(connection, &policy_id)
}

pub fn load_role_policy_ids(connection: &Connection, role_id: &str) -> Result<Vec<String>, String> {
    load_assignment_policy_ids(connection, "role_policy_assignments", "role_id", role_id)
}

pub fn sync_role_policy_ids(
    connection: &Connection,
    role_id: &str,
    policy_ids: &[String],
    now: &str,
) -> Result<(), String> {
    sync_assignment_policy_ids(
        connection,
        "role_policy_assignments",
        "role_id",
        role_id,
        policy_ids,
        now,
    )
}

pub fn load_agent_policy_ids(
    connection: &Connection,
    agent_id: &str,
) -> Result<Vec<String>, String> {
    load_assignment_policy_ids(connection, "agent_policy_assignments", "agent_id", agent_id)
}

pub fn sync_agent_policy_ids(
    connection: &Connection,
    agent_id: &str,
    policy_ids: &[String],
    now: &str,
) -> Result<(), String> {
    sync_assignment_policy_ids(
        connection,
        "agent_policy_assignments",
        "agent_id",
        agent_id,
        policy_ids,
        now,
    )
}

pub fn decode_string_list(value: Option<String>) -> Result<Vec<String>, String> {
    let Some(raw) = value else {
        return Ok(Vec::new());
    };

    if raw.trim().is_empty() {
        return Ok(Vec::new());
    }

    let parsed = serde_json::from_str::<Vec<String>>(&raw)
        .map_err(|error| format!("Unable to decode string list JSON: {error}"))?;
    Ok(normalize_string_list(parsed))
}

pub fn encode_string_list(values: &[String]) -> Result<String, String> {
    serde_json::to_string(&normalize_string_list(values.iter().cloned().collect()))
        .map_err(|error| format!("Unable to encode string list JSON: {error}"))
}

pub fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    values
        .into_iter()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
        .collect::<BTreeSet<_>>()
        .into_iter()
        .collect()
}

fn load_assignment_policy_ids(
    connection: &Connection,
    table: &str,
    owner_column: &str,
    owner_id: &str,
) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(&format!(
            "SELECT policy_id FROM {table} WHERE {owner_column} = ?1 ORDER BY policy_id ASC"
        ))
        .map_err(|error| format!("Unable to prepare {table} assignment query: {error}"))?;

    let rows = statement
        .query_map([owner_id], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query {table} assignments for {owner_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map(normalize_string_list)
        .map_err(|error| format!("Unable to read {table} assignments for {owner_id}: {error}"))
}

fn sync_assignment_policy_ids(
    connection: &Connection,
    table: &str,
    owner_column: &str,
    owner_id: &str,
    policy_ids: &[String],
    now: &str,
) -> Result<(), String> {
    let normalized = normalize_string_list(policy_ids.to_vec());

    connection
        .execute(
            &format!("DELETE FROM {table} WHERE {owner_column} = ?1"),
            [owner_id],
        )
        .map_err(|error| format!("Unable to clear {table} assignments for {owner_id}: {error}"))?;

    let mut statement = connection
        .prepare(&format!(
            "INSERT INTO {table} ({owner_column}, policy_id, created_at) VALUES (?1, ?2, ?3)"
        ))
        .map_err(|error| format!("Unable to prepare {table} assignment insert: {error}"))?;

    for policy_id in normalized {
        statement
            .execute(params![owner_id, policy_id, now])
            .map_err(|error| {
                format!("Unable to assign policy in {table} for {owner_id}: {error}")
            })?;
    }

    Ok(())
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

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    #[test]
    fn normalizes_string_lists() {
        let normalized = normalize_string_list(vec![
            " tasks.read ".into(),
            "tasks.read".into(),
            "".into(),
            "roles.dispatch".into(),
        ]);

        assert_eq!(
            normalized,
            vec!["roles.dispatch".to_string(), "tasks.read".to_string()]
        );
    }

    #[test]
    fn syncs_role_and_agent_policy_assignments() {
        let mut connection = open_test_connection("policy-assignments");
        let worker_policy = create_policy(
            &mut connection,
            "worker",
            "Worker",
            None,
            &["tasks.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        let reviewer_policy = create_policy(
            &mut connection,
            "reviewer",
            "Reviewer",
            None,
            &["tasks.read".into(), "tasks.comment".into()],
            false,
            false,
        )
        .expect("policy should create");

        connection
            .execute(
                "INSERT INTO roles (id, slug, name, capacity, direct_permissions, archived, created_at, updated_at) VALUES ('role-1', 'role-1', 'Role 1', 1, '[]', 0, ?1, ?1)",
                [now_iso()],
            )
            .expect("role should seed");
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', 'off', '[]', 0, 0, 0, ?1, ?1)",
                [now_iso()],
            )
            .expect("agent should seed");

        sync_role_policy_ids(
            &connection,
            "role-1",
            &[
                reviewer_policy.id.clone(),
                worker_policy.id.clone(),
                worker_policy.id.clone(),
            ],
            &now_iso(),
        )
        .expect("role policy ids should sync");
        sync_agent_policy_ids(
            &connection,
            "agent-1",
            &[reviewer_policy.id.clone()],
            &now_iso(),
        )
        .expect("agent policy ids should sync");

        let role_policy_ids =
            load_role_policy_ids(&connection, "role-1").expect("role policy ids should load");
        assert_eq!(role_policy_ids.len(), 2);
        assert!(role_policy_ids.contains(&worker_policy.id));
        assert!(role_policy_ids.contains(&reviewer_policy.id));

        assert_eq!(
            load_agent_policy_ids(&connection, "agent-1").expect("agent policy ids should load"),
            vec![reviewer_policy.id]
        );
    }
}
