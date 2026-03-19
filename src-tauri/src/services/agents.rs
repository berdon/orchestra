use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        AgentDefinition, AgentMemoryInfo, AgentSummary, AgentUpsertInput, AgentValidationError,
        AgentValidationResult,
    },
    services::{agent_files, orchestra_paths::sanitize_slug},
};

pub fn list_agents(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<AgentSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, thinking_level, archived, created_at, updated_at
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
                slug: row.get(1)?,
                name: row.get(2)?,
                thinking_level: row.get(3)?,
                archived: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Unable to query agents: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read agent rows: {error}"))
}

pub fn get_agent(connection: &Connection, agent_id: &str) -> Result<AgentDefinition, String> {
    connection
        .query_row(
            r#"
            SELECT id, slug, name, description, system_prompt, provider, model, thinking_level, archived, created_at, updated_at
            FROM agents
            WHERE id = ?1
            "#,
            [agent_id],
            |row| {
                Ok(AgentDefinition {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    system_prompt: row.get(4)?,
                    provider: row.get(5)?,
                    model: row.get(6)?,
                    thinking_level: row.get(7)?,
                    archived: row.get::<_, i64>(8)? != 0,
                    created_at: row.get(9)?,
                    updated_at: row.get(10)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query agent {agent_id}: {error}"))?
        .ok_or_else(|| format!("Agent {agent_id} was not found"))
}

pub fn validate_agent(
    _connection: &Connection,
    input: &AgentUpsertInput,
) -> Result<AgentValidationResult, String> {
    let normalized = normalize_input(input.clone());
    let mut errors = Vec::new();

    if normalized.name.is_empty() {
        errors.push(validation_error("required", "name", "Agent name is required."));
    }

    match (&normalized.provider, &normalized.model) {
        (Some(_), None) => errors.push(validation_error(
            "required",
            "model",
            "Select a model when a provider is configured.",
        )),
        (None, Some(_)) => errors.push(validation_error(
            "required",
            "provider",
            "Select a provider when a model is configured.",
        )),
        _ => {}
    }

    if !is_valid_thinking_level(normalized.thinking_level.as_deref().unwrap_or("off")) {
        errors.push(validation_error(
            "invalid",
            "thinkingLevel",
            "Thinking level must be one of: off, minimal, low, medium, high.",
        ));
    }

    Ok(AgentValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}

pub fn create_agent(
    connection: &mut Connection,
    input: AgentUpsertInput,
) -> Result<AgentDefinition, String> {
    create_agent_in(connection, input, None)
}

fn create_agent_in(
    connection: &mut Connection,
    input: AgentUpsertInput,
    orchestra_root_override: Option<&Path>,
) -> Result<AgentDefinition, String> {
    let validation = validate_agent(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let normalized = normalize_input(input);
    let now = now_iso();
    let agent_id = agent_id();
    let slug = unique_slug(connection, &normalized.name, None)?;
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start agent creation transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO agents (
            id,
            slug,
            name,
            description,
            system_prompt,
            provider,
            model,
            thinking_level,
            archived,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 0, ?9, ?9)
        "#,
        params![
            agent_id,
            slug,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized.thinking_level.clone().unwrap_or_else(|| "off".into()),
            now,
        ],
    )
    .map_err(|error| format!("Unable to create agent: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit agent creation: {error}"))?;

    let created = get_agent(connection, &agent_id)?;
    bootstrap_agent_files(&created, orchestra_root_override)?;
    Ok(created)
}

pub fn update_agent(
    connection: &mut Connection,
    agent_id: &str,
    input: AgentUpsertInput,
) -> Result<AgentDefinition, String> {
    update_agent_in(connection, agent_id, input, None)
}

fn update_agent_in(
    connection: &mut Connection,
    agent_id: &str,
    input: AgentUpsertInput,
    orchestra_root_override: Option<&Path>,
) -> Result<AgentDefinition, String> {
    get_agent(connection, agent_id)?;
    let validation = validate_agent(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let normalized = normalize_input(input);
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start agent update transaction: {error}"))?;

    tx.execute(
        r#"
        UPDATE agents
        SET name = ?2,
            description = ?3,
            system_prompt = ?4,
            provider = ?5,
            model = ?6,
            thinking_level = ?7,
            updated_at = ?8
        WHERE id = ?1
        "#,
        params![
            agent_id,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized.thinking_level.clone().unwrap_or_else(|| "off".into()),
            now,
        ],
    )
    .map_err(|error| format!("Unable to update agent {agent_id}: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit agent update: {error}"))?;

    let updated = get_agent(connection, agent_id)?;
    bootstrap_agent_files(&updated, orchestra_root_override)?;
    Ok(updated)
}

pub fn archive_agent(connection: &Connection, agent_id: &str) -> Result<AgentDefinition, String> {
    let updated = connection
        .execute(
            "UPDATE agents SET archived = 1, updated_at = ?2 WHERE id = ?1",
            params![agent_id, now_iso()],
        )
        .map_err(|error| format!("Unable to archive agent {agent_id}: {error}"))?;

    if updated == 0 {
        return Err(format!("Agent {agent_id} was not found"));
    }

    get_agent(connection, agent_id)
}

pub fn get_agent_memory_info(
    connection: &Connection,
    agent_id: &str,
) -> Result<AgentMemoryInfo, String> {
    let agent = get_agent(connection, agent_id)?;
    bootstrap_agent_files(&agent, None)
}

fn bootstrap_agent_files(
    agent: &AgentDefinition,
    orchestra_root_override: Option<&Path>,
) -> Result<AgentMemoryInfo, String> {
    if let Some(root) = orchestra_root_override {
        agent_files::bootstrap_agent_files_in(root, &agent.id, &agent.slug, &agent.name)
    } else {
        agent_files::bootstrap_agent_files(&agent.id, &agent.slug, &agent.name)
    }
}

fn unique_slug(
    connection: &Connection,
    name: &str,
    exclude_agent_id: Option<&str>,
) -> Result<String, String> {
    let base = agent_slug(name);
    let mut candidate = base.clone();
    let mut suffix = 2;

    while agent_slug_exists(connection, &candidate, exclude_agent_id)? {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }

    Ok(candidate)
}

fn agent_slug_exists(
    connection: &Connection,
    slug: &str,
    exclude_agent_id: Option<&str>,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare("SELECT 1 FROM agents WHERE slug = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1")
        .map_err(|error| format!("Unable to prepare agent slug lookup: {error}"))?;

    let found = statement
        .query_row(params![slug, exclude_agent_id], |_| Ok(()))
        .optional()
        .map_err(|error| format!("Unable to query agent slug {slug}: {error}"))?;

    Ok(found.is_some())
}

fn agent_slug(name: &str) -> String {
    let slug = sanitize_slug(name);
    if slug == "project" {
        "agent".into()
    } else {
        slug
    }
}

fn normalize_input(input: AgentUpsertInput) -> AgentUpsertInput {
    AgentUpsertInput {
        name: input.name.trim().to_string(),
        description: normalized_optional_string(input.description),
        system_prompt: normalized_optional_string(input.system_prompt),
        provider: normalized_optional_string(input.provider),
        model: normalized_optional_string(input.model),
        thinking_level: normalized_optional_string(input.thinking_level)
            .map(|value| value.to_lowercase()),
    }
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn is_valid_thinking_level(value: &str) -> bool {
    matches!(value, "off" | "minimal" | "low" | "medium" | "high")
}

fn agent_id() -> String {
    format!("agent-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn validation_error(code: &str, path: &str, message: &str) -> AgentValidationError {
    AgentValidationError {
        code: code.into(),
        path: path.into(),
        message: message.into(),
    }
}

fn format_validation_errors(errors: &[AgentValidationError]) -> String {
    let joined = errors
        .iter()
        .map(|error| format!("{}: {}", error.path, error.message))
        .collect::<Vec<_>>()
        .join("; ");
    format!("Agent validation failed: {joined}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::initialize_database_at;
    use std::{
        env,
        fs,
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

    fn unique_home(label: &str) -> PathBuf {
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

    fn sample_agent_input() -> AgentUpsertInput {
        AgentUpsertInput {
            name: "Data".into(),
            description: Some("Persistent collaborator for implementation work.".into()),
            system_prompt: Some("Keep context, preserve continuity, and move the project forward.".into()),
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet-4-20250514".into()),
            thinking_level: Some("medium".into()),
        }
    }

    #[test]
    fn validates_agent_inputs() {
        let connection = open_test_connection("agents-validation");
        let validation = validate_agent(
            &connection,
            &AgentUpsertInput {
                name: "   ".into(),
                description: None,
                system_prompt: None,
                provider: Some("anthropic".into()),
                model: None,
                thinking_level: Some("turbo".into()),
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation.errors.iter().any(|error| error.path == "name"));
        assert!(validation.errors.iter().any(|error| error.path == "model"));
        assert!(validation.errors.iter().any(|error| error.path == "thinkingLevel"));
    }

    #[test]
    fn creates_lists_updates_archives_and_bootstraps_agents() {
        let home = unique_home("agents-home");
        fs::create_dir_all(&home).expect("home should exist");

        let mut connection = open_test_connection("agents-crud");
        let created = create_agent_in(&mut connection, sample_agent_input(), Some(&home))
            .expect("agent should create");
        assert_eq!(created.slug, "data");

        let listed = list_agents(&connection, false).expect("agents should list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].slug, "data");

        let updated = update_agent_in(
            &mut connection,
            &created.id,
            AgentUpsertInput {
                name: "Data Prime".into(),
                description: Some("Updated description".into()),
                system_prompt: created.system_prompt.clone(),
                provider: created.provider.clone(),
                model: created.model.clone(),
                thinking_level: Some("high".into()),
            },
            Some(&home),
        )
        .expect("agent should update");
        assert_eq!(updated.slug, "data");
        assert_eq!(updated.name, "Data Prime");
        assert_eq!(updated.thinking_level, "high");

        let memory = bootstrap_agent_files(&updated, Some(&home)).expect("memory info should load");
        assert!(PathBuf::from(&memory.identity_path).exists());
        assert!(PathBuf::from(&memory.soul_path).exists());
        assert!(PathBuf::from(&memory.memory_path).exists());
        assert!(PathBuf::from(&memory.tools_path).exists());

        let archived = archive_agent(&connection, &created.id).expect("agent should archive");
        assert!(archived.archived);
    }
}
