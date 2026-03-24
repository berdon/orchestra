use std::path::{Component, Path, PathBuf};

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::{
    models::{TaskFileReference, TaskFileReferenceInput},
    services::projects,
};

pub fn add_task_file_reference(
    connection: &mut Connection,
    task_id: &str,
    input: TaskFileReferenceInput,
) -> Result<TaskFileReference, String> {
    let project_id = task_project_id(connection, task_id)?;
    let repository = projects::get_repository(connection, &input.repository_id)?;
    if repository.project_id != project_id {
        return Err(format!(
            "Repository {} does not belong to the same project as task {}",
            repository.id, task_id
        ));
    }

    let relative_path = normalize_relative_path(&input.relative_path)?;
    let now = now_iso();
    let reference_id = reference_id();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start task file reference transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO task_file_references (
            id,
            project_id,
            task_id,
            repository_id,
            relative_path,
            created_at
        )
        VALUES (?1, ?2, ?3, ?4, ?5, ?6)
        "#,
        params![reference_id, project_id, task_id, repository.id, relative_path, now],
    )
    .map_err(|error| format!("Unable to record task file reference: {error}"))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit task file reference: {error}"))?;

    let runtime_cwd = crate::services::task_runtime::get_active_lane_assignment(connection, task_id)?
        .as_ref()
        .and_then(|assignment| assignment.runtime_cwd.as_deref())
        .map(str::to_string);
    load_task_file_reference(connection, &reference_id, runtime_cwd.as_deref())
}

pub fn remove_task_file_reference(
    connection: &Connection,
    reference_id: &str,
) -> Result<TaskFileReference, String> {
    let reference = load_task_file_reference(connection, reference_id, None)?;
    let deleted = connection
        .execute("DELETE FROM task_file_references WHERE id = ?1", [reference_id])
        .map_err(|error| format!("Unable to delete task file reference {reference_id}: {error}"))?;

    if deleted == 0 {
        return Err(format!("Task file reference {reference_id} was not found"));
    }

    Ok(reference)
}

pub fn load_task_file_references(
    connection: &Connection,
    task_id: &str,
    runtime_cwd: Option<&str>,
) -> Result<Vec<TaskFileReference>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                r.id,
                r.task_id,
                r.repository_id,
                repo.name,
                repo.slug,
                repo.local_path,
                r.relative_path,
                r.created_at
            FROM task_file_references r
            JOIN repositories repo ON repo.id = r.repository_id
            WHERE r.task_id = ?1
            ORDER BY r.created_at ASC, r.id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task file reference query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, String>(7)?,
            ))
        })
        .map_err(|error| format!("Unable to read task file references for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task file references for {task_id}: {error}"))?
        .into_iter()
        .map(
            |(id, task_id, repository_id, repository_name, repository_slug, repository_local_path, relative_path, created_at)| {
                build_reference(
                    id,
                    task_id,
                    repository_id,
                    repository_name,
                    repository_slug,
                    repository_local_path,
                    runtime_cwd,
                    relative_path,
                    created_at,
                )
            },
        )
        .collect()
}

pub fn load_task_file_reference(
    connection: &Connection,
    reference_id: &str,
    runtime_cwd: Option<&str>,
) -> Result<TaskFileReference, String> {
    let row = connection
        .query_row(
            r#"
            SELECT
                r.id,
                r.task_id,
                r.repository_id,
                repo.name,
                repo.slug,
                repo.local_path,
                r.relative_path,
                r.created_at
            FROM task_file_references r
            JOIN repositories repo ON repo.id = r.repository_id
            WHERE r.id = ?1
            "#,
            [reference_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load task file reference {reference_id}: {error}"))?
        .ok_or_else(|| format!("Task file reference {reference_id} was not found"))?;

    build_reference(row.0, row.1, row.2, row.3, row.4, row.5, runtime_cwd, row.6, row.7)
}

fn build_reference(
    id: String,
    task_id: String,
    repository_id: String,
    repository_name: String,
    repository_slug: String,
    repository_local_path: Option<String>,
    runtime_cwd: Option<&str>,
    relative_path: String,
    created_at: String,
) -> Result<TaskFileReference, String> {
    let task_workspace_path = runtime_cwd
        .map(|cwd| crate::services::task_repositories::task_repository_worktree_path(cwd, task_id.as_str(), repository_slug.as_str()))
        .map(PathBuf::from);
    let managed_repository_path = repository_local_path.as_deref().map(PathBuf::from);

    let preferred_path = task_workspace_path
        .as_ref()
        .map(|root| root.join(&relative_path))
        .filter(|path| path.exists())
        .or_else(|| {
            managed_repository_path
                .as_ref()
                .map(|root| root.join(&relative_path))
                .filter(|path| path.exists())
        })
        .or_else(|| task_workspace_path.as_ref().map(|root| root.join(&relative_path)))
        .or_else(|| managed_repository_path.as_ref().map(|root| root.join(&relative_path)));
    let exists = preferred_path.as_ref().is_some_and(|path| path.exists());

    Ok(TaskFileReference {
        id,
        task_id,
        repository_id,
        repository_name,
        repository_slug,
        relative_path,
        absolute_path: preferred_path.map(|path| path.display().to_string()),
        exists,
        created_at,
    })
}

fn task_project_id(connection: &Connection, task_id: &str) -> Result<String, String> {
    connection
        .query_row("SELECT project_id FROM tasks WHERE id = ?1", [task_id], |row| row.get(0))
        .map_err(|error| format!("Unable to resolve project for task {task_id}: {error}"))
}

fn normalize_relative_path(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("relativePath: File path is required.".into());
    }

    let path = Path::new(trimmed);
    if path.is_absolute() {
        return Err("relativePath: File path must be relative to the repository root.".into());
    }

    let mut normalized = PathBuf::new();
    for component in path.components() {
        match component {
            Component::Normal(segment) => normalized.push(segment),
            Component::CurDir => {}
            Component::ParentDir => {
                return Err("relativePath: File path must stay inside the repository root.".into())
            }
            Component::Prefix(_) | Component::RootDir => {
                return Err("relativePath: File path must be relative to the repository root.".into())
            }
        }
    }

    let normalized = normalized
        .to_string_lossy()
        .replace('\\', "/");
    if normalized.is_empty() {
        return Err("relativePath: File path is required.".into());
    }

    Ok(normalized)
}

fn reference_id() -> String {
    format!("task-file-reference-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database;

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn seed_project_repo_task(connection: &mut Connection) -> (String, String, String) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project', 'Project', NULL, 'repo-1', ?1, ?1)",
                [now.as_str()],
            )
            .expect("insert project");
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-1', 'project-1', 'repo', 'Repo', '/tmp/repo', NULL, 'main', ?1, ?1)",
                [now.as_str()],
            )
            .expect("insert repository");
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, task_type, status, priority, assignee_type, repository_id, archived, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'ORC-1', 'Task', 'task', 'ready', 'P2', 'user', 'repo-1', 0, ?1, ?1)",
                [now.as_str()],
            )
            .expect("insert task");
        ("project-1".into(), "repo-1".into(), "task-1".into())
    }

    #[test]
    fn rejects_parent_directory_paths() {
        assert!(normalize_relative_path("../secret.txt").is_err());
        assert!(normalize_relative_path("/abs/path.txt").is_err());
    }

    #[test]
    fn stores_and_loads_references() {
        let mut connection = in_memory_connection();
        let (_, repo_id, task_id) = seed_project_repo_task(&mut connection);
        let reference = add_task_file_reference(
            &mut connection,
            &task_id,
            TaskFileReferenceInput {
                repository_id: repo_id.clone(),
                relative_path: "docs/design.md".into(),
            },
        )
        .expect("add file reference");

        assert_eq!(reference.repository_id, repo_id);
        assert_eq!(reference.relative_path, "docs/design.md");
        assert!(reference.absolute_path.as_deref().unwrap_or_default().ends_with("/tmp/repo/docs/design.md"));

        let loaded = load_task_file_references(&connection, &task_id, None).expect("load file references");
        assert_eq!(loaded.len(), 1);
        let removed = remove_task_file_reference(&connection, &reference.id).expect("remove file reference");
        assert_eq!(removed.id, reference.id);
    }

    #[test]
    fn prefers_task_worktree_paths_when_the_file_exists_there() {
        let mut connection = in_memory_connection();
        let (_, repo_id, task_id) = seed_project_repo_task(&mut connection);
        let root = std::env::temp_dir().join(format!("task-file-reference-worktree-{}", Uuid::new_v4().simple()));
        let repo_root = root.join("repository");
        let task_repo_root = root.join("runtime").join("tasks").join(&task_id).join("repos").join("repo");
        std::fs::create_dir_all(repo_root.join("docs")).expect("managed repo docs dir should create");
        std::fs::create_dir_all(task_repo_root.join("docs")).expect("task repo docs dir should create");
        std::fs::write(task_repo_root.join("docs").join("design.md"), "task worktree file\n").expect("task repo file should write");
        connection
            .execute(
                "UPDATE repositories SET local_path = ?2 WHERE id = ?1",
                params![repo_id.as_str(), repo_root.display().to_string()],
            )
            .expect("repository local path should update");

        let reference = add_task_file_reference(
            &mut connection,
            &task_id,
            TaskFileReferenceInput {
                repository_id: repo_id.clone(),
                relative_path: "docs/design.md".into(),
            },
        )
        .expect("add file reference");

        let runtime_root = root.join("runtime").display().to_string();
        let expected_path = task_repo_root.join("docs").join("design.md").display().to_string();
        let loaded = load_task_file_reference(&connection, &reference.id, Some(&runtime_root))
            .expect("load task file reference");
        assert!(loaded.exists);
        assert_eq!(loaded.absolute_path.as_deref(), Some(expected_path.as_str()));
    }
}
