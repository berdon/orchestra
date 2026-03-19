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
                name TEXT NOT NULL,
                thinking_level TEXT NOT NULL DEFAULT 'off',
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
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
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
    ensure_roles_table_columns(connection)?;
    backfill_missing_role_slugs(connection)?;
    ensure_roles_slug_index(connection)?;
    ensure_workflow_transition_columns(connection)?;
    migrate_legacy_workflow_intervention_semantics(connection)?;
    Ok(())
}

fn ensure_agents_table_columns(connection: &Connection) -> Result<(), String> {
    let columns = table_columns(connection, "agents")?;

    if !columns.contains("thinking_level") {
        connection
            .execute(
                "ALTER TABLE agents ADD COLUMN thinking_level TEXT NOT NULL DEFAULT 'off'",
                [],
            )
            .map_err(|error| format!("Unable to add thinking_level column to agents table: {error}"))?;
    }

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
            .map_err(|error| format!("Unable to add thinking_level column to roles table: {error}"))?;
    }

    if !columns.contains("capacity") {
        connection
            .execute(
                "ALTER TABLE roles ADD COLUMN capacity INTEGER NOT NULL DEFAULT 1",
                [],
            )
            .map_err(|error| format!("Unable to add capacity column to roles table: {error}"))?;
    }

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
        assert_eq!(rows[0], ("role-1".into(), "reviewer".into(), "off".into(), 1));
        assert_eq!(rows[1], ("role-2".into(), "reviewer-2".into(), "off".into(), 1));
    }
}
