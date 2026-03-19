use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{
        RoleDefinition, RoleSummary, RoleUpsertInput, RoleValidationError, RoleValidationResult,
    },
    services::orchestra_paths::sanitize_slug,
};

pub fn list_roles(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<RoleSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, description, provider, model, thinking_level, capacity, archived, created_at, updated_at
            FROM roles
            WHERE (?1 = 1 OR archived = 0)
            ORDER BY archived ASC, updated_at DESC, name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare role list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], |row| {
            Ok(RoleSummary {
                id: row.get(0)?,
                slug: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                provider: row.get(4)?,
                model: row.get(5)?,
                thinking_level: row.get(6)?,
                capacity: row.get(7)?,
                archived: row.get::<_, i64>(8)? != 0,
                created_at: row.get(9)?,
                updated_at: row.get(10)?,
            })
        })
        .map_err(|error| format!("Unable to query roles: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read role rows: {error}"))
}

pub fn get_role(connection: &Connection, role_id: &str) -> Result<RoleDefinition, String> {
    connection
        .query_row(
            r#"
            SELECT id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, archived, created_at, updated_at
            FROM roles
            WHERE id = ?1
            "#,
            [role_id],
            |row| {
                Ok(RoleDefinition {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    system_prompt: row.get(4)?,
                    provider: row.get(5)?,
                    model: row.get(6)?,
                    thinking_level: row.get(7)?,
                    capacity: row.get(8)?,
                    archived: row.get::<_, i64>(9)? != 0,
                    created_at: row.get(10)?,
                    updated_at: row.get(11)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query role {role_id}: {error}"))?
        .ok_or_else(|| format!("Role {role_id} was not found"))
}

pub fn validate_role(
    _connection: &Connection,
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
            "Thinking level must be one of: off, minimal, low, medium, high.",
        ));
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
            archived,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, 0, ?10, ?10)
        "#,
        params![
            role_id,
            slug,
            normalized.name,
            normalized.description,
            normalized.system_prompt,
            normalized.provider,
            normalized.model,
            normalized.thinking_level.clone().unwrap_or_else(|| "off".into()),
            normalized.capacity,
            now,
        ],
    )
    .map_err(|error| format!("Unable to create role: {error}"))?;

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
            updated_at = ?10
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
            normalized.thinking_level.clone().unwrap_or_else(|| "off".into()),
            normalized.capacity,
            now,
        ],
    )
    .map_err(|error| format!("Unable to update role {role_id}: {error}"))?;

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
        thinking_level: normalized_optional_string(input.thinking_level).map(|value| value.to_lowercase()),
        capacity: input.capacity,
    }
}

fn is_valid_thinking_level(value: &str) -> bool {
    matches!(value, "off" | "minimal" | "low" | "medium" | "high")
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

    fn sample_role_input() -> RoleUpsertInput {
        RoleUpsertInput {
            name: "Reviewer".into(),
            description: Some("Checks implementation quality before landing.".into()),
            system_prompt: Some("Review the proposed code changes and report findings.".into()),
            provider: Some("anthropic".into()),
            model: Some("claude-sonnet-4-20250514".into()),
            thinking_level: Some("medium".into()),
            capacity: 2,
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
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation.errors.iter().any(|error| error.path == "name"));
        assert!(validation.errors.iter().any(|error| error.path == "model"));
        assert!(validation.errors.iter().any(|error| error.path == "thinkingLevel"));
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
            },
        )
        .expect("role should update");

        assert_eq!(updated.slug, "lead-reviewer");
        assert_eq!(updated.thinking_level, "high");
        assert_eq!(updated.capacity, 3);

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
