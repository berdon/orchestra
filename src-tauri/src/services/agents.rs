use std::path::Path;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        AgentDefinition, AgentMemoryInfo, AgentSummary, AgentUpsertInput, AgentValidationError,
        AgentValidationResult,
    },
    services::{agent_files, orchestra_paths::sanitize_slug, policies},
};

pub fn list_agents(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<AgentSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at
            FROM agents
            WHERE (?1 = 1 OR archived = 0)
            ORDER BY system DESC, archived ASC, updated_at DESC, name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare agent list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
                row.get::<_, String>(10)?,
            ))
        })
        .map_err(|error| format!("Unable to query agents: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read agent rows: {error}"))?
        .into_iter()
        .map(|row| {
            Ok(AgentSummary {
                id: row.0.clone(),
                slug: row.1,
                name: row.2,
                role_id: row.3,
                thinking_level: row.4,
                policy_ids: policies::load_agent_policy_ids(connection, &row.0)?,
                direct_permissions: policies::decode_string_list(row.5)?,
                system: row.6 != 0,
                immutable: row.7 != 0,
                archived: row.8 != 0,
                created_at: row.9,
                updated_at: row.10,
            })
        })
        .collect()
}

pub fn get_agent(connection: &Connection, agent_id: &str) -> Result<AgentDefinition, String> {
    let row = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at
            FROM agents
            WHERE id = ?1
            "#,
            [agent_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, i64>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, i64>(12)?,
                    row.get::<_, String>(13)?,
                    row.get::<_, String>(14)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query agent {agent_id}: {error}"))?
        .ok_or_else(|| format!("Agent {agent_id} was not found"))?;

    Ok(AgentDefinition {
        id: row.0.clone(),
        slug: row.1,
        name: row.2,
        description: row.3,
        system_prompt: row.4,
        provider: row.5,
        model: row.6,
        role_id: row.7,
        thinking_level: row.8,
        policy_ids: policies::load_agent_policy_ids(connection, &row.0)?,
        direct_permissions: policies::decode_string_list(row.9)?,
        system: row.10 != 0,
        immutable: row.11 != 0,
        archived: row.12 != 0,
        created_at: row.13,
        updated_at: row.14,
    })
}

pub fn validate_agent(
    connection: &Connection,
    input: &AgentUpsertInput,
) -> Result<AgentValidationResult, String> {
    let normalized = normalize_input(input.clone());
    let mut errors = Vec::new();

    if normalized.name.is_empty() {
        errors.push(validation_error(
            "required",
            "name",
            "Agent name is required.",
        ));
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

    if let Some(role_id) = normalized.role_id.as_deref() {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM roles WHERE id = ?1)",
                [role_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Unable to validate agent role reference: {error}"))?
            != 0;

        if !exists {
            errors.push(validation_error(
                "invalid_reference",
                "roleId",
                "Assigned role id does not reference an existing role.",
            ));
        }
    }

    if !is_valid_thinking_level(normalized.thinking_level.as_deref().unwrap_or("off")) {
        errors.push(validation_error(
            "invalid",
            "thinkingLevel",
            "Thinking level must be one of: off, minimal, low, medium, high, xhigh.",
        ));
    }

    for (index, policy_id) in normalized.policy_ids.iter().enumerate() {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM policies WHERE id = ?1)",
                [policy_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| format!("Unable to validate policy reference {policy_id}: {error}"))?
            != 0;

        if !exists {
            errors.push(validation_error(
                "invalid_reference",
                &format!("policyIds[{index}]"),
                "Policy id does not reference an existing policy.",
            ));
        }
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
    let direct_permissions = policies::encode_string_list(&normalized.direct_permissions)?;
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
            role_id,
            thinking_level,
            direct_permissions,
            system,
            immutable,
            archived,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, 0, 0, 0, ?11, ?11)
        "#,
        params![
            agent_id,
            slug,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized.role_id,
            normalized
                .thinking_level
                .clone()
                .unwrap_or_else(|| "off".into()),
            direct_permissions,
            now,
        ],
    )
    .map_err(|error| format!("Unable to create agent: {error}"))?;

    policies::sync_agent_policy_ids(&tx, &agent_id, &normalized.policy_ids, &now)?;

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
    let existing = get_agent(connection, agent_id)?;
    if existing.immutable {
        return Err(format!(
            "Agent {agent_id} is immutable and cannot be updated"
        ));
    }

    let validation = validate_agent(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let normalized = normalize_input(input);
    let now = now_iso();
    let direct_permissions = policies::encode_string_list(&normalized.direct_permissions)?;
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
            role_id = ?7,
            thinking_level = ?8,
            direct_permissions = ?9,
            updated_at = ?10
        WHERE id = ?1
        "#,
        params![
            agent_id,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized.role_id,
            normalized
                .thinking_level
                .clone()
                .unwrap_or_else(|| "off".into()),
            direct_permissions,
            now,
        ],
    )
    .map_err(|error| format!("Unable to update agent {agent_id}: {error}"))?;

    policies::sync_agent_policy_ids(&tx, agent_id, &normalized.policy_ids, &now)?;

    tx.commit()
        .map_err(|error| format!("Unable to commit agent update: {error}"))?;

    let updated = get_agent(connection, agent_id)?;
    bootstrap_agent_files(&updated, orchestra_root_override)?;
    Ok(updated)
}

pub fn archive_agent(connection: &Connection, agent_id: &str) -> Result<AgentDefinition, String> {
    let existing = get_agent(connection, agent_id)?;
    if existing.system || existing.immutable {
        return Err(format!(
            "Agent {agent_id} is protected and cannot be archived"
        ));
    }

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
        role_id: normalized_optional_string(input.role_id),
        thinking_level: normalized_optional_string(input.thinking_level)
            .map(|value| value.to_lowercase()),
        policy_ids: policies::normalize_string_list(input.policy_ids),
        direct_permissions: policies::normalize_string_list(input.direct_permissions),
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
    matches!(value, "off" | "minimal" | "low" | "medium" | "high" | "xhigh")
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
    use crate::services::{
        database::initialize_database_at, policies::create_policy, workflows::seed_worker,
    };
    use std::{
        env, fs,
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
            system_prompt: Some(
                "Keep context, preserve continuity, and move the project forward.".into(),
            ),
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet-4-20250514".into()),
            role_id: None,
            thinking_level: Some("medium".into()),
            policy_ids: Vec::new(),
            direct_permissions: vec!["tasks.read".into()],
        }
    }

    #[test]
    fn validates_agent_inputs() {
        let mut connection = open_test_connection("agents-validation");
        let policy = create_policy(
            &mut connection,
            "worker",
            "Worker",
            None,
            &["tasks.read".into()],
            false,
            false,
        )
        .expect("policy should create");
        let validation = validate_agent(
            &connection,
            &AgentUpsertInput {
                name: "   ".into(),
                description: None,
                system_prompt: None,
                provider: Some("anthropic".into()),
                model: None,
                role_id: Some("missing-role".into()),
                thinking_level: Some("turbo".into()),
                policy_ids: vec![policy.id, "missing-policy".into()],
                direct_permissions: Vec::new(),
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation.errors.iter().any(|error| error.path == "name"));
        assert!(validation.errors.iter().any(|error| error.path == "model"));
        assert!(validation.errors.iter().any(|error| error.path == "roleId"));
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "thinkingLevel"));
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path.starts_with("policyIds[")));
    }

    #[test]
    fn creates_lists_updates_archives_and_bootstraps_agents() {
        let home = unique_home("agents-home");
        fs::create_dir_all(&home).expect("home should exist");

        let mut connection = open_test_connection("agents-crud");
        seed_worker(&connection, "roles", "role-reviewer", "Reviewer").expect("role should seed");
        let policy = create_policy(
            &mut connection,
            "worker",
            "Worker",
            None,
            &["tasks.read".into()],
            false,
            false,
        )
        .expect("policy should create");

        let created = create_agent_in(
            &mut connection,
            AgentUpsertInput {
                policy_ids: vec![policy.id.clone()],
                ..sample_agent_input()
            },
            Some(&home),
        )
        .expect("agent should create");
        assert_eq!(created.slug, "data");
        assert_eq!(created.policy_ids, vec![policy.id.clone()]);
        assert_eq!(created.direct_permissions, vec!["tasks.read".to_string()]);

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
                role_id: Some("role-reviewer".into()),
                thinking_level: Some("high".into()),
                policy_ids: vec![policy.id.clone(), policy.id.clone()],
                direct_permissions: vec!["tasks.comment".into(), "tasks.comment".into()],
            },
            Some(&home),
        )
        .expect("agent should update");
        assert_eq!(updated.slug, "data");
        assert_eq!(updated.name, "Data Prime");
        assert_eq!(updated.role_id.as_deref(), Some("role-reviewer"));
        assert_eq!(updated.thinking_level, "high");
        assert_eq!(updated.policy_ids, vec![policy.id]);
        assert_eq!(
            updated.direct_permissions,
            vec!["tasks.comment".to_string()]
        );

        let memory = bootstrap_agent_files(&updated, Some(&home)).expect("memory info should load");
        assert!(PathBuf::from(&memory.identity_path).exists());
        assert!(PathBuf::from(&memory.soul_path).exists());
        assert!(PathBuf::from(&memory.memory_path).exists());
        assert!(PathBuf::from(&memory.tools_path).exists());

        let archived = archive_agent(&connection, &created.id).expect("agent should archive");
        assert!(archived.archived);
    }
}
