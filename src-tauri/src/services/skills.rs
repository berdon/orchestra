use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{LocalSkillUpsertInput, SkillDetail, SkillSummary},
    services::{
        orchestra_paths::{default_orchestra_root, orchestra_local_skill_path, sanitize_slug},
        skill_bindings,
    },
};

const SKILL_SOURCE_LOCAL: &str = "local";
const SKILL_SOURCE_EXTERNAL: &str = "external";
const SKILL_STATUS_ACTIVE: &str = "active";
const SKILL_STATUS_SHADOWED: &str = "shadowed";
const SKILL_STATUS_MISSING: &str = "missing";
const SKILL_STATUS_INVALID: &str = "invalid";
const SKILL_STATUS_UNLOADABLE: &str = "unloadable";
const EXTERNAL_SKILL_FILE_NAME: &str = "SKILL.md";

#[derive(Debug, Clone)]
struct SkillRow {
    summary: SkillSummary,
}

#[derive(Debug, Clone)]
struct NormalizedLocalSkillInput {
    name: String,
    slug: String,
    markdown_body: String,
    description: Option<String>,
}

#[derive(Debug, Clone)]
struct ExternalSkillScanRecord {
    slug: Option<String>,
    name: String,
    description: Option<String>,
    source_path: String,
    content_path: String,
    relative_source_path: Option<String>,
    status: String,
    status_reason: Option<String>,
    last_seen_at: String,
}

#[derive(Debug, Clone)]
struct ExternalCandidate {
    id: String,
    slug: String,
    source_path: String,
    relative_source_path: Option<String>,
}

pub fn external_skills_dir_from_home(home_dir: &Path) -> PathBuf {
    home_dir.join(".agents").join("skills")
}

pub fn default_external_skills_dir() -> Result<PathBuf, String> {
    env::var_os("HOME")
        .map(PathBuf::from)
        .map(|home| external_skills_dir_from_home(&home))
        .ok_or_else(|| "HOME is not set; unable to resolve external skills directory".into())
}

pub fn list_skills(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<SkillSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                slug,
                name,
                description,
                source_kind,
                source_path,
                content_path,
                relative_source_path,
                archived,
                status,
                status_reason,
                shadowed_by_skill_id,
                last_seen_at,
                created_at,
                updated_at
            FROM skills
            WHERE (?1 = 1 OR archived = 0)
            ORDER BY
                archived ASC,
                CASE source_kind WHEN 'local' THEN 0 ELSE 1 END ASC,
                CASE status
                    WHEN 'active' THEN 0
                    WHEN 'shadowed' THEN 1
                    WHEN 'invalid' THEN 2
                    WHEN 'unloadable' THEN 3
                    WHEN 'missing' THEN 4
                    ELSE 5
                END ASC,
                name COLLATE NOCASE ASC,
                relative_source_path COLLATE NOCASE ASC,
                source_path COLLATE NOCASE ASC,
                updated_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare skills list query: {error}"))?;

    let rows = statement
        .query_map(
            [if include_archived { 1 } else { 0 }],
            map_skill_summary_row,
        )
        .map_err(|error| format!("Unable to query skills: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read skills: {error}"))?;

    Ok(rows.into_iter().map(|row| row.summary).collect())
}

pub fn get_skill(connection: &Connection, skill_id: &str) -> Result<SkillDetail, String> {
    let row = get_skill_row(connection, skill_id)?;
    Ok(SkillDetail {
        markdown_body: load_skill_markdown_body(&row.summary)?,
        binding_summary: skill_bindings::load_skill_binding_summary(connection, skill_id)?,
        bindings: skill_bindings::load_skill_bindings(connection, skill_id)?,
        summary: row.summary,
    })
}

pub fn create_local_skill(
    connection: &mut Connection,
    orchestra_root: &Path,
    input: LocalSkillUpsertInput,
) -> Result<SkillDetail, String> {
    let normalized = normalize_local_skill_input(input)?;
    ensure_local_slug_available(connection, &normalized.slug, None)?;

    let skill_id = format!("skill-{}", Uuid::new_v4().simple());
    let now = now_iso();
    let skill_path = orchestra_local_skill_path(orchestra_root, &normalized.slug);
    let skill_path_text = skill_path.display().to_string();

    write_markdown_body_atomically(&skill_path, &normalized.markdown_body)?;

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start local skill creation transaction: {error}"))?;
    let insert_result = tx.execute(
        r#"
        INSERT INTO skills (
            id,
            slug,
            name,
            description,
            source_kind,
            source_path,
            content_path,
            relative_source_path,
            archived,
            status,
            status_reason,
            shadowed_by_skill_id,
            last_seen_at,
            created_at,
            updated_at
        )
        VALUES (?1, ?2, ?3, ?4, 'local', ?5, ?5, NULL, 0, 'active', NULL, NULL, NULL, ?6, ?6)
        "#,
        params![
            skill_id,
            normalized.slug,
            normalized.name,
            normalized.description,
            skill_path_text,
            now,
        ],
    );

    if let Err(error) = insert_result {
        let _ = fs::remove_file(&skill_path);
        return Err(format!("Unable to create local skill: {error}"));
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit local skill creation: {error}"))?;

    reconcile_skill_shadowing(connection)?;
    get_skill(connection, &skill_id)
}

pub fn update_local_skill(
    connection: &mut Connection,
    orchestra_root: &Path,
    skill_id: &str,
    input: LocalSkillUpsertInput,
) -> Result<SkillDetail, String> {
    let existing = get_skill_row(connection, skill_id)?;
    ensure_local_skill_row(&existing.summary, skill_id)?;

    let normalized = normalize_local_skill_input(input)?;
    ensure_local_slug_available(connection, &normalized.slug, Some(skill_id))?;

    let previous_path = PathBuf::from(&existing.summary.content_path);
    let next_path = orchestra_local_skill_path(orchestra_root, &normalized.slug);
    let next_path_text = next_path.display().to_string();
    let now = now_iso();

    write_markdown_body_atomically(&next_path, &normalized.markdown_body)?;

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start local skill update transaction: {error}"))?;
    let update_result = tx.execute(
        r#"
        UPDATE skills
        SET slug = ?2,
            name = ?3,
            description = ?4,
            source_path = ?5,
            content_path = ?5,
            archived = archived,
            status = 'active',
            status_reason = NULL,
            shadowed_by_skill_id = NULL,
            updated_at = ?6
        WHERE id = ?1 AND source_kind = 'local'
        "#,
        params![
            skill_id,
            normalized.slug,
            normalized.name,
            normalized.description,
            next_path_text,
            now,
        ],
    );

    if let Err(error) = update_result {
        if next_path != previous_path {
            let _ = fs::remove_file(&next_path);
        }
        return Err(format!("Unable to update local skill {skill_id}: {error}"));
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit local skill update: {error}"))?;

    if next_path != previous_path {
        let _ = fs::remove_file(previous_path);
    }

    reconcile_skill_shadowing(connection)?;
    get_skill(connection, skill_id)
}

pub fn set_local_skill_archived(
    connection: &Connection,
    skill_id: &str,
    archived: bool,
) -> Result<SkillDetail, String> {
    let existing = get_skill_row(connection, skill_id)?;
    ensure_local_skill_row(&existing.summary, skill_id)?;

    connection
        .execute(
            "UPDATE skills SET archived = ?2, status = 'active', status_reason = NULL, shadowed_by_skill_id = NULL, updated_at = ?3 WHERE id = ?1 AND source_kind = 'local'",
            params![skill_id, if archived { 1 } else { 0 }, now_iso()],
        )
        .map_err(|error| format!("Unable to update archived state for local skill {skill_id}: {error}"))?;

    reconcile_skill_shadowing(connection)?;
    get_skill(connection, skill_id)
}

pub fn delete_local_skill(connection: &Connection, skill_id: &str) -> Result<SkillDetail, String> {
    let existing = get_skill(connection, skill_id)?;
    ensure_local_skill_row(&existing.summary, skill_id)?;

    let binding_count = connection
        .query_row(
            "SELECT COUNT(1) FROM skill_scope_bindings WHERE skill_id = ?1",
            [skill_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Unable to query bindings for local skill {skill_id}: {error}"))?;
    if binding_count > 0 {
        return Err(format!(
            "Local skill {skill_id} cannot be deleted while {binding_count} scope binding(s) still reference it."
        ));
    }

    connection
        .execute(
            "DELETE FROM skills WHERE id = ?1 AND source_kind = 'local'",
            [skill_id],
        )
        .map_err(|error| format!("Unable to delete local skill {skill_id}: {error}"))?;

    let local_path = PathBuf::from(&existing.summary.content_path);
    match fs::remove_file(&local_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            return Err(format!(
                "Local skill {} was removed from the catalog but its markdown file {} could not be deleted: {error}",
                skill_id,
                local_path.display()
            ));
        }
    }

    reconcile_skill_shadowing(connection)?;
    Ok(existing)
}

pub fn refresh_external_skills(
    connection: &mut Connection,
    external_skills_root: &Path,
) -> Result<Vec<SkillSummary>, String> {
    let now = now_iso();
    let discovered = discover_external_skill_records(external_skills_root, &now)?;

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start external skill refresh transaction: {error}"))?;

    let mut existing_rows = tx
        .prepare(
            r#"
            SELECT source_path, id
            FROM skills
            WHERE source_kind = 'external'
            "#,
        )
        .map_err(|error| format!("Unable to prepare existing external skills query: {error}"))?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Unable to query existing external skills: {error}"))?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|error| format!("Unable to collect existing external skills: {error}"))?;

    for record in discovered {
        if let Some(existing_id) = existing_rows.remove(&record.source_path) {
            tx.execute(
                r#"
                UPDATE skills
                SET slug = ?2,
                    name = ?3,
                    description = ?4,
                    content_path = ?5,
                    relative_source_path = ?6,
                    archived = 0,
                    status = ?7,
                    status_reason = ?8,
                    shadowed_by_skill_id = NULL,
                    last_seen_at = ?9,
                    updated_at = ?10
                WHERE id = ?1
                "#,
                params![
                    existing_id,
                    record.slug,
                    record.name,
                    record.description,
                    record.content_path,
                    record.relative_source_path,
                    record.status,
                    record.status_reason,
                    record.last_seen_at,
                    now,
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to update external skill record at {}: {error}",
                    record.source_path
                )
            })?;
        } else {
            tx.execute(
                r#"
                INSERT INTO skills (
                    id,
                    slug,
                    name,
                    description,
                    source_kind,
                    source_path,
                    content_path,
                    relative_source_path,
                    archived,
                    status,
                    status_reason,
                    shadowed_by_skill_id,
                    last_seen_at,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, ?3, ?4, 'external', ?5, ?6, ?7, 0, ?8, ?9, NULL, ?10, ?10, ?11)
                "#,
                params![
                    format!("skill-{}", Uuid::new_v4().simple()),
                    record.slug,
                    record.name,
                    record.description,
                    record.source_path,
                    record.content_path,
                    record.relative_source_path,
                    record.status,
                    record.status_reason,
                    record.last_seen_at,
                    now,
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to insert external skill record at {}: {error}",
                    record.source_path
                )
            })?;
        }
    }

    for (source_path, skill_id) in existing_rows {
        tx.execute(
            r#"
            UPDATE skills
            SET status = 'missing',
                status_reason = 'Skill directory was not found during the latest external discovery refresh.',
                shadowed_by_skill_id = NULL,
                updated_at = ?2
            WHERE id = ?1
            "#,
            params![skill_id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to mark missing external skill record at {}: {error}",
                source_path
            )
        })?;
    }

    reconcile_skill_shadowing(&tx)?;
    tx.commit()
        .map_err(|error| format!("Unable to commit external skill refresh: {error}"))?;

    list_skills(connection, true)
}

pub fn default_orchestra_root_for_skills() -> Result<PathBuf, String> {
    default_orchestra_root()
}

fn get_skill_row(connection: &Connection, skill_id: &str) -> Result<SkillRow, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                slug,
                name,
                description,
                source_kind,
                source_path,
                content_path,
                relative_source_path,
                archived,
                status,
                status_reason,
                shadowed_by_skill_id,
                last_seen_at,
                created_at,
                updated_at
            FROM skills
            WHERE id = ?1
            "#,
            [skill_id],
            map_skill_summary_row,
        )
        .optional()
        .map_err(|error| format!("Unable to query skill {skill_id}: {error}"))?
        .ok_or_else(|| format!("Skill {skill_id} was not found"))
}

fn map_skill_summary_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<SkillRow> {
    Ok(SkillRow {
        summary: SkillSummary {
            id: row.get(0)?,
            slug: row.get(1)?,
            name: row.get(2)?,
            description: row.get(3)?,
            source_kind: row.get(4)?,
            source_path: row.get(5)?,
            content_path: row.get(6)?,
            relative_source_path: row.get(7)?,
            archived: row.get::<_, i64>(8)? != 0,
            status: row.get(9)?,
            status_reason: row.get(10)?,
            shadowed_by_skill_id: row.get(11)?,
            last_seen_at: row.get(12)?,
            created_at: row.get(13)?,
            updated_at: row.get(14)?,
        },
    })
}

fn ensure_local_skill_row(summary: &SkillSummary, skill_id: &str) -> Result<(), String> {
    if summary.source_kind == SKILL_SOURCE_LOCAL {
        Ok(())
    } else {
        Err(format!(
            "Skill {skill_id} is read-only because it is sourced from ~/.agents/skills"
        ))
    }
}

fn ensure_local_slug_available(
    connection: &Connection,
    slug: &str,
    excluding_skill_id: Option<&str>,
) -> Result<(), String> {
    let duplicate = connection
        .query_row(
            r#"
            SELECT id
            FROM skills
            WHERE source_kind = 'local'
              AND slug = ?1
              AND (?2 IS NULL OR id != ?2)
            LIMIT 1
            "#,
            params![slug, excluding_skill_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to validate local skill slug {slug}: {error}"))?;

    if let Some(existing_id) = duplicate {
        Err(format!(
            "Local skill slug {slug} is already used by skill {existing_id}."
        ))
    } else {
        Ok(())
    }
}

fn normalize_local_skill_input(
    input: LocalSkillUpsertInput,
) -> Result<NormalizedLocalSkillInput, String> {
    let name = input.name.trim().to_string();
    if name.is_empty() {
        return Err("Skill name is required.".into());
    }

    let markdown_body = normalize_markdown_body(&input.markdown_body);
    if markdown_body.trim().is_empty() {
        return Err("Skill markdown body must contain non-empty markdown content.".into());
    }

    let slug = match input
        .slug
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
    {
        Some(value) => {
            if !is_valid_skill_slug(value) {
                return Err(format!(
                    "Skill slug {value} is invalid. Use lowercase letters, numbers, and single dashes only."
                ));
            }
            value.to_string()
        }
        None => {
            let derived = sanitize_slug(&name);
            if !is_valid_skill_slug(&derived) {
                return Err(format!(
                    "Derived skill slug {derived} is invalid. Use a different name or provide an explicit slug."
                ));
            }
            derived
        }
    };

    Ok(NormalizedLocalSkillInput {
        description: derive_skill_description(&markdown_body),
        markdown_body,
        name,
        slug,
    })
}

fn normalize_markdown_body(value: &str) -> String {
    value.replace("\r\n", "\n").replace('\r', "\n")
}

fn load_skill_markdown_body(summary: &SkillSummary) -> Result<Option<String>, String> {
    let path = Path::new(&summary.content_path);
    match summary.source_kind.as_str() {
        SKILL_SOURCE_LOCAL => fs::read_to_string(path)
            .map(|content| Some(normalize_markdown_body(&content)))
            .map_err(|error| {
                format!(
                    "Unable to read local skill markdown at {}: {error}",
                    path.display()
                )
            }),
        SKILL_SOURCE_EXTERNAL => match fs::read_to_string(path) {
            Ok(content) => Ok(Some(normalize_markdown_body(&content))),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(_) if summary.status == SKILL_STATUS_UNLOADABLE => Ok(None),
            Err(_) if summary.status == SKILL_STATUS_MISSING => Ok(None),
            Err(error) => Err(format!(
                "Unable to read external skill markdown at {}: {error}",
                path.display()
            )),
        },
        _ => Ok(None),
    }
}

fn write_markdown_body_atomically(path: &Path, markdown_body: &str) -> Result<(), String> {
    let parent = path
        .parent()
        .ok_or_else(|| format!("Skill path {} has no parent directory", path.display()))?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Unable to create skill directory {}: {error}",
            parent.display()
        )
    })?;

    let temp_path = parent.join(format!(
        ".{}.tmp-{}-{}",
        path.file_name()
            .and_then(|name| name.to_str())
            .unwrap_or("skill.md"),
        std::process::id(),
        Uuid::new_v4().simple()
    ));

    fs::write(&temp_path, markdown_body).map_err(|error| {
        format!(
            "Unable to write skill temp file {}: {error}",
            temp_path.display()
        )
    })?;

    if path.exists() {
        fs::remove_file(path).map_err(|error| {
            format!(
                "Unable to replace skill markdown {}: {error}",
                path.display()
            )
        })?;
    }

    fs::rename(&temp_path, path).map_err(|error| {
        format!(
            "Unable to move skill temp file {} into place at {}: {error}",
            temp_path.display(),
            path.display()
        )
    })?;

    Ok(())
}

fn discover_external_skill_records(
    external_skills_root: &Path,
    now: &str,
) -> Result<Vec<ExternalSkillScanRecord>, String> {
    let mut skill_directories = Vec::new();
    walk_external_skill_directories(
        external_skills_root,
        external_skills_root,
        &mut skill_directories,
    )?;
    skill_directories
        .into_iter()
        .map(|directory| inspect_external_skill_directory(external_skills_root, &directory, now))
        .collect()
}

fn walk_external_skill_directories(
    root: &Path,
    current: &Path,
    directories: &mut Vec<PathBuf>,
) -> Result<(), String> {
    if !root.exists() || !root.is_dir() {
        return Ok(());
    }
    if !current.exists() || !current.is_dir() {
        return Ok(());
    }

    if current != root && current.join(EXTERNAL_SKILL_FILE_NAME).is_file() {
        directories.push(current.to_path_buf());
    }

    let mut children = fs::read_dir(current)
        .map_err(|error| {
            format!(
                "Unable to read external skills directory {}: {error}",
                current.display()
            )
        })?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| {
            format!(
                "Unable to enumerate external skills directory {}: {error}",
                current.display()
            )
        })?;
    children.sort_by_key(|entry| entry.file_name());

    for child in children {
        let child_path = child.path();
        if child
            .file_type()
            .map_err(|error| {
                format!(
                    "Unable to inspect external skills path {}: {error}",
                    child_path.display()
                )
            })?
            .is_dir()
        {
            walk_external_skill_directories(root, &child_path, directories)?;
        }
    }

    Ok(())
}

fn inspect_external_skill_directory(
    external_skills_root: &Path,
    directory: &Path,
    now: &str,
) -> Result<ExternalSkillScanRecord, String> {
    let skill_file = directory.join(EXTERNAL_SKILL_FILE_NAME);
    let relative_source_path = directory
        .strip_prefix(external_skills_root)
        .ok()
        .map(path_to_slash_string);
    let source_path = fs::canonicalize(directory)
        .unwrap_or_else(|_| directory.to_path_buf())
        .display()
        .to_string();
    let content_path = fs::canonicalize(&skill_file)
        .unwrap_or_else(|_| skill_file.clone())
        .display()
        .to_string();

    let Some(directory_name) = directory.file_name().and_then(|value| value.to_str()) else {
        return Ok(ExternalSkillScanRecord {
            slug: None,
            name: relative_source_path
                .clone()
                .unwrap_or_else(|| source_path.clone()),
            description: None,
            source_path,
            content_path,
            relative_source_path,
            status: SKILL_STATUS_UNLOADABLE.into(),
            status_reason: Some(
                "Unable to derive a UTF-8 skill slug from the external skill directory name."
                    .into(),
            ),
            last_seen_at: now.to_string(),
        });
    };

    let slug = directory_name.to_string();
    let mut validation_errors: Vec<String> = Vec::new();
    if !is_valid_skill_slug(&slug) {
        validation_errors.push(
            "Directory name must use lowercase letters, numbers, and single dashes only.".into(),
        );
    }

    let markdown_body = match fs::read_to_string(&skill_file) {
        Ok(content) => normalize_markdown_body(&content),
        Err(error) => {
            return Ok(ExternalSkillScanRecord {
                slug: Some(slug.clone()),
                name: slug.clone(),
                description: None,
                source_path,
                content_path,
                relative_source_path,
                status: SKILL_STATUS_UNLOADABLE.into(),
                status_reason: Some(format!(
                    "The external skill markdown file could not be read: {error}"
                )),
                last_seen_at: now.to_string(),
            })
        }
    };

    if markdown_body.trim().is_empty() {
        validation_errors
            .push("Skill markdown body must contain non-empty markdown content.".into());
    }

    if validation_errors.is_empty() {
        Ok(ExternalSkillScanRecord {
            slug: Some(slug.clone()),
            name: slug,
            description: derive_skill_description(&markdown_body),
            source_path,
            content_path,
            relative_source_path,
            status: SKILL_STATUS_ACTIVE.into(),
            status_reason: None,
            last_seen_at: now.to_string(),
        })
    } else {
        Ok(ExternalSkillScanRecord {
            slug: if is_valid_skill_slug(&slug) {
                Some(slug.clone())
            } else {
                None
            },
            name: slug,
            description: derive_skill_description(&markdown_body),
            source_path,
            content_path,
            relative_source_path,
            status: SKILL_STATUS_INVALID.into(),
            status_reason: Some(validation_errors.join(" ")),
            last_seen_at: now.to_string(),
        })
    }
}

fn reconcile_skill_shadowing(connection: &Connection) -> Result<(), String> {
    connection
        .execute(
            "UPDATE skills SET status = 'active', status_reason = NULL, shadowed_by_skill_id = NULL WHERE source_kind = 'local'",
            [],
        )
        .map_err(|error| format!("Unable to normalize local skill state: {error}"))?;

    let local_skill_rows = connection
        .prepare(
            r#"
            SELECT slug, id
            FROM skills
            WHERE source_kind = 'local'
              AND archived = 0
              AND slug IS NOT NULL
              AND trim(slug) != ''
            "#,
        )
        .map_err(|error| format!("Unable to prepare local skill shadow query: {error}"))?
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Unable to query local skill shadow state: {error}"))?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(|error| format!("Unable to collect local skill shadow state: {error}"))?;

    connection
        .execute(
            "UPDATE skills SET status = 'active', status_reason = NULL, shadowed_by_skill_id = NULL WHERE source_kind = 'external' AND status NOT IN ('missing', 'invalid', 'unloadable')",
            [],
        )
        .map_err(|error| format!("Unable to reset external skill shadow state: {error}"))?;

    let external_candidates = connection
        .prepare(
            r#"
            SELECT id, slug, source_path, relative_source_path
            FROM skills
            WHERE source_kind = 'external'
              AND status NOT IN ('missing', 'invalid', 'unloadable')
              AND slug IS NOT NULL
              AND trim(slug) != ''
            ORDER BY slug ASC, relative_source_path ASC, source_path ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare external skill shadow query: {error}"))?
        .query_map([], |row| {
            Ok(ExternalCandidate {
                id: row.get(0)?,
                slug: row.get(1)?,
                source_path: row.get(2)?,
                relative_source_path: row.get(3)?,
            })
        })
        .map_err(|error| format!("Unable to query external skill shadow state: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect external skill shadow state: {error}"))?;

    let mut grouped = BTreeMap::<String, Vec<ExternalCandidate>>::new();
    for candidate in external_candidates {
        grouped
            .entry(candidate.slug.clone())
            .or_default()
            .push(candidate);
    }

    for (slug, mut candidates) in grouped {
        candidates.sort_by(|left, right| {
            left.relative_source_path
                .cmp(&right.relative_source_path)
                .then_with(|| left.source_path.cmp(&right.source_path))
                .then_with(|| left.id.cmp(&right.id))
        });

        if let Some(local_skill_id) = local_skill_rows.get(&slug) {
            for candidate in candidates {
                connection
                    .execute(
                        "UPDATE skills SET status = 'shadowed', status_reason = ?2, shadowed_by_skill_id = ?3 WHERE id = ?1",
                        params![
                            candidate.id,
                            format!("Shadowed by local Orchestra-managed skill slug {slug}."),
                            local_skill_id,
                        ],
                    )
                    .map_err(|error| {
                        format!("Unable to mark external skill {} shadowed by local winner: {error}", candidate.id)
                    })?;
            }
            continue;
        }

        if let Some((winner, losers)) = candidates.split_first() {
            connection
                .execute(
                    "UPDATE skills SET status = 'active', status_reason = NULL, shadowed_by_skill_id = NULL WHERE id = ?1",
                    [&winner.id],
                )
                .map_err(|error| format!("Unable to mark external skill {} active: {error}", winner.id))?;

            for loser in losers {
                let winner_path = winner
                    .relative_source_path
                    .clone()
                    .unwrap_or_else(|| winner.source_path.clone());
                connection
                    .execute(
                        "UPDATE skills SET status = 'shadowed', status_reason = ?2, shadowed_by_skill_id = ?3 WHERE id = ?1",
                        params![
                            loser.id,
                            format!(
                                "Shadowed by external skill at {} after deterministic lexicographic collision resolution.",
                                winner_path
                            ),
                            winner.id,
                        ],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to mark external skill {} shadowed by winning external source: {error}",
                            loser.id
                        )
                    })?;
            }
        }
    }

    Ok(())
}

fn derive_skill_description(markdown: &str) -> Option<String> {
    let normalized = normalize_markdown_body(markdown);
    let mut in_code_fence = false;
    let mut paragraphs = Vec::<String>::new();
    let mut current = Vec::<String>::new();

    for line in normalized.lines() {
        let trimmed = line.trim();
        if trimmed.starts_with("```") {
            in_code_fence = !in_code_fence;
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
            continue;
        }

        if in_code_fence {
            continue;
        }

        if trimmed.is_empty() {
            if !current.is_empty() {
                paragraphs.push(current.join(" "));
                current.clear();
            }
            continue;
        }

        current.push(trimmed.to_string());
    }

    if !current.is_empty() {
        paragraphs.push(current.join(" "));
    }

    paragraphs
        .into_iter()
        .map(|paragraph| collapse_whitespace(&paragraph))
        .find(|paragraph| {
            !paragraph.is_empty()
                && !paragraph.starts_with('#')
                && !paragraph.chars().all(|character| character == '-')
        })
}

fn collapse_whitespace(value: &str) -> String {
    value.split_whitespace().collect::<Vec<_>>().join(" ")
}

fn is_valid_skill_slug(value: &str) -> bool {
    if value.is_empty() {
        return false;
    }

    let segments = value.split('-');
    segments.clone().all(|segment| {
        !segment.is_empty()
            && segment
                .chars()
                .all(|character| character.is_ascii_lowercase() || character.is_ascii_digit())
    }) && !value.starts_with('-')
        && !value.ends_with('-')
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn path_to_slash_string(path: &Path) -> String {
    path.components()
        .map(|component| component.as_os_str().to_string_lossy().into_owned())
        .collect::<Vec<_>>()
        .join("/")
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn unique_temp_dir(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_nanos()
        );
        std::env::temp_dir().join(suffix)
    }

    fn test_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database should open");
        connection
            .pragma_update(None, "foreign_keys", "ON")
            .expect("foreign keys should enable");
        crate::services::database::apply_migrations(&connection).expect("schema should initialize");
        connection
    }

    fn find_skill_by_slug(connection: &Connection, slug: &str, source_kind: &str) -> SkillSummary {
        list_skills(connection, true)
            .expect("skills should list")
            .into_iter()
            .find(|skill| skill.slug.as_deref() == Some(slug) && skill.source_kind == source_kind)
            .expect("matching skill should exist")
    }

    #[test]
    fn creates_updates_archives_and_deletes_local_skills() {
        let root = unique_temp_dir("skills-local-crud");
        let mut connection = test_connection();

        let created = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "My Skill".into(),
                slug: None,
                markdown_body: "First paragraph.\n\nSecond paragraph.".into(),
            },
        )
        .expect("local skill should create");

        assert_eq!(created.summary.slug.as_deref(), Some("my-skill"));
        assert_eq!(
            created.summary.description.as_deref(),
            Some("First paragraph.")
        );
        let created_path = orchestra_local_skill_path(&root, "my-skill");
        assert_eq!(
            fs::read_to_string(&created_path).expect("created skill file should exist"),
            "First paragraph.\n\nSecond paragraph."
        );

        let updated = update_local_skill(
            &mut connection,
            &root,
            &created.summary.id,
            LocalSkillUpsertInput {
                name: "Renamed Skill".into(),
                slug: Some("renamed-skill".into()),
                markdown_body: "# Heading\n\nUpdated description paragraph.\n\nMore detail.".into(),
            },
        )
        .expect("local skill should update");

        assert_eq!(updated.summary.id, created.summary.id);
        assert_eq!(updated.summary.slug.as_deref(), Some("renamed-skill"));
        assert_eq!(
            updated.summary.description.as_deref(),
            Some("Updated description paragraph.")
        );
        assert!(!created_path.exists());
        let renamed_path = orchestra_local_skill_path(&root, "renamed-skill");
        assert_eq!(
            fs::read_to_string(&renamed_path).expect("renamed skill file should exist"),
            "# Heading\n\nUpdated description paragraph.\n\nMore detail."
        );

        let archived = set_local_skill_archived(&connection, &updated.summary.id, true)
            .expect("local skill should archive");
        assert!(archived.summary.archived);

        let unarchived = set_local_skill_archived(&connection, &updated.summary.id, false)
            .expect("local skill should unarchive");
        assert!(!unarchived.summary.archived);

        let deleted = delete_local_skill(&connection, &updated.summary.id)
            .expect("local skill should delete");
        assert_eq!(deleted.summary.id, updated.summary.id);
        assert!(!renamed_path.exists());
        assert!(list_skills(&connection, true)
            .expect("skills should list after delete")
            .into_iter()
            .all(|skill| skill.id != updated.summary.id));
    }

    #[test]
    fn enforces_local_slug_validation_and_duplicate_rejection() {
        let root = unique_temp_dir("skills-local-validation");
        let mut connection = test_connection();

        create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Alpha".into(),
                slug: Some("alpha-skill".into()),
                markdown_body: "Alpha body".into(),
            },
        )
        .expect("first local skill should create");

        let duplicate_error = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Duplicate".into(),
                slug: Some("alpha-skill".into()),
                markdown_body: "Duplicate body".into(),
            },
        )
        .expect_err("duplicate local slug should fail");
        assert!(duplicate_error.contains("already used"));

        let invalid_slug_error = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Invalid".into(),
                slug: Some("Bad_Slug".into()),
                markdown_body: "Invalid body".into(),
            },
        )
        .expect_err("invalid local slug should fail");
        assert!(invalid_slug_error.contains("invalid"));

        let empty_body_error = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Empty".into(),
                slug: None,
                markdown_body: "   \n\n  ".into(),
            },
        )
        .expect_err("empty markdown body should fail");
        assert!(empty_body_error.contains("non-empty markdown content"));
    }

    #[test]
    fn derives_description_from_first_non_empty_markdown_paragraph() {
        let root = unique_temp_dir("skills-description");
        let mut connection = test_connection();

        let created = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Description Skill".into(),
                slug: None,
                markdown_body: "# Heading\n\nFirst   paragraph line\nwraps here.\n\n```md\nignored\n```\n\nSecond paragraph.".into(),
            },
        )
        .expect("skill should create");

        assert_eq!(
            created.summary.description.as_deref(),
            Some("First paragraph line wraps here.")
        );
    }

    #[test]
    fn discovers_external_skills_recursively_and_ignores_root_markdown_files() {
        let external_root = unique_temp_dir("skills-external-discovery");
        fs::create_dir_all(&external_root).expect("external root should exist");
        fs::write(external_root.join("ignored.md"), "Should be ignored")
            .expect("ignored root file should write");
        fs::create_dir_all(external_root.join("alpha")).expect("alpha dir should exist");
        fs::write(
            external_root.join("alpha").join("SKILL.md"),
            "Alpha description.",
        )
        .expect("alpha skill should write");
        fs::create_dir_all(external_root.join("nested").join("beta"))
            .expect("nested beta dir should exist");
        fs::write(
            external_root.join("nested").join("beta").join("SKILL.md"),
            "Beta description.",
        )
        .expect("beta skill should write");

        let mut connection = test_connection();
        let refreshed = refresh_external_skills(&mut connection, &external_root)
            .expect("external skills should refresh");

        assert_eq!(
            refreshed
                .iter()
                .filter(|skill| skill.source_kind == SKILL_SOURCE_EXTERNAL)
                .count(),
            2
        );
        let alpha = find_skill_by_slug(&connection, "alpha", SKILL_SOURCE_EXTERNAL);
        assert_eq!(alpha.relative_source_path.as_deref(), Some("alpha"));
        let beta = find_skill_by_slug(&connection, "beta", SKILL_SOURCE_EXTERNAL);
        assert_eq!(beta.relative_source_path.as_deref(), Some("nested/beta"));
        assert!(list_skills(&connection, true)
            .expect("skills should list")
            .into_iter()
            .all(|skill| skill.name != "ignored.md"));
    }

    #[test]
    fn resolves_external_collisions_deterministically_by_relative_path() {
        let external_root = unique_temp_dir("skills-external-collision");
        fs::create_dir_all(external_root.join("a").join("shared"))
            .expect("first shared dir should exist");
        fs::create_dir_all(external_root.join("z").join("shared"))
            .expect("second shared dir should exist");
        fs::write(
            external_root.join("a").join("shared").join("SKILL.md"),
            "Shared description A.",
        )
        .expect("first shared skill should write");
        fs::write(
            external_root.join("z").join("shared").join("SKILL.md"),
            "Shared description Z.",
        )
        .expect("second shared skill should write");

        let mut connection = test_connection();
        refresh_external_skills(&mut connection, &external_root)
            .expect("external skills should refresh");

        let shared_rows = list_skills(&connection, true)
            .expect("skills should list")
            .into_iter()
            .filter(|skill| skill.slug.as_deref() == Some("shared"))
            .collect::<Vec<_>>();
        assert_eq!(shared_rows.len(), 2);

        let winner = shared_rows
            .iter()
            .find(|skill| skill.relative_source_path.as_deref() == Some("a/shared"))
            .expect("a/shared should exist");
        let loser = shared_rows
            .iter()
            .find(|skill| skill.relative_source_path.as_deref() == Some("z/shared"))
            .expect("z/shared should exist");

        assert_eq!(winner.status, SKILL_STATUS_ACTIVE);
        assert_eq!(loser.status, SKILL_STATUS_SHADOWED);
        assert_eq!(
            loser.shadowed_by_skill_id.as_deref(),
            Some(winner.id.as_str())
        );
    }

    #[test]
    fn local_skills_shadow_external_rows_and_archiving_releases_shadow() {
        let root = unique_temp_dir("skills-local-shadow-root");
        let external_root = unique_temp_dir("skills-local-shadow-external");
        fs::create_dir_all(external_root.join("shared")).expect("shared external dir should exist");
        fs::write(
            external_root.join("shared").join("SKILL.md"),
            "External shared skill.",
        )
        .expect("shared external skill should write");

        let mut connection = test_connection();
        refresh_external_skills(&mut connection, &external_root)
            .expect("external skills should refresh");
        let external_before = find_skill_by_slug(&connection, "shared", SKILL_SOURCE_EXTERNAL);
        assert_eq!(external_before.status, SKILL_STATUS_ACTIVE);

        let local = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Shared".into(),
                slug: Some("shared".into()),
                markdown_body: "Local shared skill.".into(),
            },
        )
        .expect("local shared skill should create");
        let external_shadowed = find_skill_by_slug(&connection, "shared", SKILL_SOURCE_EXTERNAL);
        assert_eq!(external_shadowed.status, SKILL_STATUS_SHADOWED);
        assert_eq!(
            external_shadowed.shadowed_by_skill_id.as_deref(),
            Some(local.summary.id.as_str())
        );

        set_local_skill_archived(&connection, &local.summary.id, true)
            .expect("local shared skill should archive");
        let external_active_again =
            find_skill_by_slug(&connection, "shared", SKILL_SOURCE_EXTERNAL);
        assert_eq!(external_active_again.status, SKILL_STATUS_ACTIVE);
        assert_eq!(external_active_again.shadowed_by_skill_id, None);
    }

    #[test]
    fn tracks_missing_invalid_and_unloadable_external_statuses_across_refreshes() {
        let external_root = unique_temp_dir("skills-external-statuses");
        fs::create_dir_all(external_root.join("valid-skill")).expect("valid dir should exist");
        fs::write(
            external_root.join("valid-skill").join("SKILL.md"),
            "Valid description.",
        )
        .expect("valid skill should write");

        fs::create_dir_all(external_root.join("bad_slug")).expect("invalid slug dir should exist");
        fs::write(
            external_root.join("bad_slug").join("SKILL.md"),
            "Invalid slug description.",
        )
        .expect("invalid slug skill should write");

        fs::create_dir_all(external_root.join("unloadable")).expect("unloadable dir should exist");
        fs::write(
            external_root.join("unloadable").join("SKILL.md"),
            vec![0xFF, 0xFE, 0xFD],
        )
        .expect("unloadable skill should write raw bytes");

        let mut connection = test_connection();
        refresh_external_skills(&mut connection, &external_root)
            .expect("first refresh should succeed");

        let valid = find_skill_by_slug(&connection, "valid-skill", SKILL_SOURCE_EXTERNAL);
        assert_eq!(valid.status, SKILL_STATUS_ACTIVE);

        let invalid = list_skills(&connection, true)
            .expect("skills should list")
            .into_iter()
            .find(|skill| skill.relative_source_path.as_deref() == Some("bad_slug"))
            .expect("invalid skill should exist");
        assert_eq!(invalid.status, SKILL_STATUS_INVALID);

        let unloadable = find_skill_by_slug(&connection, "unloadable", SKILL_SOURCE_EXTERNAL);
        assert_eq!(unloadable.status, SKILL_STATUS_UNLOADABLE);

        fs::remove_dir_all(external_root.join("valid-skill"))
            .expect("valid skill directory should remove");
        refresh_external_skills(&mut connection, &external_root)
            .expect("second refresh should succeed");

        let missing = list_skills(&connection, true)
            .expect("skills should list")
            .into_iter()
            .find(|skill| skill.id == valid.id)
            .expect("previously valid skill should still exist");
        assert_eq!(missing.status, SKILL_STATUS_MISSING);
    }

    #[test]
    fn reports_binding_summary_counts_in_skill_detail() {
        let root = unique_temp_dir("skills-binding-summary");
        let mut connection = test_connection();
        let created = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Bound Skill".into(),
                slug: None,
                markdown_body: "Bound description.".into(),
            },
        )
        .expect("local skill should create");

        let now = now_iso();
        connection
            .execute(
                r#"
                INSERT INTO skill_scope_bindings (
                    id,
                    skill_id,
                    scope_kind,
                    project_id,
                    role_id,
                    agent_id,
                    workflow_id,
                    workflow_lane_id,
                    created_at,
                    updated_at
                )
                VALUES
                    (?1, ?2, 'global', NULL, NULL, NULL, NULL, NULL, ?4, ?4),
                    (?3, ?2, 'workflow_lane', NULL, NULL, NULL, 'workflow-1', 'lane-1', ?4, ?4)
                "#,
                params!["binding-1", created.summary.id, "binding-2", now],
            )
            .expect("bindings should insert");

        let detail = get_skill(&connection, &created.summary.id).expect("skill detail should load");
        assert_eq!(detail.binding_summary.total_count, 2);
        assert_eq!(
            detail
                .binding_summary
                .scope_counts
                .iter()
                .map(|entry| (entry.scope_kind.as_str(), entry.count))
                .collect::<Vec<_>>(),
            vec![("global", 1), ("workflow_lane", 1)]
        );
    }

    #[test]
    fn rejects_local_skill_deletion_when_bindings_exist() {
        let root = unique_temp_dir("skills-delete-bindings");
        let mut connection = test_connection();
        let created = create_local_skill(
            &mut connection,
            &root,
            LocalSkillUpsertInput {
                name: "Bound Skill".into(),
                slug: None,
                markdown_body: "Bound description.".into(),
            },
        )
        .expect("local skill should create");

        connection
            .execute(
                r#"
                INSERT INTO skill_scope_bindings (
                    id,
                    skill_id,
                    scope_kind,
                    project_id,
                    role_id,
                    agent_id,
                    workflow_id,
                    workflow_lane_id,
                    created_at,
                    updated_at
                )
                VALUES (?1, ?2, 'global', NULL, NULL, NULL, NULL, NULL, ?3, ?3)
                "#,
                params!["binding-1", created.summary.id, now_iso()],
            )
            .expect("binding should insert");

        let error = delete_local_skill(&connection, &created.summary.id)
            .expect_err("bound local skill delete should fail");
        assert!(error.contains("scope binding"));
    }
}
