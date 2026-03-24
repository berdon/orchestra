use std::{fs, path::PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{
    ProjectDetail, ProjectSummary, ProjectUpsertInput, RepositoryRecord, RepositoryUpsertInput,
};
use crate::services::orchestra_paths::{
    default_orchestra_root, managed_repository_checkout_dir, project_root, sanitize_slug,
};

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

    ensure_project_root_exists(&slug)?;

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
    if normalized.repository_path.is_none() {
        return Err("Repository path is required.".into());
    }

    let project = get_project(connection, project_id)?;
    let repository_id = format!("repo-{}", Uuid::new_v4().simple());
    let slug = unique_repository_slug(connection, project_id, &normalized.name, None)?;
    let source_path = normalized
        .repository_path
        .as_deref()
        .expect("validated repository path");
    let managed_checkout_dir = ensure_managed_repository_checkout(
        &project,
        &slug,
        source_path,
        normalized.default_branch.as_deref().unwrap_or("main"),
    )?;
    let now = now_iso();
    connection
        .execute(
            r#"
            INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at)
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?8)
            "#,
            params![repository_id, project_id, slug, normalized.name, managed_checkout_dir.display().to_string(), Some(source_path.to_string()), normalized.default_branch, now],
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
    let project = get_project(connection, &existing.project_id)?;
    let normalized = normalize_repository_input(input);
    let slug = if sanitize_slug(&normalized.name) == sanitize_slug(&existing.name) {
        existing.slug.clone()
    } else {
        unique_repository_slug(connection, &existing.project_id, &normalized.name, Some(repository_id))?
    };
    let source_path = normalized
        .repository_path
        .as_deref()
        .expect("validated repository path");
    let managed_checkout_dir = ensure_managed_repository_checkout(
        &project,
        &slug,
        source_path,
        normalized.default_branch.as_deref().unwrap_or("main"),
    )?;
    connection
        .execute(
            "UPDATE repositories SET slug = ?2, name = ?3, local_path = ?4, remote_url = ?5, default_branch = ?6, updated_at = ?7 WHERE id = ?1",
            params![repository_id, slug, normalized.name, managed_checkout_dir.display().to_string(), Some(source_path.to_string()), normalized.default_branch, now_iso()],
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

pub fn delete_project(connection: &Connection, project_id: &str) -> Result<ProjectDetail, String> {
    let project = get_project(connection, project_id)?;
    if project.id == DEFAULT_PROJECT_ID {
        return Err("The default Orchestra project cannot be deleted.".into());
    }

    connection
        .execute("DELETE FROM projects WHERE id = ?1", [project_id])
        .map_err(|error| format!("Unable to delete project {project_id}: {error}"))?;

    let orchestra_root = default_orchestra_root()?;
    let root = project_root(&orchestra_root, &project.slug);
    if root.exists() {
        fs::remove_dir_all(&root)
            .map_err(|error| format!("Unable to remove project directory {}: {error}", root.display()))?;
    }

    Ok(project)
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

const DEFAULT_PROJECT_ID: &str = "orchestra";
const DEFAULT_REPOSITORY_ID: &str = "repo-orchestra";

fn ensure_default_project(connection: &Connection) -> Result<(), String> {
    let count: i64 = connection
        .query_row("SELECT COUNT(*) FROM projects", [], |row| row.get(0))
        .map_err(|error| format!("Unable to count projects: {error}"))?;
    if count > 0 {
        return Ok(());
    }

    let now = now_iso();
    let default_path = std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .parent()
        .and_then(|path| path.parent())
        .and_then(|path| path.parent())
        .map(|path| path.join("orchestra").join("repository"))
        .unwrap_or_else(|| std::path::PathBuf::from(env!("CARGO_MANIFEST_DIR")).parent().unwrap().to_path_buf());
    connection
        .execute(
            "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES (?1, 'orchestra', 'Orchestra', 'Default Orchestra project', ?2, ?3, ?3)",
            params![DEFAULT_PROJECT_ID, DEFAULT_REPOSITORY_ID, now],
        )
        .map_err(|error| format!("Unable to seed default project: {error}"))?;
    connection
        .execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES (?1, ?2, 'orchestra', 'Orchestra repository', ?3, NULL, 'main', ?4, ?4)",
            params![DEFAULT_REPOSITORY_ID, DEFAULT_PROJECT_ID, default_path.display().to_string(), now],
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
    input.repository_path = input.repository_path.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() {
            None
        } else if is_remote_repository_path(trimmed) {
            Some(trimmed.to_string())
        } else {
            Some(normalize_repository_local_path(trimmed).display().to_string())
        }
    });
    input.default_branch = input.default_branch.and_then(|value| {
        let trimmed = value.trim();
        if trimmed.is_empty() { None } else { Some(trimmed.to_string()) }
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
    if colon_pos == 1 && path.as_bytes().get(0).map(|&b| b.is_ascii_alphabetic()).unwrap_or(false) {
        return false;
    }
    // After colon should look like a path (contains '/' or '.git' or similar)
    let after_colon = &path[colon_pos + 1..];
    after_colon.contains('/') || after_colon.contains('\\') || after_colon.ends_with(".git")
}

fn ensure_project_root_exists(project_slug: &str) -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let root = project_root(&orchestra_root, project_slug);
    fs::create_dir_all(&root)
        .map_err(|error| format!("Unable to create project directory {}: {error}", root.display()))?;
    Ok(root)
}

fn ensure_managed_repository_checkout(
    project: &ProjectDetail,
    repository_slug: &str,
    source_path: &str,
    default_branch: &str,
) -> Result<PathBuf, String> {
    let orchestra_root = default_orchestra_root()?;
    let managed_checkout_dir = managed_repository_checkout_dir(&orchestra_root, &project.slug, repository_slug);
    if let Some(parent) = managed_checkout_dir.parent() {
        std::fs::create_dir_all(parent).map_err(|error| {
            format!(
                "Unable to create managed repository parent {}: {error}",
                parent.display()
            )
        })?;
    }

    if managed_checkout_dir.join(".git").exists() {
        return Ok(managed_checkout_dir);
    }

    if is_remote_repository_path(source_path) {
        let status = std::process::Command::new("git")
            .arg("clone")
            .arg(source_path)
            .arg(&managed_checkout_dir)
            .status()
            .map_err(|error| format!("Unable to clone repository from {source_path}: {error}"))?;
        if !status.success() {
            return Err(format!(
                "Unable to clone repository from {source_path} into {}",
                managed_checkout_dir.display()
            ));
        }
        return Ok(managed_checkout_dir);
    }

    let source = PathBuf::from(source_path);
    if source.join(".git").exists() {
        let status = std::process::Command::new("git")
            .arg("clone")
            .arg(source.as_os_str())
            .arg(&managed_checkout_dir)
            .status()
            .map_err(|error| format!("Unable to clone repository from {}: {error}", source.display()))?;
        if !status.success() {
            return Err(format!(
                "Unable to clone repository from {} into {}",
                source.display(),
                managed_checkout_dir.display()
            ));
        }
        return Ok(managed_checkout_dir);
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
        .map_err(|error| format!("Unable to initialize managed repository {}: {error}", managed_checkout_dir.display()))?;
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
    std::fs::write(managed_checkout_dir.join("README.md"), format!("# {}\n", project.name)).map_err(|error| {
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

    Ok(managed_checkout_dir)
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
    let repository_path = row.get::<_, Option<String>>(4)?;
    let source_path = row.get::<_, Option<String>>(5)?;
    let source_kind = source_path
        .as_deref()
        .map(|value| if is_remote_repository_path(value) { "remote" } else { "local" })
        .map(str::to_string);

    Ok(RepositoryRecord {
        id: row.get(0)?,
        project_id: row.get(1)?,
        slug: row.get(2)?,
        name: row.get(3)?,
        repository_path,
        source_path,
        source_kind,
        default_branch: row.get(6)?,
        created_at: row.get(7)?,
        updated_at: row.get(8)?,
    })
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_is_remote_repository_path_detects_https() {
        assert!(is_remote_repository_path("https://github.com/user/repo.git"));
        assert!(is_remote_repository_path("https://gitlab.com/user/repo"));
    }

    #[test]
    fn test_is_remote_repository_path_detects_http() {
        assert!(is_remote_repository_path("http://github.com/user/repo.git"));
    }

    #[test]
    fn test_is_remote_repository_path_detects_ssh_protocol() {
        assert!(is_remote_repository_path("ssh://git@github.com/user/repo.git"));
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
}
