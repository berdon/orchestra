use rusqlite::Connection;

use crate::models::AgentSummary;

pub fn list_agents(connection: &Connection, include_archived: bool) -> Result<Vec<AgentSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, name, thinking_level, archived, created_at, updated_at
            FROM agents
            WHERE (?1 = 1 OR archived = 0)
            ORDER BY archived ASC, updated_at DESC, name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare agent list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], |row| {
            Ok(AgentSummary {
                id: row.get(0)?,
                name: row.get(1)?,
                thinking_level: row.get(2)?,
                archived: row.get::<_, i64>(3)? != 0,
                created_at: row.get(4)?,
                updated_at: row.get(5)?,
            })
        })
        .map_err(|error| format!("Unable to query agents: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read agent rows: {error}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{database::initialize_database_at, workflows::seed_worker};
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
    fn lists_agents() {
        let connection = open_test_connection("agents-list");
        seed_worker(&connection, "agents", "agent-reviewer", "Reviewer Agent").expect("agent should seed");

        let agents = list_agents(&connection, false).expect("agents should list");
        assert_eq!(agents.len(), 1);
        assert_eq!(agents[0].id, "agent-reviewer");
        assert_eq!(agents[0].name, "Reviewer Agent");
        assert_eq!(agents[0].thinking_level, "off");
    }
}
