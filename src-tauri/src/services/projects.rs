use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{
    ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryRecord, RepositoryUpsertInput,
};
use crate::services::orchestra_paths::sanitize_slug;

pub fn list_projects(connection: &Connection) -> Result<Vec<ProjectSummary>, String> {
    ensure_default_project(connection)?;
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, description, default_repository_id, created_at, updated_at
            FROM projects
            ORDER BY updated_at DESC, name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare projects query: {error}"))?;

    let rows = statement
        .query_map([], |row| {
            Ok(ProjectSummary {
                id: row.get(0)?,
                slug: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                default_repository_id: row.get(4)?,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Unable to query projects: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read project rows: {error}"))
}

pub fn get_project(connection: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    ensure_default_project(connection)?;
    let project = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, default_repository_id, created_at, updated_at
            FROM projects
            WHERE id = ?1
            "#,
            [project_id],
            |row| {
                Ok(ProjectDetail {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    default_repository_id: row.get(4)?,
                    repositories: Vec::new(),
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query project {project_id}: {error}"))?
        .ok_or_else(|| format!("Project {project_id} was not found"))?;

    let repositories = list_repositories(connection, Some(project_id))?;
    Ok(ProjectDetail { repositories, ..project })
}

pub fn create_project(
    connection: &mut Connection,
    input: ProjectUpsertInput,
) -> Result<ProjectDetail, String> {
    let normalized = normalize_project_input(input);
    if normalized.name.is_empty() {
        return Err("Project name is required.".into());
    }

    let project_id = format!("project-{}", Uuid::new_v4().simple());
    let slug = unique_project_slug(connection, &normalized.name, None)?;
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, NULL, ?5, ?5)
            "#,
            params![project_id, slug, normalized.name, normalized.description, now],
        )
        .map_err(|error| format!("Unable to create project: {error}"))?;

    get_project(connection, &project_id)
}

pub fn update_project(
    connection: &Connection,
    project_id: &str,
    input: ProjectUpsertInput,
) -> Result<ProjectDetail, String> {
    let normalized = normalize_project_input(input);
    let existing = get_project(connection, project_id)?;
    let slug = if sanitize_slug(&normalized.name) == sanitize_slug(&existing.name) {
        existing.slug.clone()
    } else {
        unique_project_slug(connection, &normalized.name, Some(project_id))?
    };
    connection
        .execute(
            "UPDATE projects SET slug = ?2, name = ?3, description = ?4, updated_at = ?5 WHERE id = ?1",
            params![project_id, slug, normalized.name, normalized.description, now_iso()],
        )
        .map_err(|error| format!("Unable to update project {project_id}: {error}"))?;
    get_project(connection, project_id)
}

pub fn list_repositories(
    connection: &Connection,
    project_id: Option<&str>,
) -> Result<Vec<RepositoryRecord>, String> {
    ensure_default_project(connection)?;
    let sql = if project_id.is_some() {
        r#"
        SELECT id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at
        FROM repositories
        WHERE project_id = ?1
        ORDER BY updated_at DESC, name ASC
        "#
    } else {
        r#"
        SELECT id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at
        FROM repositories
        ORDER BY updated_at DESC, name ASC
        "#
    };

    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Unable to prepare repository query: {error}"))?;
    let rows = if let Some(project_id) = project_id {
        statement
            .query_map([project_id], read_repository)
            .map_err(|error| format!("Unable to query repositories for project {project_id}: {error}"))?
    } else {
        statement
            .query_map([], read_repository)
            .map_err(|error| format!("Unable to query repositories: {error}"))?
    };

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read repository rows: {error}"))
}

pub fn create_repository(
    connection: &Connection,
    project_id: &str,
    input: RepositoryUpsertInput,
) -> Result<RepositoryRecord, String> {
    let normalized = normalize_repository_input(input);
    if normalized.name.is_empty() {
        return Err("Repository name is required.".into());
    }
    if normalized.local_path.is_none() {
        return Err("Repository local path is required.".into());
    }

    let repository_id = format!("repo-{}", Uuid::new_v4().simple());
    let slug = unique_repository_slug(connection, project_id, &normalized.name, None)?;
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
            "#,
            params![repository_id, project_id, slug, normalized.name, normalized.local_path, normalized.remote_url, normalized.default_branch, now],
        )
        .map_err(|error| format!("Unable to create repository: {error}"))?;

    get_repository(connection, &repository_id)
}

pub fn update_repository(
    connection: &Connection,
    repository_id: &str,
    input: RepositoryUpsertInput,
) -> Result<RepositoryRecord, String> {
    let existing = get_repository(connection, repository_id)?;
    let normalized = normalize_repository_input(input);
    let slug = if sanitize_slug(&normalized.name) == sanitize_slug(&existing.name) {
        existing.slug.clone()
    } else {
        unique_repository_slug(connection, &existing.project_id, &normalized.name, Some(repository_id))?
    };
    connection
        .execute(
            "UPDATE repositories SET slug = ?2, name = ?3, local_path = ?4, remote_url = ?5, default_branch = ?6, updated_at = ?7 WHERE id = ?1",
            params![repository_id, slug, normalized.name, normalized.local_path, normalized.remote_url, normalized.default_branch, now_iso()],
        )
        .map_err(|error| format!("Unable to update repository {repository_id}: {error}"))?;
    get_repository(connection, repository_id)
}

pub fn set_project_default_repository(
    connection: &Connection,
    project_id: &str,
    repository_id: Option<&str>,
) -> Result<ProjectDetail, String> {
    connection
        .execute(
            "UPDATE projects SET default_repository_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![project_id, repository_id, now_iso()],
        )
        .map_err(|error| format!("Unable to update project default repository: {error}"))?;
    get_project(connection, project_id)
}

pub fn get_repository(connection: &Connection, repository_id: &str) -> Result<RepositoryRecord, String> {
    connection
        .query_row(
            r#"
            SELECT id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at
            FROM repositories
            WHERE id = ?1
            "#,
            [repository_id],
            read_repository,
        )
        .optional()
        .map_err(|error| format!("Unable to query repository {repository_id}: {error}"))?
        .ok_or_else(|| format!("Repository {repository_id} was not found"))
}

fn ensure_default_project(connection: &Connection) -> Result<(), String> {
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| format!("Unable to count projects: {error}"))?;
    if count > 0 {
        return Ok(());
    }

    let now = now_iso();
    let project_id = format!("project-{}", Uuid::new_v4().simple());
    let repository_id = format!("repo-{}", Uuid::new_v4().simple());
    let default_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(|path| path.join("orchestra").join("repository"))
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    connection
        .execute(
            "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES (?1, 'orchestra', 'Orchestra', 'Default Orchestra project', ?2, ?3, ?3)",
            params![project_id, repository_id, now],
        )
        .map_err(|error| format!("Unable to seed default project: {error}"))?;
    connection
        .execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES (?1, ?2, 'orchestra', 'Orchestra repository', ?3, NULL, 'main', ?4, ?4)",
            params![repository_id, project_id, default_path.display().to_string(), now],
        )
        .map_err(|error| format!("Unable to seed default repository: {error}"))?;
    Ok(())
}

fn normalize_project_input(mut input: ProjectUpsertInput) -> ProjectUpsertInput {
    input.name = input.name.trim().to_string();
    input.description = input.description.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });
    input
}

fn normalize_repository_input(mut input: RepositoryUpsertInput) -> RepositoryUpsertInput {
    input.name = input.name.trim().to_string();
    input.local_path = input.local_path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });
    input.remote_url = input.remote_url.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });
    input.default_branch = input.default_branch.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
    });
    input
}

fn unique_project_slug(connection: &Connection, name: &str, exclude_project_id: Option<&str>) -> Result<String, String> {
    let base = sanitize_slug(name);
    let mut candidate = base.clone();
    let mut index = 2;
    while slug_exists(connection, "projects", &candidate, exclude_project_id)? {
        candidate = format!("{}-{}", base, index);
        index += 1;
    }
    Ok(candidate)
}

fn unique_repository_slug(connection: &Connection, project_id: &str, name: &str, exclude_repository_id: Option<&str>) -> Result<String, String> {
    let base = sanitize_slug(name);
    let mut candidate = base.clone();
    let mut index = 2;
    while repository_slug_exists(connection, project_id, &candidate, exclude_repository_id)? {
        candidate = format!("{}-{}", base, index);
        index += 1;
    }
    Ok(candidate)
}

fn slug_exists(connection: &Connection, table: &str, slug: &str, exclude_id: Option<&str>) -> Result<bool, String> {
    let sql = format!("SELECT 1 FROM {table} WHERE slug = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1");
    connection
        .query_row(&sql, params![slug, exclude_id], |_| Ok(()))
        .optional()
        .map_err(|error| format!("Unable to query slug {slug} in {table}: {error}"))
        .map(|row| row.is_some())
}

fn repository_slug_exists(connection: &Connection, project_id: &str, slug: &str, exclude_id: Option<&str>) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM repositories WHERE project_id = ?1 AND slug = ?2 AND (?3 IS NULL OR id != ?3) LIMIT 1",
            params![project_id, slug, exclude_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Unable to query repository slug {slug}: {error}"))
        .map(|row| row.is_some())
}

fn read_repository(row: &rusqlite::Row<'_>) -> rusqlite::Result<RepositoryRecord> {
    Ok(RepositoryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        slug: row.get(2)?,
        name: row.get(3)?,
        local_path: row.get(4)?,
        remote_url: row.get(5)?,
        default_branch: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
