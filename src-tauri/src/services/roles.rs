use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        RoleDefinition, RoleSummary, RoleUpsertInput, RoleValidationError, RoleValidationResult,
    },
    services::{
        orchestra_paths::sanitize_slug, policies,
        session_compaction::normalize_compaction_window_spec,
    },
};

pub fn list_roles(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<RoleSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, description, provider, model, thinking_level, capacity, direct_permissions, archived, created_at, updated_at
            FROM roles
            WHERE (?1 = 1 OR archived = 0)
            ORDER BY archived ASC, updated_at DESC, name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare role list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, Option<String>>(8)?,
                row.get::<_, i64>(9)?,
                row.get::<_, String>(10)?,
                row.get::<_, String>(11)?,
            ))
        })
        .map_err(|error| format!("Unable to query roles: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read role rows: {error}"))?;

    rows.into_iter()
        .map(|row| {
            Ok(RoleSummary {
                id: row.0.clone(),
                slug: row.1,
                name: row.2,
                description: row.3,
                provider: row.4,
                model: row.5,
                thinking_level: row.6,
                capacity: row.7,
                policy_ids: policies::load_role_policy_ids(connection, &row.0)?,
                direct_permissions: policies::decode_string_list(row.8)?,
                archived: row.9 != 0,
                created_at: row.10,
                updated_at: row.11,
            })
        })
        .collect()
}

pub fn get_role(connection: &Connection, role_id: &str) -> Result<RoleDefinition, String> {
    let row = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, compaction_window, direct_permissions, archived, created_at, updated_at
            FROM roles
            WHERE id = ?1
            "#,
            [role_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, Option<String>>(9)?,
                    row.get::<_, Option<String>>(10)?,
                    row.get::<_, i64>(11)?,
                    row.get::<_, String>(12)?,
                    row.get::<_, String>(13)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query role {role_id}: {error}"))?
        .ok_or_else(|| format!("Role {role_id} was not found"))?;

    Ok(RoleDefinition {
        id: row.0.clone(),
        slug: row.1,
        name: row.2,
        description: row.3,
        system_prompt: row.4,
        provider: row.5,
        model: row.6,
        thinking_level: row.7,
        capacity: row.8,
        compaction_window: row.9,
        policy_ids: policies::load_role_policy_ids(connection, &row.0)?,
        direct_permissions: policies::decode_string_list(row.10)?,
        archived: row.11 != 0,
        created_at: row.12,
        updated_at: row.13,
    })
}

pub fn validate_role(
    connection: &Connection,
    input: &RoleUpsertInput,
) -> Result<RoleValidationResult, String> {
    let normalized = normalize_input(input.clone());
    let mut errors = Vec::new();

    if normalized.name.is_empty() {
        errors.push(validation_error(
            "required",
            "name",
            "Role name is required.",
        ));
    }

    if normalized.capacity < 1 {
        errors.push(validation_error(
            "invalid",
            "capacity",
            "Role capacity must be at least 1.",
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

    if !is_valid_thinking_level(normalized.thinking_level.as_deref().unwrap_or("off")) {
        errors.push(validation_error(
            "invalid",
            "thinkingLevel",
            "Thinking level must be one of: off, minimal, low, medium, high, xhigh.",
        ));
    }

    if let Err(error) = normalize_compaction_window_spec(normalized.compaction_window.clone()) {
        errors.push(validation_error("invalid", "compactionWindow", &error));
    }

    for (index, policy_id) in normalized.policy_ids.iter().enumerate() {
        let exists = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM policies WHERE id = ?1)",
                [policy_id],
                |row| row.get::<_, i64>(0),
            )
            .map_err(|error| {
                format!("Unable to validate role policy reference {policy_id}: {error}")
            })?
            != 0;

        if !exists {
            errors.push(validation_error(
                "invalid_reference",
                &format!("policyIds[{index}]"),
                "Policy id does not reference an existing policy.",
            ));
        }
    }

    Ok(RoleValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}

pub fn create_role(
    connection: &mut Connection,
    input: RoleUpsertInput,
) -> Result<RoleDefinition, String> {
    let validation = validate_role(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let normalized = normalize_input(input);
    let compaction_window = normalize_compaction_window_spec(normalized.compaction_window.clone())
        .map_err(|error| format!("Unable to normalize role compaction window: {error}"))?;
    let direct_permissions = policies::encode_string_list(&normalized.direct_permissions)?;
    let now = now_iso();
    let role_id = role_id();
    let slug = unique_slug(connection, &normalized.name, None)?;
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role creation transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO roles (
            id,
            slug,
            name,
            description,
            system_prompt,
            provider,
            model,
            thinking_level,
            capacity,
            compaction_window,
            direct_permissions,
            archived,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, 0, ?12, ?12)
        "#,
        params![
            role_id,
            slug,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized
                .thinking_level
                .clone()
                .unwrap_or_else(|| "off".into()),
            normalized.capacity,
            compaction_window,
            direct_permissions,
            now,
        ],
    )
    .map_err(|error| format!("Unable to create role: {error}"))?;

    policies::sync_role_policy_ids(&tx, &role_id, &normalized.policy_ids, &now)?;

    tx.commit()
        .map_err(|error| format!("Unable to commit role creation: {error}"))?;

    get_role(connection, &role_id)
}

pub fn update_role(
    connection: &mut Connection,
    role_id: &str,
    input: RoleUpsertInput,
) -> Result<RoleDefinition, String> {
    let existing = get_role(connection, role_id)?;
    let validation = validate_role(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let normalized = normalize_input(input);
    let compaction_window = normalize_compaction_window_spec(normalized.compaction_window.clone())
        .map_err(|error| format!("Unable to normalize role compaction window: {error}"))?;
    let direct_permissions = policies::encode_string_list(&normalized.direct_permissions)?;
    let next_slug = if role_slug(&normalized.name) == role_slug(&existing.name) {
        existing.slug
    } else {
        unique_slug(connection, &normalized.name, Some(role_id))?
    };
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role update transaction: {error}"))?;

    tx.execute(
        r#"
        UPDATE roles
        SET slug = ?2,
            name = ?3,
            description = ?4,
            system_prompt = ?5,
            provider = ?6,
            model = ?7,
            thinking_level = ?8,
            capacity = ?9,
            compaction_window = ?10,
            direct_permissions = ?11,
            updated_at = ?12
        WHERE id = ?1
        "#,
        params![
            role_id,
            next_slug,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized
                .thinking_level
                .clone()
                .unwrap_or_else(|| "off".into()),
            normalized.capacity,
            compaction_window,
            direct_permissions,
            now,
        ],
    )
    .map_err(|error| format!("Unable to update role {role_id}: {error}"))?;

    policies::sync_role_policy_ids(&tx, role_id, &normalized.policy_ids, &now)?;

    tx.commit()
        .map_err(|error| format!("Unable to commit role update: {error}"))?;

    get_role(connection, role_id)
}

pub fn archive_role(connection: &Connection, role_id: &str) -> Result<RoleDefinition, String> {
    let updated = connection
        .execute(
            "UPDATE roles SET archived = 1, updated_at = ?2 WHERE id = ?1",
            params![role_id, now_iso()],
        )
        .map_err(|error| format!("Unable to archive role {role_id}: {error}"))?;

    if updated == 0 {
        return Err(format!("Role {role_id} was not found"));
    }

    get_role(connection, role_id)
}

fn unique_slug(
    connection: &Connection,
    name: &str,
    exclude_role_id: Option<&str>,
) -> Result<String, String> {
    let base = role_slug(name);
    let mut candidate = base.clone();
    let mut suffix = 2;

    while role_slug_exists(connection, &candidate, exclude_role_id)? {
        candidate = format!("{base}-{suffix}");
        suffix += 1;
    }

    Ok(candidate)
}

fn role_slug_exists(
    connection: &Connection,
    slug: &str,
    exclude_role_id: Option<&str>,
) -> Result<bool, String> {
    let mut statement = connection
        .prepare("SELECT 1 FROM roles WHERE slug = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1")
        .map_err(|error| format!("Unable to prepare role slug lookup: {error}"))?;

    let found = statement
        .query_row(params![slug, exclude_role_id], |_| Ok(()))
        .optional()
        .map_err(|error| format!("Unable to query role slug {slug}: {error}"))?;

    Ok(found.is_some())
}

fn role_slug(name: &str) -> String {
    let slug = sanitize_slug(name);
    if slug == "project" {
        "role".into()
    } else {
        slug
    }
}

fn normalize_input(input: RoleUpsertInput) -> RoleUpsertInput {
    RoleUpsertInput {
        name: input.name.trim().to_string(),
        description: normalized_optional_string(input.description),
        system_prompt: normalized_optional_string(input.system_prompt),
        provider: normalized_optional_string(input.provider),
        model: normalized_optional_string(input.model),
        thinking_level: normalized_optional_string(input.thinking_level)
            .map(|value| value.to_lowercase()),
        capacity: input.capacity,
        compaction_window: normalized_optional_string(input.compaction_window),
        policy_ids: policies::normalize_string_list(input.policy_ids),
        direct_permissions: policies::normalize_string_list(input.direct_permissions),
    }
}

fn is_valid_thinking_level(value: &str) -> bool {
    matches!(
        value,
        "off" | "minimal" | "low" | "medium" | "high" | "xhigh"
    )
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

fn role_id() -> String {
    format!("role-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn validation_error(code: &str, path: &str, message: &str) -> RoleValidationError {
    RoleValidationError {
        code: code.into(),
        path: path.into(),
        message: message.into(),
    }
}

fn format_validation_errors(errors: &[RoleValidationError]) -> String {
    let joined = errors
        .iter()
        .map(|error| format!("{}: {}", error.path, error.message))
        .collect::<Vec<_>>()
        .join("; ");
    format!("Role validation failed: {joined}")
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{database::initialize_database_at, policies::create_policy};
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

    fn sample_role_input() -> RoleUpsertInput {
        RoleUpsertInput {
            name: "Reviewer".into(),
            description: Some("Checks implementation quality before landing.".into()),
            system_prompt: Some("Review the proposed code changes and report findings.".into()),
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet-4-20250514".into()),
            thinking_level: Some("medium".into()),
            capacity: 2,
            compaction_window: None,
            policy_ids: Vec::new(),
            direct_permissions: vec!["tasks.read".into(), "tasks.comment".into()],
        }
    }

    #[test]
    fn validates_role_inputs() {
        let connection = open_test_connection("roles-validation");
        let validation = validate_role(
            &connection,
            &RoleUpsertInput {
                name: "   ".into(),
                description: None,
                system_prompt: None,
                provider: Some("anthropic".into()),
                model: None,
                thinking_level: Some("turbo".into()),
                capacity: 0,
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation.errors.iter().any(|error| error.path == "name"));
        assert!(validation.errors.iter().any(|error| error.path == "model"));
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "thinkingLevel"));
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "capacity"));
    }

    #[test]
    fn creates_lists_updates_and_archives_roles() {
        let mut connection = open_test_connection("roles-crud");
        let created =
            create_role(&mut connection, sample_role_input()).expect("role should create");

        let supervisor_policy = create_policy(
            &mut connection,
            "supervisor",
            "Supervisor",
            None,
            &["*".into()],
            true,
            true,
        )
        .expect("policy should create");

        assert_eq!(created.slug, "reviewer");
        assert_eq!(
            list_roles(&connection, false)
                .expect("roles should list")
                .len(),
            1
        );

        let updated = update_role(
            &mut connection,
            &created.id,
            RoleUpsertInput {
                name: "Lead Reviewer".into(),
                description: Some("Owns review quality for the project.".into()),
                system_prompt: created.system_prompt.clone(),
                provider: created.provider.clone(),
                model: created.model.clone(),
                thinking_level: Some("high".into()),
                capacity: 3,
                compaction_window: None,
                policy_ids: vec![supervisor_policy.id.clone(), supervisor_policy.id.clone()],
                direct_permissions: vec!["tasks.transition".into(), "tasks.transition".into()],
            },
        )
        .expect("role should update");

        assert_eq!(updated.slug, "lead-reviewer");
        assert_eq!(updated.thinking_level, "high");
        assert_eq!(updated.capacity, 3);
        assert_eq!(updated.policy_ids, vec![supervisor_policy.id]);
        assert_eq!(
            updated.direct_permissions,
            vec!["tasks.transition".to_string()]
        );

        let archived = archive_role(&connection, &created.id).expect("role should archive");
        assert!(archived.archived);
        assert!(list_roles(&connection, false)
            .expect("active roles should list")
            .is_empty());
        assert_eq!(
            list_roles(&connection, true)
                .expect("all roles should list")
                .len(),
            1
        );
    }

    #[test]
    fn generates_unique_slugs_for_duplicate_role_names() {
        let mut connection = open_test_connection("roles-slugs");
        let first =
            create_role(&mut connection, sample_role_input()).expect("first role should create");
        let second =
            create_role(&mut connection, sample_role_input()).expect("second role should create");

        assert_eq!(first.slug, "reviewer");
        assert_eq!(second.slug, "reviewer-2");
    }
}
