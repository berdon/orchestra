use rusqlite::{params, Connection, OptionalExtension};
use serde_json::Value;

use crate::{
    models::DomainEvent,
    state::{generate_id, now_iso},
};

#[derive(Debug, Clone)]
pub struct DomainEventInput {
    pub project_id: Option<String>,
    pub topic: String,
    pub entity_type: String,
    pub entity_id: Option<String>,
    pub payload: Value,
}

pub fn record_event(connection: &Connection, input: DomainEventInput) -> Result<DomainEvent, String> {
    let topic = input.topic.trim();
    if topic.is_empty() {
        return Err("topic: Domain event topic is required.".into());
    }
    let entity_type = input.entity_type.trim();
    if entity_type.is_empty() {
        return Err("entityType: Domain event entity type is required.".into());
    }

    let id = generate_id("domain-event");
    let created_at = now_iso();
    let payload_json = serde_json::to_string(&input.payload)
        .map_err(|error| format!("Unable to serialize domain event payload: {error}"))?;

    connection
        .execute(
            r#"
            INSERT INTO domain_events (
                id,
                project_id,
                topic,
                entity_type,
                entity_id,
                payload_json,
                created_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
            "#,
            params![
                id,
                input.project_id,
                topic,
                entity_type,
                input.entity_id,
                payload_json,
                created_at,
            ],
        )
        .map_err(|error| format!("Unable to record domain event {topic}: {error}"))?;

    get_event_by_id(connection, &id)?
        .ok_or_else(|| format!("Domain event {id} was not found after creation"))
}

pub fn list_events(connection: &Connection) -> Result<Vec<DomainEvent>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT sequence, id, project_id, topic, entity_type, entity_id, payload_json, created_at
            FROM domain_events
            ORDER BY sequence ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare domain events query: {error}"))?;

    let rows = statement
        .query_map([], read_event)
        .map_err(|error| format!("Unable to query domain events: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read domain events: {error}"))
}

pub fn get_event_by_id(connection: &Connection, id: &str) -> Result<Option<DomainEvent>, String> {
    connection
        .query_row(
            r#"
            SELECT sequence, id, project_id, topic, entity_type, entity_id, payload_json, created_at
            FROM domain_events
            WHERE id = ?1
            "#,
            [id],
            read_event,
        )
        .optional()
        .map_err(|error| format!("Unable to load domain event {id}: {error}"))
}

fn read_event(row: &rusqlite::Row<'_>) -> rusqlite::Result<DomainEvent> {
    let payload_json = row.get::<_, String>(6)?;
    let payload = serde_json::from_str(&payload_json).unwrap_or(Value::Null);
    Ok(DomainEvent {
        sequence: row.get(0)?,
        id: row.get(1)?,
        project_id: row.get(2)?,
        topic: row.get(3)?,
        entity_type: row.get(4)?,
        entity_id: row.get(5)?,
        payload,
        created_at: row.get(7)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use serde_json::json;

    #[test]
    fn records_and_lists_domain_events() {
        let connection = Connection::open_in_memory().expect("in-memory database should open");
        connection
            .execute_batch(
                r#"
                CREATE TABLE domain_events (
                    sequence INTEGER PRIMARY KEY AUTOINCREMENT,
                    id TEXT NOT NULL UNIQUE,
                    project_id TEXT,
                    topic TEXT NOT NULL,
                    entity_type TEXT NOT NULL,
                    entity_id TEXT,
                    payload_json TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                "#,
            )
            .expect("domain_events table should create");

        let created = record_event(
            &connection,
            DomainEventInput {
                project_id: Some("project-1".into()),
                topic: "task.created".into(),
                entity_type: "task".into(),
                entity_id: Some("task-1".into()),
                payload: json!({ "taskId": "task-1" }),
            },
        )
        .expect("event should record");

        assert_eq!(created.topic, "task.created");
        assert_eq!(created.entity_type, "task");
        assert_eq!(created.project_id.as_deref(), Some("project-1"));
        assert_eq!(created.payload.get("taskId").and_then(Value::as_str), Some("task-1"));

        let events = list_events(&connection).expect("events should list");
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].id, created.id);
        assert_eq!(events[0].sequence, created.sequence);
    }
}
