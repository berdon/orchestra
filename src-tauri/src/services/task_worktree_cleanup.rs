use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};

use chrono::{DateTime, Duration, Utc};
use rusqlite::{params, Connection};

use crate::{
    models::TaskLaneAssignment,
    services::{git_worktrees, task_runtime},
};

const COMPLETED_TASK_WORKTREE_RETENTION_HOURS: i64 = 24;
const COMPLETED_TASK_WORKTREE_RETRY_HOURS: i64 = 1;
const OPEN_ASSIGNMENT_STATUSES: &[&str] = &[
    "queued",
    "active",
    "awaiting_user_approval",
    "awaiting_user_intervention",
    "paused_by_user",
];

struct DueTaskCleanupCandidate {
    task_id: String,
    project_id: String,
}

pub fn sync_task_worktree_cleanup_state(
    connection: &Connection,
    task_id: &str,
    previous_status: Option<&str>,
    next_status: &str,
    now: &str,
) -> Result<(), String> {
    let was_completed = previous_status == Some("completed");
    let is_completed = next_status == "completed";

    if is_completed {
        if was_completed {
            return Ok(());
        }

        let due_at = shift_timestamp(
            now,
            Duration::hours(COMPLETED_TASK_WORKTREE_RETENTION_HOURS),
        )?;
        connection
            .execute(
                r#"
                UPDATE tasks
                SET completed_at = ?2,
                    worktree_cleanup_due_at = ?3,
                    worktree_cleanup_completed_at = NULL,
                    worktree_cleanup_last_error = NULL
                WHERE id = ?1
                "#,
                params![task_id, now, due_at],
            )
            .map_err(|error| {
                format!("Unable to schedule delayed worktree cleanup for task {task_id}: {error}")
            })?;
        return Ok(());
    }

    if !was_completed && previous_status.is_some() {
        return Ok(());
    }

    connection
        .execute(
            r#"
            UPDATE tasks
            SET completed_at = NULL,
                worktree_cleanup_due_at = NULL,
                worktree_cleanup_completed_at = NULL,
                worktree_cleanup_last_error = NULL
            WHERE id = ?1
            "#,
            [task_id],
        )
        .map_err(|error| {
            format!("Unable to clear delayed worktree cleanup state for task {task_id}: {error}")
        })?;
    Ok(())
}

pub fn process_due_task_worktree_cleanups(
    connection: &Connection,
    now: &str,
) -> Result<usize, String> {
    let candidates = list_due_task_cleanup_candidates(connection, now)?;
    let mut actions = 0;

    for candidate in candidates {
        match cleanup_completed_task_worktrees(connection, &candidate, now) {
            Ok(()) => actions += 1,
            Err(error) => {
                record_cleanup_failure(connection, &candidate.task_id, now, &error)?;
                actions += 1;
            }
        }
    }

    Ok(actions)
}

fn list_due_task_cleanup_candidates(
    connection: &Connection,
    now: &str,
) -> Result<Vec<DueTaskCleanupCandidate>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, project_id
            FROM tasks
            WHERE status = 'completed'
              AND worktree_cleanup_completed_at IS NULL
              AND worktree_cleanup_due_at IS NOT NULL
              AND julianday(worktree_cleanup_due_at) <= julianday(?1)
            ORDER BY worktree_cleanup_due_at ASC, updated_at ASC, created_at ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare due task worktree cleanup query: {error}"))?;

    let rows = statement
        .query_map([now], |row| {
            Ok(DueTaskCleanupCandidate {
                task_id: row.get(0)?,
                project_id: row.get(1)?,
            })
        })
        .map_err(|error| format!("Unable to query due task worktree cleanups: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect due task worktree cleanups: {error}"))
}

fn cleanup_completed_task_worktrees(
    connection: &Connection,
    candidate: &DueTaskCleanupCandidate,
    now: &str,
) -> Result<(), String> {
    if has_open_assignments(connection, &candidate.task_id)? {
        return Err(format!(
            "Task {} still has non-terminal lane assignments and is not eligible for worktree cleanup",
            candidate.task_id
        ));
    }

    let workspace_roots =
        derive_task_workspace_roots(connection, &candidate.task_id, &candidate.project_id)?;
    let repository_roots = load_managed_repository_roots(connection, &candidate.project_id)?;

    for workspace_root in &workspace_roots {
        cleanup_workspace_root(
            repository_roots.as_slice(),
            workspace_root,
            &candidate.task_id,
        )?;
        clear_role_instance_worktree_paths(connection, workspace_root, now)?;
    }

    mark_cleanup_completed(connection, &candidate.task_id, now)
}

fn has_open_assignments(connection: &Connection, task_id: &str) -> Result<bool, String> {
    let placeholders = OPEN_ASSIGNMENT_STATUSES
        .iter()
        .enumerate()
        .map(|(index, _)| format!("?{}", index + 2))
        .collect::<Vec<_>>()
        .join(", ");
    let sql = format!(
        "SELECT COUNT(*) FROM task_lane_assignments WHERE task_id = ?1 AND status IN ({placeholders})"
    );

    let status_values = OPEN_ASSIGNMENT_STATUSES
        .iter()
        .map(|status| rusqlite::types::Value::from(status.to_string()))
        .collect::<Vec<_>>();
    let mut dynamic = Vec::with_capacity(1 + status_values.len());
    dynamic.push(rusqlite::types::Value::from(task_id.to_string()));
    dynamic.extend(status_values);

    let count = connection
        .query_row(&sql, rusqlite::params_from_iter(dynamic), |row| row.get::<_, i64>(0))
        .map_err(|error| {
            format!(
                "Unable to inspect open assignments for task {task_id} during worktree cleanup: {error}"
            )
        })?;
    Ok(count > 0)
}

fn derive_task_workspace_roots(
    connection: &Connection,
    task_id: &str,
    project_id: &str,
) -> Result<Vec<PathBuf>, String> {
    let assignments = list_task_assignments_with_runtime_cwds(connection, task_id)?;
    let mut roots = BTreeSet::new();

    for assignment in assignments {
        let Some(resolved) = task_runtime::resolve_assignment_workspace_cwd(
            connection,
            &assignment,
            task_id,
            project_id,
        )?
        else {
            continue;
        };
        let path = PathBuf::from(resolved);
        if is_safe_task_workspace_root(&path, task_id) {
            roots.insert(path);
        }
    }

    Ok(roots.into_iter().collect())
}

fn list_task_assignments_with_runtime_cwds(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<TaskLaneAssignment>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_summary,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            FROM task_lane_assignments
            WHERE task_id = ?1
              AND runtime_cwd IS NOT NULL
              AND trim(runtime_cwd) != ''
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| {
            format!(
                "Unable to prepare task assignment history query for cleanup task {task_id}: {error}"
            )
        })?;

    let rows = statement
        .query_map([task_id], read_task_lane_assignment)
        .map_err(|error| {
            format!("Unable to query task assignment history for cleanup task {task_id}: {error}")
        })?;

    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        format!("Unable to collect task assignment history for cleanup task {task_id}: {error}")
    })
}

fn read_task_lane_assignment(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskLaneAssignment> {
    Ok(TaskLaneAssignment {
        id: row.get(0)?,
        task_id: row.get(1)?,
        workflow_id: row.get(2)?,
        lane_id: row.get(3)?,
        worker_type: row.get(4)?,
        worker_id: row.get(5)?,
        status: row.get(6)?,
        session_id: row.get(7)?,
        runtime_cwd: row.get(8)?,
        role_queue_entry_id: row.get(9)?,
        role_instance_id: row.get(10)?,
        prompt: row.get(11)?,
        pending_outcome: row.get(12)?,
        completion_summary: row.get(13)?,
        completion_notes: row.get(14)?,
        whip_count: row.get(15)?,
        last_whip_at: row.get(16)?,
        started_at: row.get(17)?,
        completed_at: row.get(18)?,
        created_at: row.get(19)?,
        updated_at: row.get(20)?,
    })
}

fn is_safe_task_workspace_root(path: &Path, task_id: &str) -> bool {
    path.ends_with(Path::new("tasks").join(task_id))
}

fn load_managed_repository_roots(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<PathBuf>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT local_path
            FROM repositories
            WHERE project_id = ?1
              AND local_path IS NOT NULL
              AND trim(local_path) != ''
            ORDER BY created_at ASC, id ASC
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare managed repository query for project {project_id}: {error}")
        })?;

    let rows = statement
        .query_map([project_id], |row| row.get::<_, String>(0))
        .map_err(|error| {
            format!("Unable to query managed repositories for project {project_id}: {error}")
        })?;

    let mut roots = BTreeSet::new();
    for row in rows {
        let path = PathBuf::from(row.map_err(|error| {
            format!("Unable to read managed repository path for project {project_id}: {error}")
        })?);
        roots.insert(path);
    }
    Ok(roots.into_iter().collect())
}

fn cleanup_workspace_root(
    repository_roots: &[PathBuf],
    workspace_root: &Path,
    task_id: &str,
) -> Result<(), String> {
    if !is_safe_task_workspace_root(workspace_root, task_id) {
        return Ok(());
    }

    for repository_root in repository_roots {
        cleanup_repository_worktrees_under_root(repository_root, workspace_root)?;
    }

    if workspace_root.exists() {
        fs::remove_dir_all(workspace_root).map_err(|error| {
            format!(
                "Unable to remove completed task workspace {}: {error}",
                workspace_root.display()
            )
        })?;
    }

    Ok(())
}

fn cleanup_repository_worktrees_under_root(
    repository_root: &Path,
    workspace_root: &Path,
) -> Result<(), String> {
    let worktrees = git_worktrees::list_worktree_paths(repository_root)?;
    let matching = worktrees_under_root(worktrees.as_slice(), workspace_root);

    for worktree in &matching {
        if worktree.exists() {
            git_worktrees::dispose_worktree(repository_root, worktree)?;
        }
    }

    git_worktrees::prune_worktrees(repository_root)?;

    let remaining = worktrees_under_root(
        git_worktrees::list_worktree_paths(repository_root)?.as_slice(),
        workspace_root,
    );
    if remaining.is_empty() {
        return Ok(());
    }

    Err(format!(
        "Repository {} still reports task worktrees under {} after cleanup: {}",
        repository_root.display(),
        workspace_root.display(),
        remaining
            .iter()
            .map(|path| path.display().to_string())
            .collect::<Vec<_>>()
            .join(", ")
    ))
}

fn worktrees_under_root(worktrees: &[PathBuf], workspace_root: &Path) -> Vec<PathBuf> {
    worktrees
        .iter()
        .filter(|path| path.starts_with(workspace_root))
        .cloned()
        .collect()
}

fn clear_role_instance_worktree_paths(
    connection: &Connection,
    workspace_root: &Path,
    now: &str,
) -> Result<(), String> {
    let root = workspace_root.display().to_string();
    let prefix = format!(
        "{}{}%",
        root.trim_end_matches(std::path::MAIN_SEPARATOR),
        std::path::MAIN_SEPARATOR
    );
    connection
        .execute(
            r#"
            UPDATE role_instances
            SET worktree_path = NULL,
                updated_at = ?3
            WHERE worktree_path = ?1 OR worktree_path LIKE ?2
            "#,
            params![root, prefix, now],
        )
        .map_err(|error| {
            format!(
                "Unable to clear stale role instance worktree paths under {}: {error}",
                workspace_root.display()
            )
        })?;
    Ok(())
}

fn mark_cleanup_completed(connection: &Connection, task_id: &str, now: &str) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE tasks
            SET worktree_cleanup_due_at = NULL,
                worktree_cleanup_completed_at = ?2,
                worktree_cleanup_last_error = NULL
            WHERE id = ?1
            "#,
            params![task_id, now],
        )
        .map_err(|error| {
            format!("Unable to mark delayed worktree cleanup complete for task {task_id}: {error}")
        })?;
    Ok(())
}

fn record_cleanup_failure(
    connection: &Connection,
    task_id: &str,
    now: &str,
    error: &str,
) -> Result<(), String> {
    let retry_at = shift_timestamp(now, Duration::hours(COMPLETED_TASK_WORKTREE_RETRY_HOURS))?;
    connection
        .execute(
            r#"
            UPDATE tasks
            SET worktree_cleanup_due_at = ?2,
                worktree_cleanup_last_error = ?3
            WHERE id = ?1
            "#,
            params![task_id, retry_at, error],
        )
        .map_err(|db_error| {
            format!(
                "Unable to record delayed worktree cleanup failure for task {task_id}: {db_error}"
            )
        })?;
    Ok(())
}

fn shift_timestamp(value: &str, delta: Duration) -> Result<String, String> {
    let parsed = DateTime::parse_from_rfc3339(value)
        .map_err(|error| format!("Unable to parse RFC3339 timestamp {value}: {error}"))?;
    Ok((parsed.with_timezone(&Utc) + delta).to_rfc3339())
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        fs::File,
        io::Write,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    use crate::{
        models::TaskUpsertInput,
        services::{database, tasks},
    };

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    fn ensure_default_project(connection: &Connection) {
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                [now.as_str()],
            )
            .expect("default project should seed");
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        std::env::temp_dir().join(format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        ))
    }

    fn init_test_repo(label: &str) -> PathBuf {
        let root = unique_temp_dir(label);
        let repo = root.join("repository");
        fs::create_dir_all(&repo).expect("repository dir should create");

        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["init", "-b", "main"])
            .status()
            .expect("git init should run")
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "user.email", "test@example.com"])
            .status()
            .expect("git config email should run")
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["config", "user.name", "Test User"])
            .status()
            .expect("git config name should run")
            .success());

        let mut file = File::create(repo.join("README.md")).expect("README should create");
        writeln!(file, "test repo").expect("README should write");

        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["add", "README.md"])
            .status()
            .expect("git add should run")
            .success());
        assert!(Command::new("git")
            .arg("-C")
            .arg(&repo)
            .args(["commit", "-m", "init"])
            .status()
            .expect("git commit should run")
            .success());

        repo
    }

    fn insert_repository(connection: &Connection, repo_id: &str, path: &Path) {
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES (?1, 'orchestra', ?2, ?3, ?4, NULL, 'main', ?5, ?5)",
                params![repo_id, repo_id, repo_id, path.display().to_string(), now],
            )
            .expect("repository should insert");
    }

    fn create_completed_task(
        connection: &mut Connection,
        repo_id: &str,
    ) -> crate::models::TaskDetail {
        tasks::create_task(
            connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Cleanup me".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "completed".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some(repo_id.into()),
                repository_ids: vec![repo_id.into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create")
    }

    fn task_cleanup_state(
        connection: &Connection,
        task_id: &str,
    ) -> (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ) {
        connection
            .query_row(
                "SELECT completed_at, worktree_cleanup_due_at, worktree_cleanup_completed_at, worktree_cleanup_last_error FROM tasks WHERE id = ?1",
                [task_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .expect("cleanup state should load")
    }

    fn set_cleanup_due_at(connection: &Connection, task_id: &str, due_at: &str) {
        connection
            .execute(
                "UPDATE tasks SET worktree_cleanup_due_at = ?2, worktree_cleanup_completed_at = NULL, worktree_cleanup_last_error = NULL WHERE id = ?1",
                params![task_id, due_at],
            )
            .expect("cleanup due_at should update");
    }

    fn add_task_assignment_with_runtime(
        connection: &Connection,
        task_id: &str,
        assignment_id: &str,
        runtime_cwd: &Path,
        status: &str,
        role_instance_id: Option<&str>,
    ) {
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, 'workflow-test', 'lane-test', 'role', 'developer', ?3, 'session-test', ?4, NULL, ?5, 'Prompt', 0, NULL, ?6, NULL, ?6, ?6)",
                params![assignment_id, task_id, status, runtime_cwd.display().to_string(), role_instance_id, now],
            )
            .expect("assignment should insert");
    }

    fn add_role_instance(connection: &Connection, instance_id: &str, worktree_path: &Path) {
        let now = Utc::now().to_rfc3339();
        connection
            .execute(
                "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, compaction_window, direct_permissions, archived, created_at, updated_at) VALUES ('role-test', 'developer', 'Developer', NULL, NULL, NULL, NULL, 'medium', 1, NULL, '[]', 0, ?1, ?1)",
                [now.as_str()],
            )
            .ok();
        connection
            .execute(
                "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES (?1, 'role-test', 'Developer 1', 'completed', NULL, 'session-role', ?2, NULL, NULL, ?3, ?3)",
                params![instance_id, worktree_path.display().to_string(), now],
            )
            .expect("role instance should insert");
    }

    fn add_git_worktree(repository_root: &Path, destination: &Path) {
        if let Some(parent) = destination.parent() {
            fs::create_dir_all(parent).expect("worktree parent should create");
        }
        assert!(Command::new("git")
            .arg("-C")
            .arg(repository_root)
            .args([
                "worktree",
                "add",
                "--detach",
                destination.to_str().unwrap(),
                "HEAD"
            ])
            .status()
            .expect("git worktree add should run")
            .success());
    }

    #[test]
    fn completed_tasks_are_retained_until_due_time() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-retained");
        insert_repository(&connection, "repo-cleanup-retained", &repository_root);
        let task = create_completed_task(&mut connection, "repo-cleanup-retained");

        let workspace_root = unique_temp_dir("task-worktree-cleanup-retained-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let repo_worktree = workspace_root.join("repos").join("repo-cleanup-retained");
        add_git_worktree(&repository_root, &repo_worktree);
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-retained",
            &workspace_root,
            "completed",
            None,
        );

        let (_, due_at, cleaned_at, _) = task_cleanup_state(&connection, &task.id);
        assert!(due_at.is_some());
        assert!(cleaned_at.is_none());

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 0);
        assert!(repo_worktree.exists());
    }

    #[test]
    fn cleanup_runs_after_due_time_and_clears_role_instance_paths() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-due");
        insert_repository(&connection, "repo-cleanup-due", &repository_root);
        let task = create_completed_task(&mut connection, "repo-cleanup-due");

        let workspace_root = unique_temp_dir("task-worktree-cleanup-due-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let repo_worktree = workspace_root.join("repos").join("repo-cleanup-due");
        add_git_worktree(&repository_root, &repo_worktree);
        add_role_instance(&connection, "instance-cleanup-due", &workspace_root);
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-due",
            &workspace_root,
            "completed",
            Some("instance-cleanup-due"),
        );
        set_cleanup_due_at(&connection, &task.id, "2000-01-01T00:00:00+00:00");

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 1);
        assert!(!workspace_root.exists());
        assert!(git_worktrees::list_worktree_paths(&repository_root)
            .expect("worktree list should load")
            .iter()
            .all(|path| !path.starts_with(&workspace_root)));

        let (_, due_at, cleaned_at, last_error) = task_cleanup_state(&connection, &task.id);
        assert!(due_at.is_none());
        assert!(cleaned_at.is_some());
        assert!(last_error.is_none());

        let role_instance_path: Option<String> = connection
            .query_row(
                "SELECT worktree_path FROM role_instances WHERE id = 'instance-cleanup-due'",
                [],
                |row| row.get(0),
            )
            .expect("role instance path should load");
        assert!(role_instance_path.is_none());
    }

    #[test]
    fn cleanup_removes_multiple_workspace_roots_for_one_task() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-multi-root");
        insert_repository(&connection, "repo-cleanup-multi-root", &repository_root);
        let task = create_completed_task(&mut connection, "repo-cleanup-multi-root");

        let shared_workspace_root = unique_temp_dir("task-worktree-cleanup-shared-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let role_workspace_root = unique_temp_dir("task-worktree-cleanup-role-root")
            .join("role-runtimes")
            .join("instance-a")
            .join("tasks")
            .join(&task.id);
        add_git_worktree(
            &repository_root,
            &shared_workspace_root
                .join("repos")
                .join("repo-cleanup-multi-root"),
        );
        add_git_worktree(
            &repository_root,
            &role_workspace_root
                .join("repos")
                .join("repo-cleanup-multi-root"),
        );
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-shared-root",
            &shared_workspace_root,
            "completed",
            None,
        );
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-role-root",
            &role_workspace_root,
            "completed",
            None,
        );
        set_cleanup_due_at(&connection, &task.id, "2000-01-01T00:00:00+00:00");

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 1);
        assert!(!shared_workspace_root.exists());
        assert!(!role_workspace_root.exists());
    }

    #[test]
    fn non_completed_tasks_are_not_cleaned() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-open");
        insert_repository(&connection, "repo-cleanup-open", &repository_root);
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Still open".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "in_progress".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-cleanup-open".into()),
                repository_ids: vec!["repo-cleanup-open".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let workspace_root = unique_temp_dir("task-worktree-cleanup-open-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let repo_worktree = workspace_root.join("repos").join("repo-cleanup-open");
        add_git_worktree(&repository_root, &repo_worktree);
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-open",
            &workspace_root,
            "completed",
            None,
        );
        set_cleanup_due_at(&connection, &task.id, "2000-01-01T00:00:00+00:00");
        connection
            .execute(
                "UPDATE tasks SET status = 'in_progress' WHERE id = ?1",
                [task.id.as_str()],
            )
            .expect("task status should update");

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 0);
        assert!(repo_worktree.exists());
    }

    #[test]
    fn reopened_tasks_clear_cleanup_state_and_preserve_worktrees() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-reopen");
        insert_repository(&connection, "repo-cleanup-reopen", &repository_root);
        let task = create_completed_task(&mut connection, "repo-cleanup-reopen");

        let workspace_root = unique_temp_dir("task-worktree-cleanup-reopen-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let repo_worktree = workspace_root.join("repos").join("repo-cleanup-reopen");
        add_git_worktree(&repository_root, &repo_worktree);
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-reopen",
            &workspace_root,
            "completed",
            None,
        );

        tasks::update_task(
            &mut connection,
            &task.id,
            TaskUpsertInput {
                title: task.title.clone(),
                description: task.description.clone(),
                task_type: task.task_type.clone(),
                tags: task.tags.clone(),
                status: "ready".into(),
                priority: task.priority.clone(),
                workflow_id: task.workflow_id.clone(),
                current_lane_id: task.current_lane_id.clone(),
                assignee_type: task.assignee_type.clone(),
                assignee_id: task.assignee_id.clone(),
                repository_id: task.repository_id.clone(),
                repository_ids: task.repository_ids.clone(),
                parent_task_id: task.parent_task_id.clone(),
                whip_max_attempts: Some(task.whip_max_attempts),
                archived: Some(task.archived),
            },
        )
        .expect("task should reopen");

        let (completed_at, due_at, cleaned_at, last_error) =
            task_cleanup_state(&connection, &task.id);
        assert!(completed_at.is_none());
        assert!(due_at.is_none());
        assert!(cleaned_at.is_none());
        assert!(last_error.is_none());

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 0);
        assert!(repo_worktree.exists());
    }

    #[test]
    fn missing_workspace_paths_are_treated_as_idempotent_success() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-missing");
        insert_repository(&connection, "repo-cleanup-missing", &repository_root);
        let task = create_completed_task(&mut connection, "repo-cleanup-missing");

        let workspace_root = unique_temp_dir("task-worktree-cleanup-missing-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let repo_worktree = workspace_root.join("repos").join("repo-cleanup-missing");
        add_git_worktree(&repository_root, &repo_worktree);
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-missing",
            &workspace_root,
            "completed",
            None,
        );
        fs::remove_dir_all(&workspace_root).expect("workspace root should delete");
        set_cleanup_due_at(&connection, &task.id, "2000-01-01T00:00:00+00:00");

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 1);
        assert!(git_worktrees::list_worktree_paths(&repository_root)
            .expect("worktree list should load")
            .iter()
            .all(|path| !path.starts_with(&workspace_root)));

        let (_, due_at, cleaned_at, last_error) = task_cleanup_state(&connection, &task.id);
        assert!(due_at.is_none());
        assert!(cleaned_at.is_some());
        assert!(last_error.is_none());
    }

    #[test]
    fn cleanup_failures_record_errors_and_retry_later() {
        let mut connection = in_memory_connection();
        ensure_default_project(&connection);
        let repository_root = init_test_repo("task-worktree-cleanup-failure");
        insert_repository(&connection, "repo-cleanup-failure", &repository_root);
        let task = create_completed_task(&mut connection, "repo-cleanup-failure");

        let workspace_root = unique_temp_dir("task-worktree-cleanup-failure-root")
            .join("task-workspaces")
            .join("tasks")
            .join(&task.id);
        let repo_worktree = workspace_root.join("repos").join("repo-cleanup-failure");
        add_git_worktree(&repository_root, &repo_worktree);
        add_task_assignment_with_runtime(
            &connection,
            &task.id,
            "assignment-cleanup-failure",
            &workspace_root,
            "completed",
            None,
        );
        set_cleanup_due_at(&connection, &task.id, "2000-01-01T00:00:00+00:00");
        connection
            .execute(
                "UPDATE repositories SET local_path = '/definitely/missing/repository' WHERE id = 'repo-cleanup-failure'",
                [],
            )
            .expect("repository path should break");

        let actions = process_due_task_worktree_cleanups(&connection, &Utc::now().to_rfc3339())
            .expect("cleanup processing should succeed");
        assert_eq!(actions, 1);
        assert!(repo_worktree.exists());

        let (_, due_at, cleaned_at, last_error) = task_cleanup_state(&connection, &task.id);
        assert!(due_at.is_some());
        assert!(cleaned_at.is_none());
        assert!(last_error.is_some());

        connection
            .execute(
                "UPDATE repositories SET local_path = ?1 WHERE id = 'repo-cleanup-failure'",
                [repository_root.display().to_string()],
            )
            .expect("repository path should restore");

        let retry_actions =
            process_due_task_worktree_cleanups(&connection, "2100-01-01T00:00:00+00:00")
                .expect("cleanup retry should succeed");
        assert_eq!(retry_actions, 1);
        assert!(!workspace_root.exists());
        let (_, due_at, cleaned_at, last_error) = task_cleanup_state(&connection, &task.id);
        assert!(due_at.is_none());
        assert!(cleaned_at.is_some());
        assert!(last_error.is_none());
    }
}
