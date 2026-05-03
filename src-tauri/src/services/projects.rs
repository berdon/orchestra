use std::{fs, path::PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{
    ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryRecord, RepositoryRemoteInput,
    RepositoryUpsertInput,
};
use crate::services::{
    orchestra_paths::{
        default_orchestra_root, discover_dev_checkout_root, infer_project_slug,
        managed_repository_checkout_dir, managed_repository_root, project_root, sanitize_slug,
    },
    project_secrets, project_settings,
};

pub fn list_projects(connection: &Connection) -> Result<Vec<ProjectSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at
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
                task_prefix: row.get(4)?,
                default_repository_id: row.get(5)?,
                created_at: row.get(6)?,
                updated_at: row.get(7)?,
            })
        })
        .map_err(|error| format!("Unable to query projects: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read project rows: {error}"))
}

pub fn get_project(connection: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    let project = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at
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
                    task_prefix: row.get(4)?,
                    default_repository_id: row.get(5)?,
                    repositories: Vec::new(),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query project {project_id}: {error}"))?
        .ok_or_else(|| format!("Project {project_id} was not found"))?;

    let repositories = list_repositories(connection, Some(project_id))?;
    Ok(ProjectDetail {
        repositories,
        ..project
    })
}

pub fn ensure_project_exists(connection: &Connection, project_id: &str) -> Result<(), String> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 LIMIT 1",
            [project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query project {project_id}: {error}"))?
        .is_some();
    if exists {
        Ok(())
    } else {
        Err(format!("Project {project_id} was not found"))
    }
}

pub fn get_project_task_prefix(
    connection: &Connection,
    project_id: &str,
) -> Result<String, String> {
    ensure_default_project(connection)?;
    let task_prefix = connection
        .query_row(
            "SELECT task_prefix FROM projects WHERE id = ?1",
            [project_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query project {project_id}: {error}"))?
        .flatten()
        .ok_or_else(|| format!("Project {project_id} was not found"))?;

    normalize_task_prefix(&task_prefix)
}

pub fn ensure_repository_belongs_to_project(
    connection: &Connection,
    project_id: &str,
    repository_id: &str,
) -> Result<RepositoryRecord, String> {
    let repository = get_repository(connection, repository_id)?;
    if repository.project_id != project_id {
        return Err(format!(
            "Repository {repository_id} does not belong to project {project_id}"
        ));
    }
    Ok(repository)
}

pub fn get_project_by_slug(
    connection: &Connection,
    project_slug: &str,
) -> Result<Option<ProjectDetail>, String> {
    let project = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at
            FROM projects
            WHERE slug = ?1
            "#,
            [project_slug],
            |row| {
                Ok(ProjectDetail {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    task_prefix: row.get(4)?,
                    default_repository_id: row.get(5)?,
                    repositories: Vec::new(),
                    created_at: row.get(6)?,
                    updated_at: row.get(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query project slug {project_slug}: {error}"))?;

    let Some(project) = project else {
        return Ok(None);
    };

    let repositories = list_repositories(connection, Some(&project.id))?;
    Ok(Some(ProjectDetail {
        repositories,
        ..project
    }))
}

pub fn resolve_default_project_id(connection: &Connection) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT id
            FROM projects
            ORDER BY updated_at DESC, name ASC, id ASC
            LIMIT 1
            "#,
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve default project: {error}"))
}

pub fn resolve_requested_or_default_project_id(
    connection: &Connection,
    requested_project_id: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(project_id) = requested_project_id.filter(|value| !value.trim().is_empty()) {
        ensure_project_exists(connection, project_id)?;
        return Ok(Some(project_id.to_string()));
    }

    resolve_default_project_id(connection)
}

pub fn require_requested_or_default_project_id(
    connection: &Connection,
    requested_project_id: Option<&str>,
    missing_message: &str,
) -> Result<String, String> {
    resolve_requested_or_default_project_id(connection, requested_project_id)?
        .ok_or_else(|| missing_message.to_string())
}

pub fn resolve_default_project_slug(connection: &Connection) -> Result<Option<String>, String> {
    let Some(project_id) = resolve_default_project_id(connection)? else {
        return Ok(None);
    };
    Ok(Some(get_project(connection, &project_id)?.slug))
}

pub fn resolve_requested_or_default_project_slug(
    connection: &Connection,
    requested_project_slug: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(project_slug) = requested_project_slug.filter(|value| !value.trim().is_empty()) {
        let project = get_project_by_slug(connection, project_slug)?
            .ok_or_else(|| format!("Project slug {project_slug} was not found"))?;
        return Ok(Some(project.slug));
    }

    resolve_default_project_slug(connection)
}

pub fn require_requested_or_default_project_slug(
    connection: &Connection,
    requested_project_slug: Option<&str>,
    missing_message: &str,
) -> Result<String, String> {
    resolve_requested_or_default_project_slug(connection, requested_project_slug)?
        .ok_or_else(|| missing_message.to_string())
}

fn existing_repository_runtime_root(repository: &RepositoryRecord) -> Option<PathBuf> {
    repository
        .repository_path
        .as_deref()
        .map(PathBuf::from)
        .filter(|path| path.is_dir())
}

pub fn resolve_project_runtime_root(
    connection: &Connection,
    project_slug: &str,
) -> Result<PathBuf, String> {
    let normalized_slug = sanitize_slug(project_slug);
    let Some(project) = get_project_by_slug(connection, project_slug)? else {
        return discover_dev_checkout_root()
            .filter(|path| infer_project_slug(path) == normalized_slug)
            .map(Ok)
            .unwrap_or_else(|| ensure_project_root_exists(project_slug));
    };

    if let Some(default_repository_id) = project.default_repository_id.as_deref() {
        if let Some(path) = project
            .repositories
            .iter()
            .find(|repository| repository.id == default_repository_id)
            .and_then(existing_repository_runtime_root)
        {
            return Ok(path);
        }
    }

    if let Some(path) = project
        .repositories
        .iter()
        .find_map(existing_repository_runtime_root)
    {
        return Ok(path);
    }

    if let Some(path) =
        discover_dev_checkout_root().filter(|path| infer_project_slug(path) == project.slug)
    {
        return Ok(path);
    }

    ensure_project_root_exists(&project.slug)
}

pub fn create_project(
    connection: &Connection,
    input: ProjectUpsertInput,
) -> Result<ProjectDetail, String> {
    let normalized = normalize_project_input(input)?;
    if normalized.name.is_empty() {
        return Err("Project name is required.".into());
    }
    if task_prefix_exists(connection, &normalized.task_prefix, None)? {
        return Err(format!(
            "Task prefix {} is already used by another project.",
            normalized.task_prefix
        ));
    }

    let project_id = format!("project-{}", Uuid::new_v4().simple());
    let slug = unique_project_slug(connection, &normalized.name, None)?;
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, NULL, ?6, ?6)
            "#,
            params![project_id, slug, normalized.name, normalized.description, normalized.task_prefix, now],
        )
        .map_err(|error| format!("Unable to create project: {error}"))?;

    ensure_project_root_exists(&slug)?;
    let _ = project_settings::update_task_automation_settings_with_connection(
        connection, None, &slug, true,
    )?;

    get_project(connection, &project_id)
}

pub fn update_project(
    connection: &Connection,
    project_id: &str,
    input: ProjectUpsertInput,
) -> Result<ProjectDetail, String> {
    let normalized = normalize_project_input(input)?;
    let existing = get_project(connection, project_id)?;
    let slug = if sanitize_slug(&normalized.name) == sanitize_slug(&existing.name) {
        existing.slug.clone()
    } else {
        unique_project_slug(connection, &normalized.name, Some(project_id))?
    };
    if task_prefix_exists(connection, &normalized.task_prefix, Some(project_id))? {
        return Err(format!(
            "Task prefix {} is already used by another project.",
            normalized.task_prefix
        ));
    }
    connection
        .execute(
            "UPDATE projects SET slug = ?2, name = ?3, description = ?4, task_prefix = ?5, updated_at = ?6 WHERE id = ?1",
            params![project_id, slug, normalized.name, normalized.description, normalized.task_prefix, now_iso()],
        )
        .map_err(|error| format!("Unable to update project {project_id}: {error}"))?;
    get_project(connection, project_id)
}

pub fn list_repositories(
    connection: &Connection,
    project_id: Option<&str>,
) -> Result<Vec<RepositoryRecord>, String> {
    if let Some(project_id) = project_id {
        ensure_project_exists(connection, project_id)?;
    }
    let sql = if project_id.is_some() {
        r#"
        SELECT id, project_id, slug, name, local_path, remote_url, mode, default_branch, created_at, updated_at
        FROM repositories
        WHERE project_id = ?1
        ORDER BY updated_at DESC, name ASC
        "#
    } else {
        r#"
        SELECT id, project_id, slug, name, local_path, remote_url, mode, default_branch, created_at, updated_at
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
            .map_err(|error| {
                format!("Unable to query repositories for project {project_id}: {error}")
            })?
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

    let mode = normalized.mode.as_deref().unwrap_or("existing");
    if mode == "existing" && normalized.repository_path.is_none() {
        return Err("Repository path is required when adding an existing repository.".into());
    }

    let project = get_project(connection, project_id)?;
    let repository_id = format!("repo-{}", Uuid::new_v4().simple());
    let slug = unique_repository_slug(connection, project_id, &normalized.name, None)?;
    let managed_checkout_dir = ensure_managed_repository_checkout(
        &project,
        &slug,
        normalized.repository_path.as_deref(),
        normalized.default_branch.as_deref().unwrap_or("main"),
    )?;
    let source_path = if mode == "existing" {
        normalized.repository_path.clone()
    } else {
        None
    };
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, mode, default_branch, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            "#,
            params![repository_id, project_id, slug, normalized.name, managed_checkout_dir.display().to_string(), source_path, mode, normalized.default_branch, now],
        )
        .map_err(|error| format!("Unable to create repository: {error}"))?;

    if project.default_repository_id.is_none() {
        connection
            .execute(
                "UPDATE projects SET default_repository_id = ?2, updated_at = ?3 WHERE id = ?1",
                params![project_id, repository_id, now],
            )
            .map_err(|error| {
                format!("Unable to set default repository for project {project_id}: {error}")
            })?;
    }

    get_repository(connection, &repository_id)
}

pub fn update_repository(
    connection: &Connection,
    repository_id: &str,
    input: RepositoryUpsertInput,
) -> Result<RepositoryRecord, String> {
    let existing = get_repository(connection, repository_id)?;
    let project = get_project(connection, &existing.project_id)?;
    let normalized = normalize_repository_input(input);
    let slug = if sanitize_slug(&normalized.name) == sanitize_slug(&existing.name) {
        existing.slug.clone()
    } else {
        unique_repository_slug(
            connection,
            &existing.project_id,
            &normalized.name,
            Some(repository_id),
        )?
    };
    let mode = normalized
        .mode
        .as_deref()
        .unwrap_or(existing.mode.as_deref().unwrap_or("existing"));
    let source_path = if mode == "existing" {
        normalized
            .repository_path
            .clone()
            .or(existing.source_path.clone())
    } else {
        existing.source_path.clone()
    };
    if mode == "existing" && source_path.is_none() {
        return Err("Repository path is required when updating an existing repository.".into());
    }
    let managed_checkout_dir = ensure_managed_repository_checkout(
        &project,
        &slug,
        if mode == "existing" {
            source_path.as_deref()
        } else {
            None
        },
        normalized
            .default_branch
            .as_deref()
            .or(existing.default_branch.as_deref())
            .unwrap_or("main"),
    )?;
    connection
        .execute(
            "UPDATE repositories SET slug = ?2, name = ?3, local_path = ?4, remote_url = ?5, mode = ?6, default_branch = ?7, updated_at = ?8 WHERE id = ?1",
            params![repository_id, slug, normalized.name, managed_checkout_dir.display().to_string(), source_path, mode, normalized.default_branch.or(existing.default_branch), now_iso()],
        )
        .map_err(|error| format!("Unable to update repository {repository_id}: {error}"))?;
    get_repository(connection, repository_id)
}

pub fn attach_repository_remote(
    connection: &Connection,
    repository_id: &str,
    input: RepositoryRemoteInput,
) -> Result<RepositoryRecord, String> {
    let repository = get_repository(connection, repository_id)?;
    let repository_path = repository.repository_path.as_deref().ok_or_else(|| {
        format!("Repository {repository_id} does not have a managed repository path")
    })?;
    let remote_url = input.remote_url.trim();
    if remote_url.is_empty() {
        return Err("Remote URL is required.".into());
    }
    let remote_name = input
        .remote_name
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("origin");

    let repo_dir = PathBuf::from(repository_path);
    let has_remote = std::process::Command::new("git")
        .args(["remote", "get-url", remote_name])
        .current_dir(&repo_dir)
        .status()
        .map(|status| status.success())
        .unwrap_or(false);

    let status = if has_remote {
        std::process::Command::new("git")
            .args(["remote", "set-url", remote_name, remote_url])
            .current_dir(&repo_dir)
            .status()
            .map_err(|error| format!("Unable to update repository remote: {error}"))?
    } else {
        std::process::Command::new("git")
            .args(["remote", "add", remote_name, remote_url])
            .current_dir(&repo_dir)
            .status()
            .map_err(|error| format!("Unable to add repository remote: {error}"))?
    };

    if !status.success() {
        return Err(format!(
            "Unable to configure remote {remote_name} for repository {}",
            repository.name
        ));
    }

    connection
        .execute(
            "UPDATE repositories SET remote_url = ?2, updated_at = ?3 WHERE id = ?1",
            params![repository_id, remote_url, now_iso()],
        )
        .map_err(|error| {
            format!("Unable to persist repository remote for {repository_id}: {error}")
        })?;

    get_repository(connection, repository_id)
}

pub fn set_project_default_repository(
    connection: &Connection,
    project_id: &str,
    repository_id: Option<&str>,
) -> Result<ProjectDetail, String> {
    ensure_project_exists(connection, project_id)?;
    if let Some(repository_id) = repository_id {
        ensure_repository_belongs_to_project(connection, project_id, repository_id)?;
    }
    connection
        .execute(
            "UPDATE projects SET default_repository_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![project_id, repository_id, now_iso()],
        )
        .map_err(|error| format!("Unable to update project default repository: {error}"))?;
    get_project(connection, project_id)
}

pub fn delete_repository(
    connection: &Connection,
    repository_id: &str,
) -> Result<RepositoryRecord, String> {
    let repository = get_repository(connection, repository_id)?;
    let project = get_project(connection, &repository.project_id)?;

    let fallback_default_repository_id =
        if project.default_repository_id.as_deref() == Some(repository_id) {
            project
                .repositories
                .iter()
                .find(|entry| entry.id != repository_id)
                .map(|entry| entry.id.clone())
        } else {
            project.default_repository_id.clone()
        };

    connection
        .execute(
            "UPDATE tasks SET repository_id = NULL, updated_at = ?2 WHERE repository_id = ?1",
            params![repository_id, now_iso()],
        )
        .map_err(|error| {
            format!("Unable to clear task repository references for {repository_id}: {error}")
        })?;

    connection
        .execute(
            "UPDATE projects SET default_repository_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![project.id, fallback_default_repository_id, now_iso()],
        )
        .map_err(|error| {
            format!("Unable to update project default repository before deletion: {error}")
        })?;

    connection
        .execute("DELETE FROM repositories WHERE id = ?1", [repository_id])
        .map_err(|error| format!("Unable to delete repository {repository_id}: {error}"))?;

    let orchestra_root = default_orchestra_root()?;
    let managed_root = managed_repository_root(&orchestra_root, &project.slug, &repository.slug);
    if managed_root.exists() {
        fs::remove_dir_all(&managed_root).map_err(|error| {
            format!(
                "Unable to remove managed repository directory {}: {error}",
                managed_root.display()
            )
        })?;
    }

    Ok(repository)
}

pub fn delete_project(connection: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    let project = get_project(connection, project_id)?;

    let orchestra_root = default_orchestra_root()?;
    for warning in project_secrets::cleanup_project_secrets_for_project_id(
        connection,
        Some(&orchestra_root),
        project_id,
    ) {
        eprintln!("[project.secret.cleanup.warning] project={} warning={warning}", project.slug);
    }

    connection
        .execute("DELETE FROM projects WHERE id = ?1", [project_id])
        .map_err(|error| format!("Unable to delete project {project_id}: {error}"))?;

    let root = project_root(&orchestra_root, &project.slug);
    if root.exists() {
        fs::remove_dir_all(&root).map_err(|error| {
            format!(
                "Unable to remove project directory {}: {error}",
                root.display()
            )
        })?;
    }

    Ok(project)
}

pub fn get_repository(
    connection: &Connection,
    repository_id: &str,
) -> Result<RepositoryRecord, String> {
    connection
        .query_row(
            r#"
            SELECT id, project_id, slug, name, local_path, remote_url, mode, default_branch, created_at, updated_at
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

const DEFAULT_REPOSITORY_ID: &str = "repo-orchestra";
const MANAGED_CHECKOUT_WORKSPACE_BRANCH: &str = "project";

fn ensure_default_project(connection: &Connection) -> Result<(), String> {
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| format!("Unable to count projects: {error}"))?;

    let default_repository_path = discover_dev_checkout_root();
    if count == 0 {
        let now = now_iso();
        let default_repository_id = default_repository_path
            .as_ref()
            .map(|_| DEFAULT_REPOSITORY_ID);
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, 'orchestra', 'Orchestra', 'Default Orchestra project', 'ORC', ?2, ?3, ?3)",
                params!["orchestra", default_repository_id, now],
            )
            .map_err(|error| format!("Unable to seed default project: {error}"))?;
    } else if !connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = 'orchestra' LIMIT 1",
            [],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query default project: {error}"))?
        .is_some()
    {
        return Ok(());
    }

    let Some(default_path) = default_repository_path else {
        return Ok(());
    };

    let project = get_project(connection, "orchestra")?;
    let source_path = default_path.display().to_string();
    let managed_checkout_dir =
        ensure_managed_repository_checkout(&project, "orchestra", Some(&source_path), "main")?;
    let now = now_iso();
    let existing_repository_id = connection
        .query_row(
            "SELECT id FROM repositories WHERE id = ?1 LIMIT 1",
            [DEFAULT_REPOSITORY_ID],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query default repository: {error}"))?;

    if existing_repository_id.is_some() {
        connection
            .execute(
                "UPDATE repositories SET slug = 'orchestra', name = 'Orchestra repository', local_path = ?2, remote_url = ?3, mode = 'existing', default_branch = 'main', updated_at = ?4 WHERE id = ?1",
                params![DEFAULT_REPOSITORY_ID, managed_checkout_dir.display().to_string(), source_path, now],
            )
            .map_err(|error| format!("Unable to migrate default repository: {error}"))?;
    } else {
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, mode, default_branch, created_at, updated_at) VALUES (?1, ?2, 'orchestra', 'Orchestra repository', ?3, ?4, 'existing', 'main', ?5, ?5)",
                params![DEFAULT_REPOSITORY_ID, "orchestra", managed_checkout_dir.display().to_string(), source_path, now],
            )
            .map_err(|error| format!("Unable to seed default repository: {error}"))?;
    }

    connection
        .execute(
            "UPDATE projects SET default_repository_id = ?2, updated_at = ?3 WHERE id = ?1",
            params!["orchestra", DEFAULT_REPOSITORY_ID, now],
        )
        .map_err(|error| format!("Unable to update default project repository pointer: {error}"))?;

    Ok(())
}

fn normalize_project_input(mut input: ProjectUpsertInput) -> Result<ProjectUpsertInput, String> {
    input.name = input.name.trim().to_string();
    input.description = input.description.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    input.task_prefix = normalize_task_prefix(&input.task_prefix)?;
    Ok(input)
}

fn normalize_task_prefix(value: &str) -> Result<String, String> {
    let normalized = value.trim().to_uppercase();
    if normalized.is_empty() {
        return Err("Task prefix is required.".into());
    }
    if normalized.len() < 2 || normalized.len() > 8 {
        return Err("Task prefix must start with a letter and contain only A-Z or 0-9.".into());
    }
    let mut characters = normalized.chars();
    let Some(first) = characters.next() else {
        return Err("Task prefix is required.".into());
    };
    if !first.is_ascii_alphabetic()
        || !characters.all(|character| character.is_ascii_alphanumeric())
    {
        return Err("Task prefix must start with a letter and contain only A-Z or 0-9.".into());
    }
    Ok(normalized)
}

fn task_prefix_exists(
    connection: &Connection,
    task_prefix: &str,
    exclude_project_id: Option<&str>,
) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT 1 FROM projects WHERE UPPER(task_prefix) = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1",
            params![task_prefix, exclude_project_id],
            |row| row.get::<_, i64>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query task prefix {task_prefix}: {error}"))
        .map(|value| value.is_some())
}

fn normalize_repository_input(mut input: RepositoryUpsertInput) -> RepositoryUpsertInput {
    input.name = input.name.trim().to_string();
    input.mode = input.mode.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    input.repository_path = input.repository_path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else if is_remote_repository_path(trimmed) {
            Some(trimmed.to_string())
        } else {
            Some(
                normalize_repository_local_path(trimmed)
                    .display()
                    .to_string(),
            )
        }
    });
    input.default_branch = input.default_branch.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    });
    input
}

fn normalize_repository_local_path(path: &str) -> PathBuf {
    PathBuf::from(path)
}

pub fn is_remote_repository_path(path: &str) -> bool {
    path.starts_with("http://")
        || path.starts_with("https://")
        || path.starts_with("ssh://")
        || path.starts_with("git://")
        || (path.contains('@') && path.contains(':') && !path.starts_with('/'))
        || is_scp_style_without_user(path)
}

fn is_scp_style_without_user(path: &str) -> bool {
    // Match scp-style URLs like gitea:guppy/orchestra.git where there's no user@
    // Format: host:path/to/repo.git
    // Must contain ':' but not at position 1 (which would be a Windows drive letter)
    // and not start with '/' (absolute path)
    if path.starts_with('/') || path.contains('\\') {
        return false;
    }
    let colon_pos = match path.find(':') {
        Some(pos) => pos,
        None => return false,
    };
    // Windows drive letter like "C:" - not a remote
    if colon_pos == 1
        && path
            .as_bytes()
            .get(0)
            .map(|&b| b.is_ascii_alphabetic())
            .unwrap_or(false)
    {
        return false;
    }
    // After colon should look like a path (contains '/' or '.git' or similar)
    let after_colon = &path[colon_pos + 1..];
    after_colon.contains('/') || after_colon.contains('\\') || after_colon.ends_with(".git")
}

fn ensure_project_root_exists(project_slug: &str) -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let root = project_root(&orchestra_root, project_slug);
    fs::create_dir_all(&root).map_err(|error| {
        format!(
            "Unable to create project directory {}: {error}",
            root.display()
        )
    })?;
    Ok(root)
}

pub(crate) fn normalize_managed_checkout_branch(
    managed_checkout_dir: &std::path::Path,
    default_branch: &str,
    force_normalize: bool,
) -> Result<(), String> {
    let default_branch = default_branch.trim();
    if default_branch.is_empty() || default_branch == MANAGED_CHECKOUT_WORKSPACE_BRANCH {
        return Ok(());
    }

    let current_branch = git_current_branch(managed_checkout_dir)?;
    if !git_worktree_is_clean(managed_checkout_dir)? {
        if current_branch.as_deref() == Some(default_branch) {
            return Err(managed_checkout_normalization_blocked_error(
                managed_checkout_dir,
                default_branch,
            ));
        }
        return Ok(());
    }

    if !force_normalize {
        let Some(current_branch) = current_branch.as_deref() else {
            return Ok(());
        };
        if current_branch == MANAGED_CHECKOUT_WORKSPACE_BRANCH || current_branch != default_branch {
            return Ok(());
        }
    }

    let base_ref = match resolve_managed_checkout_base_ref(managed_checkout_dir, default_branch) {
        Ok(reference) => reference,
        Err(_) if !force_normalize => return Ok(()),
        Err(error) => return Err(error),
    };

    let workspace_branch_ref = format!("refs/heads/{MANAGED_CHECKOUT_WORKSPACE_BRANCH}");
    let mut command = std::process::Command::new("git");
    command.arg("-C").arg(managed_checkout_dir).arg("checkout");
    if force_normalize || !git_has_ref(managed_checkout_dir, &workspace_branch_ref)? {
        command
            .arg("-B")
            .arg(MANAGED_CHECKOUT_WORKSPACE_BRANCH)
            .arg(&base_ref);
    } else {
        command.arg(MANAGED_CHECKOUT_WORKSPACE_BRANCH);
    }
    let status = command.status().map_err(|error| {
        format!(
            "Unable to switch managed repository {} onto {}: {error}",
            managed_checkout_dir.display(),
            MANAGED_CHECKOUT_WORKSPACE_BRANCH
        )
    })?;
    if !status.success() {
        return Err(format!(
            "Unable to switch managed repository {} onto {}",
            managed_checkout_dir.display(),
            MANAGED_CHECKOUT_WORKSPACE_BRANCH
        ));
    }

    if git_has_ref(
        managed_checkout_dir,
        &format!("refs/remotes/origin/{default_branch}"),
    )? {
        let _ = std::process::Command::new("git")
            .arg("-C")
            .arg(managed_checkout_dir)
            .args([
                "branch",
                "--set-upstream-to",
                &format!("origin/{default_branch}"),
                MANAGED_CHECKOUT_WORKSPACE_BRANCH,
            ])
            .status();
    }

    Ok(())
}

fn managed_checkout_normalization_blocked_error(
    managed_checkout_dir: &std::path::Path,
    default_branch: &str,
) -> String {
    format!(
        "Managed repository {} is still checked out on default branch {} with uncommitted changes. Orchestra cannot move it onto {} safely until you commit, stash, or discard those changes (or manually switch the checkout off {}). Until you repair that checkout, it still blocks worktrees that need {}.",
        managed_checkout_dir.display(),
        default_branch,
        MANAGED_CHECKOUT_WORKSPACE_BRANCH,
        default_branch,
        default_branch
    )
}

fn git_current_branch(repository_path: &std::path::Path) -> Result<Option<String>, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(["symbolic-ref", "--quiet", "--short", "HEAD"])
        .output()
        .map_err(|error| {
            format!(
                "Unable to inspect current branch for {}: {error}",
                repository_path.display()
            )
        })?;
    if !output.status.success() {
        return Ok(None);
    }

    Ok(Some(
        String::from_utf8_lossy(&output.stdout).trim().to_string(),
    ))
}

fn git_worktree_is_clean(repository_path: &std::path::Path) -> Result<bool, String> {
    let output = std::process::Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(["status", "--porcelain"])
        .output()
        .map_err(|error| {
            format!(
                "Unable to inspect managed repository status for {}: {error}",
                repository_path.display()
            )
        })?;
    if !output.status.success() {
        return Err(format!(
            "Unable to inspect managed repository status for {}",
            repository_path.display()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().is_empty())
}

fn git_has_ref(repository_path: &std::path::Path, reference: &str) -> Result<bool, String> {
    let status = std::process::Command::new("git")
        .arg("-C")
        .arg(repository_path)
        .args(["show-ref", "--verify", "--quiet", reference])
        .status()
        .map_err(|error| {
            format!(
                "Unable to inspect git ref {reference} in {}: {error}",
                repository_path.display()
            )
        })?;
    Ok(status.success())
}

fn resolve_managed_checkout_base_ref(
    repository_path: &std::path::Path,
    default_branch: &str,
) -> Result<String, String> {
    let local_ref = format!("refs/heads/{default_branch}");
    if git_has_ref(repository_path, &local_ref)? {
        return Ok(local_ref);
    }

    let remote_ref = format!("refs/remotes/origin/{default_branch}");
    if git_has_ref(repository_path, &remote_ref)? {
        return Ok(remote_ref);
    }

    Err(format!(
        "Managed repository {} does not have default branch {}",
        repository_path.display(),
        default_branch
    ))
}

fn ensure_managed_repository_checkout(
    project: &ProjectDetail,
    repository_slug: &str,
    source_path: Option<&str>,
    default_branch: &str,
) -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let managed_checkout_dir =
        managed_repository_checkout_dir(&orchestra_root, &project.slug, repository_slug);
    if let Some(parent) = managed_checkout_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create managed repository parent {}: {error}",
                parent.display()
            )
        })?;
    }

    if managed_checkout_dir.join(".git").exists() {
        normalize_managed_checkout_branch(&managed_checkout_dir, default_branch, false)?;
        return Ok(managed_checkout_dir);
    }

    if let Some(source_path) = source_path {
        if is_remote_repository_path(source_path) {
            let status = std::process::Command::new("git")
                .arg("clone")
                .arg(source_path)
                .arg(&managed_checkout_dir)
                .status()
                .map_err(|error| {
                    format!("Unable to clone repository from {source_path}: {error}")
                })?;
            if !status.success() {
                return Err(format!(
                    "Unable to clone repository from {source_path} into {}",
                    managed_checkout_dir.display()
                ));
            }
            normalize_managed_checkout_branch(&managed_checkout_dir, default_branch, true)?;
            return Ok(managed_checkout_dir);
        }

        let source = PathBuf::from(source_path);
        if source.join(".git").exists() {
            let status = std::process::Command::new("git")
                .arg("clone")
                .arg(source.as_os_str())
                .arg(&managed_checkout_dir)
                .status()
                .map_err(|error| {
                    format!(
                        "Unable to clone repository from {}: {error}",
                        source.display()
                    )
                })?;
            if !status.success() {
                return Err(format!(
                    "Unable to clone repository from {} into {}",
                    source.display(),
                    managed_checkout_dir.display()
                ));
            }
            normalize_managed_checkout_branch(&managed_checkout_dir, default_branch, true)?;
            return Ok(managed_checkout_dir);
        }
    }

    std::fs::create_dir_all(&managed_checkout_dir).map_err(|error| {
        format!(
            "Unable to create managed repository directory {}: {error}",
            managed_checkout_dir.display()
        )
    })?;
    let init_status = std::process::Command::new("git")
        .arg("init")
        .arg("-b")
        .arg(default_branch)
        .current_dir(&managed_checkout_dir)
        .status()
        .map_err(|error| {
            format!(
                "Unable to initialize managed repository {}: {error}",
                managed_checkout_dir.display()
            )
        })?;
    if !init_status.success() {
        return Err(format!(
            "Unable to initialize managed repository {}",
            managed_checkout_dir.display()
        ));
    }

    let _ = std::process::Command::new("git")
        .args(["config", "user.email", "orchestra@example.invalid"])
        .current_dir(&managed_checkout_dir)
        .status();
    let _ = std::process::Command::new("git")
        .args(["config", "user.name", "Orchestra"])
        .current_dir(&managed_checkout_dir)
        .status();
    std::fs::write(
        managed_checkout_dir.join("README.md"),
        format!("# {}\n", project.name),
    )
    .map_err(|error| {
        format!(
            "Unable to seed managed repository README in {}: {error}",
            managed_checkout_dir.display()
        )
    })?;
    let _ = std::process::Command::new("git")
        .args(["add", "README.md"])
        .current_dir(&managed_checkout_dir)
        .status();
    let _ = std::process::Command::new("git")
        .args(["commit", "-m", "Initialize managed repository"])
        .current_dir(&managed_checkout_dir)
        .status();
    normalize_managed_checkout_branch(&managed_checkout_dir, default_branch, true)?;

    Ok(managed_checkout_dir)
}

fn unique_project_slug(
    connection: &Connection,
    name: &str,
    exclude_project_id: Option<&str>,
) -> Result<String, String> {
    let base = sanitize_slug(name);
    let mut candidate = base.clone();
    let mut index = 2;
    while slug_exists(connection, "projects", &candidate, exclude_project_id)? {
        candidate = format!("{}-{}", base, index);
        index += 1;
    }
    Ok(candidate)
}

fn unique_repository_slug(
    connection: &Connection,
    project_id: &str,
    name: &str,
    exclude_repository_id: Option<&str>,
) -> Result<String, String> {
    let base = sanitize_slug(name);
    let mut candidate = base.clone();
    let mut index = 2;
    while repository_slug_exists(connection, project_id, &candidate, exclude_repository_id)? {
        candidate = format!("{}-{}", base, index);
        index += 1;
    }
    Ok(candidate)
}

fn slug_exists(
    connection: &Connection,
    table: &str,
    slug: &str,
    exclude_id: Option<&str>,
) -> Result<bool, String> {
    let sql = format!("SELECT 1 FROM {table} WHERE slug = ?1 AND (?2 IS NULL OR id != ?2) LIMIT 1");
    connection
        .query_row(&sql, params![slug, exclude_id], |_| Ok(()))
        .optional()
        .map_err(|error| format!("Unable to query slug {slug} in {table}: {error}"))
        .map(|row| row.is_some())
}

fn repository_slug_exists(
    connection: &Connection,
    project_id: &str,
    slug: &str,
    exclude_id: Option<&str>,
) -> Result<bool, String> {
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
    let repository_path = row.get::<_, Option<String>>(4)?;
    let source_path = row.get::<_, Option<String>>(5)?;
    let mode = row.get::<_, Option<String>>(6)?;
    let source_kind = source_path
        .as_deref()
        .map(|value| {
            if is_remote_repository_path(value) {
                "remote"
            } else {
                "local"
            }
        })
        .map(str::to_string);

    Ok(RepositoryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        slug: row.get(2)?,
        name: row.get(3)?,
        repository_path,
        source_path,
        source_kind,
        mode,
        default_branch: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        crate::services::database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn unique_temp_path(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        std::env::temp_dir().join(suffix)
    }

    fn init_test_repo(label: &str) -> PathBuf {
        let repository_root = unique_temp_path(label);
        fs::create_dir_all(&repository_root).expect("repository root should exist");
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_root)
            .args(["init", "-b", "main"])
            .status()
            .expect("git init should run")
            .success());
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_root)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .expect("git config email should run")
            .success());
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_root)
            .args(["config", "user.name", "Test User"])
            .status()
            .expect("git config name should run")
            .success());
        fs::write(repository_root.join("README.md"), "# test\n").expect("README should write");
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_root)
            .args(["add", "README.md"])
            .status()
            .expect("git add should run")
            .success());
        assert!(std::process::Command::new("git")
            .arg("-C")
            .arg(&repository_root)
            .args(["commit", "-m", "init"])
            .status()
            .expect("git commit should run")
            .success());
        repository_root
    }

    fn current_branch(repository_root: &PathBuf) -> String {
        let output = std::process::Command::new("git")
            .arg("-C")
            .arg(repository_root)
            .args(["symbolic-ref", "--short", "HEAD"])
            .output()
            .expect("git symbolic-ref should run");
        assert!(output.status.success());
        String::from_utf8_lossy(&output.stdout).trim().to_string()
    }

    #[test]
    fn test_is_remote_repository_path_detects_https() {
        assert!(is_remote_repository_path(
            "https://github.com/user/repo.git"
        ));
        assert!(is_remote_repository_path("https://gitlab.com/user/repo"));
    }

    #[test]
    fn test_is_remote_repository_path_detects_http() {
        assert!(is_remote_repository_path("http://github.com/user/repo.git"));
    }

    #[test]
    fn test_is_remote_repository_path_detects_ssh_protocol() {
        assert!(is_remote_repository_path(
            "ssh://git@github.com/user/repo.git"
        ));
    }

    #[test]
    fn test_is_remote_repository_path_detects_git_protocol() {
        assert!(is_remote_repository_path("git://github.com/user/repo.git"));
    }

    #[test]
    fn test_is_remote_repository_path_detects_scp_style_with_user() {
        assert!(is_remote_repository_path("git@github.com:user/repo.git"));
        assert!(is_remote_repository_path("git@gitea:guppy/orchestra.git"));
        assert!(is_remote_repository_path("user@host:path/to/repo.git"));
    }

    #[test]
    fn test_is_remote_repository_path_detects_scp_style_without_user() {
        assert!(is_remote_repository_path("gitea:guppy/orchestra.git"));
        assert!(is_remote_repository_path("github.com:user/repo.git"));
        assert!(is_remote_repository_path("host:path/to/repo"));
        assert!(is_remote_repository_path("my-server:/path/to/repo.git"));
    }

    #[test]
    fn test_is_remote_repository_path_rejects_absolute_paths() {
        assert!(!is_remote_repository_path("/path/to/repo"));
        assert!(!is_remote_repository_path("/home/user/repo"));
    }

    #[test]
    fn test_is_remote_repository_path_rejects_windows_drive_letters() {
        assert!(!is_remote_repository_path("C:\\path\\to\\repo"));
        assert!(!is_remote_repository_path("D:/path/to/repo"));
        assert!(!is_remote_repository_path("C:path/to/repo"));
    }

    #[test]
    fn test_is_remote_repository_path_rejects_relative_paths() {
        assert!(!is_remote_repository_path("relative/path/to/repo"));
        assert!(!is_remote_repository_path("./repo"));
        assert!(!is_remote_repository_path("../repo"));
    }

    #[test]
    fn test_is_remote_repository_path_rejects_backslash_paths() {
        assert!(!is_remote_repository_path("local\\path\\to\\repo"));
    }

    #[test]
    fn test_is_remote_repository_path_rejects_plain_strings_without_colon_or_path_separator() {
        assert!(!is_remote_repository_path("just-a-string"));
        assert!(!is_remote_repository_path("repo"));
    }

    #[test]
    fn normalize_managed_checkout_branch_moves_clean_default_branch_checkout_to_project() {
        let repository_root = init_test_repo("projects-managed-branch-normalize");
        normalize_managed_checkout_branch(&repository_root, "main", true)
            .expect("managed checkout should normalize");

        assert_eq!(current_branch(&repository_root), "project");
        assert!(git_has_ref(&repository_root, "refs/heads/main").expect("main ref should resolve"));
    }

    #[test]
    fn normalize_managed_checkout_branch_rejects_dirty_default_branch_checkout_with_repair_path() {
        let repository_root = init_test_repo("projects-managed-branch-dirty");
        fs::write(repository_root.join("README.md"), "# dirty\n").expect("README should update");

        let error = normalize_managed_checkout_branch(&repository_root, "main", false)
            .expect_err("dirty default-branch checkout should require repair");

        assert_eq!(current_branch(&repository_root), "main");
        assert!(error.contains("still checked out on default branch main"));
        assert!(error.contains("commit, stash, or discard"));
        assert!(error.contains("blocks worktrees that need main"));
    }

    #[test]
    fn list_repositories_rejects_unknown_projects() {
        let connection = in_memory_connection();
        let error = list_repositories(&connection, Some("project-missing"))
            .expect_err("unknown projects should be rejected");
        assert!(error.contains("Project project-missing was not found"));
    }

    #[test]
    fn set_project_default_repository_rejects_cross_project_repositories() {
        let connection = in_memory_connection();
        let now = "2026-04-03T00:00:00Z";
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-a', 'project-a', 'Project A', NULL, 'PA', NULL, ?1, ?1)",
                [now],
            )
            .expect("project A should insert");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-b', 'project-b', 'Project B', NULL, 'PB', NULL, ?1, ?1)",
                [now],
            )
            .expect("project B should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, mode, default_branch, created_at, updated_at) VALUES ('repo-b', 'project-b', 'repo-b', 'Repo B', '/tmp/repo-b', NULL, 'existing', 'main', ?1, ?1)",
                [now],
            )
            .expect("repository B should insert");

        let error = set_project_default_repository(&connection, "project-a", Some("repo-b"))
            .expect_err("cross-project repositories should be rejected");
        assert!(error.contains("does not belong to project project-a"));
    }

    #[test]
    fn resolves_project_runtime_root_from_existing_default_repository_path() {
        let database_path = unique_temp_path("projects-runtime-root").join("orchestra.db");
        let database_parent = database_path
            .parent()
            .expect("database path should have a parent");
        fs::create_dir_all(database_parent).expect("database parent should exist");
        crate::services::database::initialize_database_at(&database_path)
            .expect("database schema should initialize");
        let connection = Connection::open(&database_path).expect("database should open");

        let repository_root = unique_temp_path("projects-runtime-root-repo");
        fs::create_dir_all(&repository_root).expect("repository root should exist");

        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'PSS', ?4, ?5, ?5)",
                params!["project-1", "pss-frontend", "PSS Frontend", "repo-1", "2026-04-02T00:00:00Z"],
            )
            .expect("project should insert");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, NULL, 'main', ?6, ?6)",
                params!["repo-1", "project-1", "pss-frontend", "PSS Frontend repo", repository_root.display().to_string(), "2026-04-02T00:00:00Z"],
            )
            .expect("repository should insert");

        let resolved = resolve_project_runtime_root(&connection, "pss-frontend")
            .expect("runtime root should resolve");
        assert_eq!(resolved, repository_root);
    }

    #[test]
    fn create_project_requires_unique_valid_task_prefix() {
        let connection = in_memory_connection();
        let created = create_project(
            &connection,
            ProjectUpsertInput {
                name: "Client Project".into(),
                description: None,
                task_prefix: " cli ".into(),
            },
        )
        .expect("project should create");
        assert_eq!(created.task_prefix, "CLI");

        let duplicate_error = create_project(
            &connection,
            ProjectUpsertInput {
                name: "Another Client Project".into(),
                description: None,
                task_prefix: "cli".into(),
            },
        )
        .expect_err("duplicate prefixes should fail");
        assert!(duplicate_error.contains("Task prefix CLI is already used by another project."));

        let missing_error = create_project(
            &connection,
            ProjectUpsertInput {
                name: "Missing Prefix".into(),
                description: None,
                task_prefix: " ".into(),
            },
        )
        .expect_err("missing prefixes should fail");
        assert!(missing_error.contains("Task prefix is required."));
    }

    #[test]
    fn update_project_rejects_duplicate_task_prefixes() {
        let connection = in_memory_connection();
        let project_a = create_project(
            &connection,
            ProjectUpsertInput {
                name: "Project A".into(),
                description: None,
                task_prefix: "PA".into(),
            },
        )
        .expect("project A should create");
        let project_b = create_project(
            &connection,
            ProjectUpsertInput {
                name: "Project B".into(),
                description: None,
                task_prefix: "PB".into(),
            },
        )
        .expect("project B should create");

        let error = update_project(
            &connection,
            &project_b.id,
            ProjectUpsertInput {
                name: project_b.name.clone(),
                description: project_b.description.clone(),
                task_prefix: project_a.task_prefix.clone(),
            },
        )
        .expect_err("duplicate update should fail");
        assert!(error.contains("Task prefix PA is already used by another project."));
    }
}
