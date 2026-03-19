use std::fs;
use std::path::PathBuf;

use rusqlite::Connection;

use crate::services::orchestra_paths::{default_orchestra_root, orchestra_database_path};

pub fn database_path() -> Result<PathBuf, String> {
    let root = default_orchestra_root()?;
    fs::create_dir_all(&root)
        .map_err(|error| format!("Unable to create Orchestra root {}: {error}", root.display()))?;
    Ok(orchestra_database_path(&root))
}

pub fn initialize_database() -> Result<PathBuf, String> {
    let path = database_path()?;
    let connection = Connection::open(&path)
        .map_err(|error| format!("Unable to open Orchestra database {}: {error}", path.display()))?;

    apply_migrations(&connection)?;
    Ok(path)
}

pub fn open_connection() -> Result<Connection, String> {
    let path = initialize_database()?;
    Connection::open(&path)
        .map_err(|error| format!("Unable to open Orchestra database {}: {error}", path.display()))
}

fn apply_migrations(connection: &Connection) -> Result<(), String> {
    connection
        .execute_batch(
            r#"
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS agents (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS roles (
                id TEXT PRIMARY KEY,
                name TEXT NOT NULL,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );

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

    ensure_workflow_transition_columns(connection)?;
    migrate_legacy_workflow_intervention_semantics(connection)?;
    Ok(())
}

fn ensure_workflow_transition_columns(connection: &Connection) -> Result<(), String> {
    let mut statement = connection
        .prepare("PRAGMA table_info(workflow_lanes)")
        .map_err(|error| format!("Unable to inspect workflow_lanes schema: {error}"))?;

    let columns = statement
        .query_map([], |row| row.get::<_, String>(1))
        .map_err(|error| format!("Unable to read workflow_lanes schema: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect workflow_lanes schema: {error}"))?;

    if !columns.iter().any(|column| column == "success_transition_type") {
        connection
            .execute(
                "ALTER TABLE workflow_lanes ADD COLUMN success_transition_type TEXT NOT NULL DEFAULT 'end'",
                [],
            )
            .map_err(|error| format!("Unable to add success_transition_type column: {error}"))?;
    }

    if !columns.iter().any(|column| column == "failure_transition_type") {
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

#[cfg(test)]
pub fn initialize_database_at(path: &std::path::Path) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Database path {} has no parent directory", path.display()))?;
    fs::create_dir_all(parent)
        .map_err(|error| format!("Unable to create directory {}: {error}", parent.display()))?;
    let connection = Connection::open(path)
        .map_err(|error| format!("Unable to open Orchestra database {}: {error}", path.display()))?;
    apply_migrations(&connection)
}
