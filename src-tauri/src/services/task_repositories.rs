use chrono::Utc;
use rusqlite::Connection;

use crate::{
    models::TaskRepository,
    services::projects,
};

pub fn load_task_repositories(
    connection: &Connection,
    task_id: &str,
    task_workspace_root: Option<&str>,
) -> Result<Vec<TaskRepository>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                tr.task_id,
                tr.repository_id,
                repo.name,
                repo.slug,
                repo.local_path,
                repo.remote_url,
                tr.created_at
            FROM task_repositories tr
            JOIN repositories repo ON repo.id = tr.repository_id
            WHERE tr.task_id = ?1
            ORDER BY tr.created_at ASC, repo.name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task repository query: {error}"))?;

    let rows = statement
        .query_map([task_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, Option<String>>(5)?,
                row.get::<_, String>(6)?,
            ))
        })
        .map_err(|error| format!("Unable to query task repositories for {task_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect task repositories for {task_id}: {error}"))?
        .into_iter()
        .map(
            |(task_id, repository_id, repository_name, repository_slug, managed_repository_path, source_path, created_at)| {
                let task_worktree_path = task_workspace_root
                    .map(|workspace_root| task_repository_worktree_path(workspace_root, repository_slug.as_str()));
                Ok(TaskRepository {
                    task_id,
                    repository_id,
                    repository_name,
                    repository_slug,
                    managed_repository_path,
                    source_kind: source_path
                        .as_deref()
                        .map(|value| if projects::is_remote_repository_path(value) { "remote" } else { "local" })
                        .map(str::to_string),
                    source_path,
                    task_worktree_path,
                    created_at,
                })
            },
        )
        .collect()
}

pub fn shared_task_workspaces_root(project_root: &std::path::Path) -> String {
    project_root.join("task-workspaces").display().to_string()
}

pub fn task_workspace_root(base_cwd: &str, task_id: &str) -> String {
    std::path::Path::new(base_cwd)
        .join("tasks")
        .join(task_id)
        .display()
        .to_string()
}

pub fn task_repositories_root(task_workspace_root: &str) -> String {
    std::path::Path::new(task_workspace_root)
        .join("repos")
        .display()
        .to_string()
}

pub fn task_repository_worktree_path(task_workspace_root: &str, repository_slug: &str) -> String {
    std::path::Path::new(task_workspace_root)
        .join("repos")
        .join(repository_slug)
        .display()
        .to_string()
}

pub fn now_iso() -> String {
    Utc::now().to_rfc3339()
}
