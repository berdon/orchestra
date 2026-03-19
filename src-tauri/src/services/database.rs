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
                success_target_lane_id TEXT,
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
        .map_err(|error| format!("Unable to initialize Orchestra database schema: {error}"))
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
