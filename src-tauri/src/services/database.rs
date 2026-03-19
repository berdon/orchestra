use std::collections::HashSet;
use std::fs;
use std::path::PathBuf;

use rusqlite::{params, Connection};

use crate::services::orchestra_paths::{
    default_orchestra_root, orchestra_database_path, sanitize_slug,
};

pub fn database_path() -> Result<PathBuf, String> {
    let root = default_orchestra_root()?;
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "Unable to create Orchestra root {}: {error}",
            root.display()
        )
    })?;
    Ok(orchestra_database_path(&root))
}

pub fn initialize_database() -> Result<PathBuf, String> {
    let path = database_path()?;
    let connection = Connection::open(&path).map_err(|error| {
        format!(
            "Unable to open Orchestra database {}: {error}",
            path.display()
        )
    })?;

    apply_migrations(&connection)?;
    Ok(path)
}

pub fn open_connection() -> Result<Connection, String> {
    let path = initialize_database()?;
    Connection::open(&path).map_err(|error| {
        format!(
            "Unable to open Orchestra database {}: {error}",
            path.display()
        )
    })
}

fn apply_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                provider TEXT,
                model TEXT,
                role_id TEXT,
                thinking_level TEXT NOT NULL DEFAULT 'off',
                direct_permissions TEXT NOT NULL DEFAULT '[]',
                system INTEGER NOT NULL DEFAULT 0,
                immutable INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS roles (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                provider TEXT,
                model TEXT,
                thinking_level TEXT NOT NULL DEFAULT 'off',
                capacity INTEGER NOT NULL DEFAULT 1,
                direct_permissions TEXT NOT NULL DEFAULT '[]',
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS policies (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                permissions TEXT NOT NULL DEFAULT '[]',
                system INTEGER NOT NULL DEFAULT 0,
                immutable INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS role_policy_assignments (
                role_id TEXT NOT NULL,
                policy_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (role_id, policy_id),
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
                FOREIGN KEY(policy_id) REFERENCES policies(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS agent_policy_assignments (
                agent_id TEXT NOT NULL,
                policy_id TEXT NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (agent_id, policy_id),
                FOREIGN KEY(agent_id) REFERENCES agents(id) ON DELETE CASCADE,
                FOREIGN KEY(policy_id) REFERENCES policies(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS role_instances (
                id TEXT PRIMARY KEY,
                role_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT NOT NULL,
                current_queue_entry_id TEXT,
                session_id TEXT,
                worktree_path TEXT,
                last_heartbeat_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE
            );

            CREATE TABLE IF NOT EXISTS role_queue_entries (
                id TEXT PRIMARY KEY,
                role_id TEXT NOT NULL,
                status TEXT NOT NULL,
                source_type TEXT NOT NULL,
                source_task_id TEXT,
                source_workflow_id TEXT,
                source_lane_id TEXT,
                title TEXT NOT NULL,
                summary TEXT,
                entry_prompt TEXT,
                assigned_instance_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                started_at TEXT,
                completed_at TEXT,
                FOREIGN KEY(role_id) REFERENCES roles(id) ON DELETE CASCADE,
                FOREIGN KEY(assigned_instance_id) REFERENCES role_instances(id) ON DELETE SET NULL
            );

            CREATE INDEX IF NOT EXISTS idx_role_instances_role_id
                ON role_instances(role_id);

            CREATE INDEX IF NOT EXISTS idx_role_queue_entries_role_id
                ON role_queue_entries(role_id);

            CREATE INDEX IF NOT EXISTS idx_role_queue_entries_status
                ON role_queue_entries(status);

            CREATE INDEX IF NOT EXISTS idx_role_policy_assignments_policy_id
                ON role_policy_assignments(policy_id);

            CREATE INDEX IF NOT EXISTS idx_agent_policy_assignments_policy_id
                ON agent_policy_assignments(policy_id);

            CREATE TABLE IF NOT EXISTS workflows (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS workflow_lanes (
                id TEXT NOT NULL,
                workflow_id TEXT NOT NULL,
                lane_key TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                lane_order INTEGER NOT NULL,
                assigned_entity_type TEXT NOT NULL,
                assigned_entity_id TEXT,
                entry_prompt_template TEXT,
                success_transition_type TEXT NOT NULL DEFAULT 'end',
                success_target_lane_id TEXT,
                failure_transition_type TEXT NOT NULL DEFAULT 'end',
                failure_target_lane_id TEXT,
                user_intervention_target_lane_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (workflow_id, id),
                FOREIGN KEY(workflow_id) REFERENCES workflows(id) ON DELETE CASCADE
            );

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lanes_workflow_key
                ON workflow_lanes(workflow_id, lane_key);

            CREATE UNIQUE INDEX IF NOT EXISTS idx_workflow_lanes_workflow_order
                ON workflow_lanes(workflow_id, lane_order);
            "#,
        )
        .map_err(|error| format!("Unable to initialize Orchestra database schema: {error}"))?;

    ensure_agents_table_columns(connection)?;
    backfill_missing_agent_slugs(connection)?;
    ensure_agents_slug_index(connection)?;
    ensure_roles_table_columns(connection)?;
    backfill_missing_role_slugs(connection)?;
    ensure_roles_slug_index(connection)?;
    migrate_workflow_worker_references_to_slugs(connection)?;
    ensure_workflow_transition_columns(connection)?;
    migrate_legacy_workflow_intervention_semantics(connection)?;
    Ok(())
}

fn ensure_agents_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "agents")?;

    if !columns.contains("slug") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN slug TEXT", [])
            .map_err(|error| format!("Unable to add slug column to agents table: {error}"))?;
    }

    if !columns.contains("description") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN description TEXT", [])
            .map_err(|error| {
                format!("Unable to add description column to agents table: {error}")
            })?;
    }

    if !columns.contains("system_prompt") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN system_prompt TEXT", [])
            .map_err(|error| {
                format!("Unable to add system_prompt column to agents table: {error}")
            })?;
    }

    if !columns.contains("provider") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN provider TEXT", [])
            .map_err(|error| format!("Unable to add provider column to agents table: {error}"))?;
    }

    if !columns.contains("model") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN model TEXT", [])
            .map_err(|error| format!("Unable to add model column to agents table: {error}"))?;
    }

    if !columns.contains("role_id") {
        connection
            .execute("ALTER TABLE agents ADD COLUMN role_id TEXT", [])
            .map_err(|error| format!("Unable to add role_id column to agents table: {error}"))?;
    }

    if !columns.contains("thinking_level") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add thinking_level column to agents table: {error}")
            })?;
    }

    if !columns.contains("direct_permissions") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN direct_permissions TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add direct_permissions column to agents table: {error}")
            })?;
    }

    if !columns.contains("system") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN system INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Unable to add system column to agents table: {error}"))?;
    }

    if !columns.contains("immutable") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN immutable INTEGER NOT NULL DEFAULT 0",
                [],
            )
            .map_err(|error| format!("Unable to add immutable column to agents table: {error}"))?;
    }

    connection
        .execute(
            "UPDATE agents SET direct_permissions = '[]' WHERE direct_permissions IS NULL OR trim(direct_permissions) = ''",
            [],
        )
        .map_err(|error| format!("Unable to backfill direct_permissions for agents: {error}"))?;

    Ok(())
}

fn backfill_missing_agent_slugs(connection: &Connection) -> Result<(), String> {
    let mut used_slugs = connection
        .prepare("SELECT slug FROM agents WHERE slug IS NOT NULL AND trim(slug) != ''")
        .map_err(|error| format!("Unable to prepare existing agent slug query: {error}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to read existing agent slugs: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to collect existing agent slugs: {error}"))?;

    let missing_slugs = connection
        .prepare(
            "SELECT id, name FROM agents WHERE slug IS NULL OR trim(slug) = '' ORDER BY created_at ASC, id ASC",
        )
        .map_err(|error| format!("Unable to prepare missing agent slug query: {error}"))?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query agents missing slugs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect agents missing slugs: {error}"))?;

    for (id, name) in missing_slugs {
        let slug = next_available_agent_slug(&name, &mut used_slugs);
        connection
            .execute(
                "UPDATE agents SET slug = ?2 WHERE id = ?1",
                params![id, slug],
            )
            .map_err(|error| format!("Unable to backfill agent slug for {id}: {error}"))?;
    }

    Ok(())
}

fn ensure_agents_slug_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_agents_slug ON agents(slug)",
            [],
        )
        .map_err(|error| format!("Unable to create unique agents slug index: {error}"))?;
    Ok(())
}

fn ensure_roles_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "roles")?;

    if !columns.contains("slug") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN slug TEXT", [])
            .map_err(|error| format!("Unable to add slug column to roles table: {error}"))?;
    }

    if !columns.contains("description") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN description TEXT", [])
            .map_err(|error| format!("Unable to add description column to roles table: {error}"))?;
    }

    if !columns.contains("system_prompt") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN system_prompt TEXT", [])
            .map_err(|error| {
                format!("Unable to add system_prompt column to roles table: {error}")
            })?;
    }

    if !columns.contains("provider") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN provider TEXT", [])
            .map_err(|error| format!("Unable to add provider column to roles table: {error}"))?;
    }

    if !columns.contains("model") {
        connection
            .execute("ALTER TABLE roles ADD COLUMN model TEXT", [])
            .map_err(|error| format!("Unable to add model column to roles table: {error}"))?;
    }

    if !columns.contains("thinking_level") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add thinking_level column to roles table: {error}")
            })?;
    }

    if !columns.contains("capacity") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|error| format!("Unable to add capacity column to roles table: {error}"))?;
    }

    if !columns.contains("direct_permissions") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN direct_permissions TEXT NOT NULL DEFAULT '[]'",
                [],
            )
            .map_err(|error| {
                format!("Unable to add direct_permissions column to roles table: {error}")
            })?;
    }

    connection
        .execute(
            "UPDATE roles SET direct_permissions = '[]' WHERE direct_permissions IS NULL OR trim(direct_permissions) = ''",
            [],
        )
        .map_err(|error| format!("Unable to backfill direct_permissions for roles: {error}"))?;

    Ok(())
}

fn backfill_missing_role_slugs(connection: &Connection) -> Result<(), String> {
    let mut used_slugs = connection
        .prepare("SELECT slug FROM roles WHERE slug IS NOT NULL AND trim(slug) != ''")
        .map_err(|error| format!("Unable to prepare existing role slug query: {error}"))?
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to read existing role slugs: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to collect existing role slugs: {error}"))?;

    let missing_slugs = connection
        .prepare(
            "SELECT id, name FROM roles WHERE slug IS NULL OR trim(slug) = '' ORDER BY created_at ASC, id ASC",
        )
        .map_err(|error| format!("Unable to prepare missing role slug query: {error}"))?
        .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)))
        .map_err(|error| format!("Unable to query roles missing slugs: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect roles missing slugs: {error}"))?;

    for (id, name) in missing_slugs {
        let slug = next_available_role_slug(&name, &mut used_slugs);
        connection
            .execute(
                "UPDATE roles SET slug = ?2 WHERE id = ?1",
                params![id, slug],
            )
            .map_err(|error| format!("Unable to backfill role slug for {id}: {error}"))?;
    }

    Ok(())
}

fn ensure_roles_slug_index(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_roles_slug ON roles(slug)",
            [],
        )
        .map_err(|error| format!("Unable to create unique roles slug index: {error}"))?;
    Ok(())
}

fn migrate_workflow_worker_references_to_slugs(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
        UPDATE workflow_lanes
        SET assigned_entity_id = (
                SELECT slug FROM agents WHERE agents.id = workflow_lanes.assigned_entity_id
            )
        WHERE assigned_entity_type = 'agent'
          AND assigned_entity_id IS NOT NULL
          AND EXISTS(
                SELECT 1 FROM agents WHERE agents.id = workflow_lanes.assigned_entity_id
            );

        UPDATE workflow_lanes
        SET assigned_entity_id = (
                SELECT slug FROM roles WHERE roles.id = workflow_lanes.assigned_entity_id
            )
        WHERE assigned_entity_type = 'role'
          AND assigned_entity_id IS NOT NULL
          AND EXISTS(
                SELECT 1 FROM roles WHERE roles.id = workflow_lanes.assigned_entity_id
            );
        "#,
        )
        .map_err(|error| {
            format!("Unable to migrate workflow worker references to slugs: {error}")
        })?;

    Ok(())
}

fn ensure_workflow_transition_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "workflow_lanes")?;

    if !columns.contains("success_transition_type") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN success_transition_type TEXT NOT NULL DEFAULT 'end'",
                [],
            )
            .map_err(|error| format!("Unable to add success_transition_type column: {error}"))?;
    }

    if !columns.contains("failure_transition_type") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN failure_transition_type TEXT NOT NULL DEFAULT 'end'",
                [],
            )
            .map_err(|error| format!("Unable to add failure_transition_type column: {error}"))?;
    }

    Ok(())
}

fn migrate_legacy_workflow_intervention_semantics(connection: &Connection) -> Result<(), String> {
    connection.execute_batch(
        r#"
        UPDATE workflow_lanes
        SET success_transition_type = CASE
                WHEN success_target_lane_id IS NOT NULL AND trim(success_target_lane_id) != '' THEN 'lane'
                ELSE 'end'
            END
        WHERE success_transition_type IS NULL OR trim(success_transition_type) = '' OR success_transition_type = 'end';

        UPDATE workflow_lanes
        SET failure_transition_type = CASE
                WHEN user_intervention_target_lane_id IS NOT NULL AND trim(user_intervention_target_lane_id) != '' THEN 'user_intervention'
                WHEN failure_target_lane_id IS NOT NULL AND trim(failure_target_lane_id) != '' THEN 'lane'
                ELSE 'end'
            END
        WHERE failure_transition_type IS NULL OR trim(failure_transition_type) = '' OR failure_transition_type = 'end';
        "#,
    ).map_err(|error| format!("Unable to migrate legacy workflow transition semantics: {error}"))?;

    Ok(())
}

fn table_columns(connection: &Connection, table_name: &str) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare(&format!("PRAGMA table_info({table_name})"))
        .map_err(|error| format!("Unable to inspect {table_name} schema: {error}"))?;

    let rows = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Unable to read {table_name} schema: {error}"))?;

    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to collect {table_name} schema: {error}"))
}

fn next_available_agent_slug(name: &str, used_slugs: &mut HashSet<String>) -> String {
    let base_slug = agent_slug_base(name);
    let mut candidate = base_slug.clone();
    let mut suffix = 2;

    while used_slugs.contains(&candidate) {
        candidate = format!("{base_slug}-{suffix}");
        suffix += 1;
    }

    used_slugs.insert(candidate.clone());
    candidate
}

fn agent_slug_base(name: &str) -> String {
    let slug = sanitize_slug(name);
    if slug == "project" {
        "agent".into()
    } else {
        slug
    }
}

fn next_available_role_slug(name: &str, used_slugs: &mut HashSet<String>) -> String {
    let base_slug = role_slug_base(name);
    let mut candidate = base_slug.clone();
    let mut suffix = 2;

    while used_slugs.contains(&candidate) {
        candidate = format!("{base_slug}-{suffix}");
        suffix += 1;
    }

    used_slugs.insert(candidate.clone());
    candidate
}

fn role_slug_base(name: &str) -> String {
    let slug = sanitize_slug(name);
    if slug == "project" {
        "role".into()
    } else {
        slug
    }
}

#[cfg(test)]
pub fn initialize_database_at(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Database path {} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create directory {}: {error}", parent.display()))?;
    let connection = Connection::open(path).map_err(|error| {
        format!(
            "Unable to open Orchestra database {}: {error}",
            path.display()
        )
    })?;
    apply_migrations(&connection)
}

#[cfg(test)]
mod tests {
    use super::*;
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

    #[test]
    fn initializes_agents_table_with_management_columns() {
        let path = unique_temp_db("agents-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");
        let columns = table_columns(&connection, "agents").expect("agents columns should load");

        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "system_prompt",
            "provider",
            "model",
            "thinking_level",
            "archived",
            "created_at",
            "updated_at",
        ] {
            assert!(
                columns.contains(expected),
                "missing expected agents column: {expected}"
            );
        }
    }

    #[test]
    fn initializes_roles_table_with_management_columns() {
        let path = unique_temp_db("roles-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");
        let columns = table_columns(&connection, "roles").expect("roles columns should load");

        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "system_prompt",
            "provider",
            "model",
            "thinking_level",
            "capacity",
            "direct_permissions",
            "archived",
            "created_at",
            "updated_at",
        ] {
            assert!(
                columns.contains(expected),
                "missing expected roles column: {expected}"
            );
        }
    }

    #[test]
    fn initializes_agent_and_policy_tables_with_auth_columns() {
        let path = unique_temp_db("agent-policy-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");

        let agent_columns =
            table_columns(&connection, "agents").expect("agents columns should load");
        for expected in [
            "id",
            "name",
            "role_id",
            "direct_permissions",
            "system",
            "immutable",
            "archived",
            "created_at",
            "updated_at",
        ] {
            assert!(
                agent_columns.contains(expected),
                "missing expected agents column: {expected}"
            );
        }

        let policy_columns =
            table_columns(&connection, "policies").expect("policies columns should load");
        for expected in [
            "id",
            "slug",
            "name",
            "description",
            "permissions",
            "system",
            "immutable",
            "created_at",
            "updated_at",
        ] {
            assert!(
                policy_columns.contains(expected),
                "missing expected policies column: {expected}"
            );
        }

        let agent_policy_columns = table_columns(&connection, "agent_policy_assignments")
            .expect("agent_policy_assignments columns should load");
        for expected in ["agent_id", "policy_id", "created_at"] {
            assert!(
                agent_policy_columns.contains(expected),
                "missing expected agent_policy_assignments column: {expected}"
            );
        }

        let role_policy_columns = table_columns(&connection, "role_policy_assignments")
            .expect("role_policy_assignments columns should load");
        for expected in ["role_id", "policy_id", "created_at"] {
            assert!(
                role_policy_columns.contains(expected),
                "missing expected role_policy_assignments column: {expected}"
            );
        }
    }

    #[test]
    fn initializes_role_runtime_tables() {
        let path = unique_temp_db("role-runtime-schema");
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(&path).expect("database should open");

        let instance_columns = table_columns(&connection, "role_instances")
            .expect("role_instances columns should load");
        for expected in [
            "id",
            "role_id",
            "display_name",
            "status",
            "current_queue_entry_id",
            "session_id",
            "worktree_path",
            "last_heartbeat_at",
            "last_error",
            "created_at",
            "updated_at",
        ] {
            assert!(
                instance_columns.contains(expected),
                "missing expected role_instances column: {expected}"
            );
        }

        let queue_columns = table_columns(&connection, "role_queue_entries")
            .expect("role_queue_entries columns should load");
        for expected in [
            "id",
            "role_id",
            "status",
            "source_type",
            "source_task_id",
            "source_workflow_id",
            "source_lane_id",
            "title",
            "summary",
            "entry_prompt",
            "assigned_instance_id",
            "created_at",
            "updated_at",
            "started_at",
            "completed_at",
        ] {
            assert!(
                queue_columns.contains(expected),
                "missing expected role_queue_entries column: {expected}"
            );
        }
    }

    #[test]
    fn migrates_legacy_agents_table_and_backfills_unique_slugs_and_workflow_refs() {
        let path = unique_temp_db("agents-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE agents (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE roles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE workflows (
                    id TEXT PRIMARY KEY,
                    slug TEXT NOT NULL UNIQUE,
                    name TEXT NOT NULL,
                    description TEXT,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                CREATE TABLE workflow_lanes (
                    id TEXT NOT NULL,
                    workflow_id TEXT NOT NULL,
                    lane_key TEXT NOT NULL,
                    name TEXT NOT NULL,
                    description TEXT,
                    lane_order INTEGER NOT NULL,
                    assigned_entity_type TEXT NOT NULL,
                    assigned_entity_id TEXT,
                    entry_prompt_template TEXT,
                    success_transition_type TEXT NOT NULL DEFAULT 'end',
                    success_target_lane_id TEXT,
                    failure_transition_type TEXT NOT NULL DEFAULT 'end',
                    failure_target_lane_id TEXT,
                    user_intervention_target_lane_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    PRIMARY KEY (workflow_id, id)
                );

                INSERT INTO agents (id, name, archived, created_at, updated_at)
                VALUES ('agent-1', 'Data', 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z');

                INSERT INTO roles (id, name, archived, created_at, updated_at)
                VALUES ('role-1', 'Reviewer', 0, '2026-03-18T00:00:01Z', '2026-03-18T00:00:01Z');

                INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at)
                VALUES ('workflow-1', 'development', 'Development', NULL, 0, '2026-03-18T00:00:02Z', '2026-03-18T00:00:02Z');

                INSERT INTO workflow_lanes (
                    id,
                    workflow_id,
                    lane_key,
                    name,
                    description,
                    lane_order,
                    assigned_entity_type,
                    assigned_entity_id,
                    entry_prompt_template,
                    success_transition_type,
                    success_target_lane_id,
                    failure_transition_type,
                    failure_target_lane_id,
                    user_intervention_target_lane_id,
                    created_at,
                    updated_at
                ) VALUES
                    ('lane-agent', 'workflow-1', 'implement', 'Implement', NULL, 0, 'agent', 'agent-1', NULL, 'end', NULL, 'end', NULL, NULL, '2026-03-18T00:00:03Z', '2026-03-18T00:00:03Z'),
                    ('lane-role', 'workflow-1', 'review', 'Review', NULL, 1, 'role', 'role-1', NULL, 'end', NULL, 'end', NULL, NULL, '2026-03-18T00:00:03Z', '2026-03-18T00:00:03Z');
                "#,
            )
            .expect("legacy tables should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let agent_row = connection
            .query_row(
                "SELECT slug, thinking_level FROM agents WHERE id = 'agent-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("migrated agent should load");
        assert_eq!(agent_row, ("data".into(), "off".into()));

        let role_row = connection
            .query_row(
                "SELECT slug, thinking_level FROM roles WHERE id = 'role-1'",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
            )
            .expect("migrated role should load");
        assert_eq!(role_row, ("reviewer".into(), "off".into()));

        let lane_refs = connection
            .prepare("SELECT assigned_entity_type, assigned_entity_id FROM workflow_lanes ORDER BY lane_order ASC")
            .expect("lane query should prepare")
            .query_map([], |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)))
            .expect("lane query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("lane refs should collect");

        assert_eq!(
            lane_refs,
            vec![
                ("agent".into(), Some("data".into())),
                ("role".into(), Some("reviewer".into())),
            ]
        );
    }

    #[test]
    fn migrates_legacy_roles_table_and_backfills_unique_slugs() {
        let path = unique_temp_db("roles-migration");
        let parent = path.parent().expect("temp database should have a parent");
        fs::create_dir_all(parent).expect("parent directory should exist");

        let connection = Connection::open(&path).expect("legacy database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE roles (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    archived INTEGER NOT NULL DEFAULT 0,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );

                INSERT INTO roles (id, name, archived, created_at, updated_at)
                VALUES
                    ('role-1', 'Reviewer', 0, '2026-03-18T00:00:00Z', '2026-03-18T00:00:00Z'),
                    ('role-2', 'Reviewer', 0, '2026-03-18T00:00:01Z', '2026-03-18T00:00:01Z');
                "#,
            )
            .expect("legacy roles table should seed");
        drop(connection);

        initialize_database_at(&path).expect("database migration should succeed");
        let connection = Connection::open(&path).expect("migrated database should open");

        let rows = connection
            .prepare("SELECT id, slug, thinking_level, capacity FROM roles ORDER BY id ASC")
            .expect("role query should prepare")
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            })
            .expect("role query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("role rows should collect");

        assert_eq!(rows.len(), 2);
        assert_eq!(
            rows[0],
            ("role-1".into(), "reviewer".into(), "off".into(), 1)
        );
        assert_eq!(
            rows[1],
            ("role-2".into(), "reviewer-2".into(), "off".into(), 1)
        );
    }
}
