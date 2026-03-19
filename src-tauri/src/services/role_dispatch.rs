use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::{RoleInstance, RoleOperationsDetail},
    services::{git_worktrees, pi_sessions, role_runtime, roles},
};

pub fn dispatch_role_queue(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    role_id: &str,
) -> Result<RoleOperationsDetail, String> {
    let role = roles::get_role(connection, role_id)?;
    if role.archived {
        return Err(format!(
            "Role {role_id} is archived and cannot dispatch runtime work"
        ));
    }

    loop {
        let next_queue_entry_id = next_queued_entry_id(connection, role_id)?;
        let Some(queue_entry_id) = next_queue_entry_id else {
            break;
        };

        let active_count = active_instance_count(connection, role_id)?;
        if active_count >= role.capacity {
            break;
        }

        let queue_entry = role_runtime::get_role_queue_entry(connection, &queue_entry_id)?;
        let instance = if let Some(existing) = find_reusable_instance(connection, role_id)? {
            existing
        } else {
            role_runtime::create_role_instance(
                connection,
                crate::models::RoleInstanceInput {
                    role_id: role.id.clone(),
                    display_name: None,
                    status: Some("idle".into()),
                    current_queue_entry_id: None,
                    session_id: None,
                    worktree_path: None,
                    last_heartbeat_at: None,
                    last_error: None,
                },
            )?
        };

        let worktree_path =
            ensure_instance_worktree(connection, project_root, &role.slug, &instance)?;
        let session_id = ensure_instance_session(
            connection,
            project_root,
            session_dir,
            &role,
            &queue_entry.title,
            &instance,
        )?;

        assign_queue_entry_to_instance(
            connection,
            &queue_entry.id,
            &instance.id,
            &session_id,
            worktree_path.to_string_lossy().as_ref(),
        )?;
    }

    role_runtime::get_role_operations(connection, role_id)
}

pub fn release_role_instance(
    connection: &mut Connection,
    project_root: &Path,
    session_dir: &Path,
    instance_id: &str,
    outcome: &str,
    error_message: Option<String>,
) -> Result<RoleOperationsDetail, String> {
    let instance = role_runtime::get_role_instance(connection, instance_id)?;
    let now = crate::state::now_iso();
    let normalized_outcome = normalize_release_outcome(outcome)?;
    let normalized_error = normalize_optional(error_message);

    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role release transaction: {error}"))?;

    if let Some(queue_entry_id) = instance.current_queue_entry_id.as_deref() {
        tx.execute(
            "UPDATE role_queue_entries SET status = ?2, completed_at = ?3, updated_at = ?3 WHERE id = ?1",
            params![
                queue_entry_id,
                match normalized_outcome.as_str() {
                    "canceled" => "canceled",
                    _ => "completed",
                },
                now,
            ],
        )
        .map_err(|error| format!("Unable to release role queue entry {queue_entry_id}: {error}"))?;
    }

    tx.execute(
        "UPDATE role_instances SET status = ?2, current_queue_entry_id = NULL, last_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            instance.id,
            match normalized_outcome.as_str() {
                "failure" => "failed",
                _ => "idle",
            },
            if normalized_outcome == "failure" {
                normalized_error.clone()
            } else {
                None
            },
            now,
        ],
    )
    .map_err(|error| format!("Unable to release role instance {}: {error}", instance.id))?;

    tx.commit()
        .map_err(|error| format!("Unable to commit role release transaction: {error}"))?;

    if normalized_outcome != "failure" {
        let _ = dispatch_role_queue(connection, project_root, session_dir, &instance.role_id)?;
    }

    role_runtime::get_role_operations(connection, &instance.role_id)
}

pub fn dispose_role_instance(
    connection: &mut Connection,
    project_root: &Path,
    instance_id: &str,
) -> Result<RoleOperationsDetail, String> {
    let instance = role_runtime::get_role_instance(connection, instance_id)?;
    if instance.current_queue_entry_id.is_some() {
        return Err(format!(
            "Role instance {} is still assigned and cannot be disposed",
            instance.id
        ));
    }

    if let Some(worktree_path) = instance.worktree_path.as_deref() {
        git_worktrees::dispose_worktree(project_root, Path::new(worktree_path))?;
    }

    let now = crate::state::now_iso();
    connection
        .execute(
            "UPDATE role_instances SET status = 'completed', updated_at = ?2 WHERE id = ?1",
            params![instance.id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to mark role instance {} disposed: {error}",
                instance.id
            )
        })?;

    role_runtime::get_role_operations(connection, &instance.role_id)
}

fn next_queued_entry_id(connection: &Connection, role_id: &str) -> Result<Option<String>, String> {
    connection
        .query_row(
            r#"
            SELECT id
            FROM role_queue_entries
            WHERE role_id = ?1 AND status = 'queued'
            ORDER BY created_at ASC, id ASC
            LIMIT 1
            "#,
            [role_id],
            |row| row.get(0),
        )
        .optional()
        .map_err(|error| format!("Unable to query next queued entry for role {role_id}: {error}"))
}

fn active_instance_count(connection: &Connection, role_id: &str) -> Result<i64, String> {
    connection
        .query_row(
            "SELECT COUNT(*) FROM role_instances WHERE role_id = ?1 AND status IN ('running', 'waiting')",
            [role_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to count active role instances for {role_id}: {error}"))
}

fn find_reusable_instance(
    connection: &Connection,
    role_id: &str,
) -> Result<Option<RoleInstance>, String> {
    let instances = role_runtime::list_role_instances(connection, Some(role_id))?;
    Ok(instances
        .into_iter()
        .find(|instance| instance.status == "idle"))
}

fn ensure_instance_worktree(
    connection: &Connection,
    project_root: &Path,
    role_slug: &str,
    instance: &RoleInstance,
) -> Result<std::path::PathBuf, String> {
    let existing = instance
        .worktree_path
        .as_deref()
        .filter(|path| Path::new(path).exists())
        .map(Path::new)
        .map(Path::to_path_buf);

    let path = if let Some(path) = existing {
        path
    } else {
        let created = git_worktrees::ensure_role_worktree(project_root, role_slug, &instance.id)?;
        connection
            .execute(
                "UPDATE role_instances SET worktree_path = ?2, updated_at = ?3 WHERE id = ?1",
                params![
                    instance.id,
                    created.to_string_lossy(),
                    crate::state::now_iso()
                ],
            )
            .map_err(|error| {
                format!(
                    "Unable to update worktree path for role instance {}: {error}",
                    instance.id
                )
            })?;
        created
    };

    Ok(path)
}

fn ensure_instance_session(
    connection: &Connection,
    project_root: &Path,
    session_dir: &Path,
    role: &crate::models::RoleDefinition,
    queue_title: &str,
    instance: &RoleInstance,
) -> Result<String, String> {
    if let Some(session_id) = instance.session_id.as_deref() {
        if pi_sessions::get_session(session_dir, session_id, false).is_ok() {
            apply_role_session_defaults(project_root, session_dir, session_id, role)?;
            return Ok(session_id.to_string());
        }
    }

    let created = pi_sessions::create_session_file(
        project_root,
        session_dir,
        Some(&format!("{} · {}", role.name, queue_title)),
        false,
    )?;

    connection
        .execute(
            "UPDATE role_instances SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![instance.id, created.record.id, crate::state::now_iso()],
        )
        .map_err(|error| {
            format!(
                "Unable to update session id for role instance {}: {error}",
                instance.id
            )
        })?;

    apply_role_session_defaults(project_root, session_dir, &created.record.id, role)?;

    Ok(created.record.id)
}

fn apply_role_session_defaults(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    role: &crate::models::RoleDefinition,
) -> Result<(), String> {
    if let (Some(provider), Some(model)) = (role.provider.as_deref(), role.model.as_deref()) {
        let _ =
            pi_sessions::set_session_model(project_root, session_dir, session_id, provider, model)?;
    }

    let _ = pi_sessions::set_session_thinking_level(
        project_root,
        session_dir,
        session_id,
        &role.thinking_level,
    )?;

    Ok(())
}

fn assign_queue_entry_to_instance(
    connection: &Connection,
    queue_entry_id: &str,
    instance_id: &str,
    session_id: &str,
    worktree_path: &str,
) -> Result<(), String> {
    let now = crate::state::now_iso();

    connection
        .execute(
            r#"
            UPDATE role_queue_entries
            SET status = 'assigned',
                assigned_instance_id = ?2,
                started_at = COALESCE(started_at, ?3),
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![queue_entry_id, instance_id, now],
        )
        .map_err(|error| format!("Unable to assign role queue entry {queue_entry_id}: {error}"))?;

    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = 'running',
                current_queue_entry_id = ?2,
                session_id = ?3,
                worktree_path = ?4,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![instance_id, queue_entry_id, session_id, worktree_path, now],
        )
        .map_err(|error| format!("Unable to assign role instance {instance_id}: {error}"))?;

    Ok(())
}

fn normalize_release_outcome(outcome: &str) -> Result<String, String> {
    let normalized = outcome.trim().to_lowercase();
    if !matches!(normalized.as_str(), "success" | "failure" | "canceled") {
        return Err("Role release outcome must be one of: success, failure, canceled.".into());
    }

    Ok(normalized)
}

fn normalize_optional(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        models::RoleQueueEntryInput,
        services::{database::initialize_database_at, roles},
    };
    use std::{
        env,
        fs::{self, File},
        io::Write,
        path::PathBuf,
        process::Command,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_dir(label: &str) -> PathBuf {
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

    fn unique_temp_db(label: &str) -> PathBuf {
        unique_temp_dir(label).join("orchestra.db")
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
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

    fn create_role(
        connection: &mut Connection,
        name: &str,
        capacity: i64,
    ) -> crate::models::RoleDefinition {
        roles::create_role(
            connection,
            crate::models::RoleUpsertInput {
                name: name.into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                thinking_level: Some("off".into()),
                capacity,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create")
    }

    #[test]
    fn dispatches_queued_work_into_running_instances() {
        let mut connection = open_test_connection("role-dispatch");
        let role = create_role(&mut connection, "Planner", 1);
        let project_root = init_test_repo("role-dispatch-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        role_runtime::enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Plan runtime slice".into(),
                summary: None,
                entry_prompt: Some("Plan the next step".into()),
            },
        )
        .expect("queue work should succeed");

        let detail = dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
            .expect("dispatch should succeed");

        assert_eq!(detail.assigned_count, 1);
        assert_eq!(detail.active_instance_count, 1);
        assert_eq!(detail.instances.len(), 1);
        assert_eq!(detail.instances[0].status, "running");
        assert!(detail.instances[0].session_id.is_some());
        assert!(detail.instances[0].worktree_path.is_some());
    }

    #[test]
    fn releases_and_disposes_role_instances() {
        let mut connection = open_test_connection("role-dispatch-release");
        let role = create_role(&mut connection, "Reviewer", 1);
        let project_root = init_test_repo("role-dispatch-release-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        role_runtime::enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Review runtime slice".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect("queue work should succeed");

        let dispatched =
            dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
                .expect("dispatch should succeed");
        let instance = dispatched.instances.first().expect("instance should exist");
        let worktree_path = instance
            .worktree_path
            .clone()
            .expect("worktree should exist");

        let released = release_role_instance(
            &mut connection,
            &project_root,
            &session_dir,
            &instance.id,
            "success",
            None,
        )
        .expect("release should succeed");
        assert_eq!(released.assigned_count, 0);
        assert_eq!(released.instances[0].status, "idle");

        let disposed = dispose_role_instance(&mut connection, &project_root, &instance.id)
            .expect("dispose should succeed");
        assert_eq!(disposed.instances[0].status, "completed");
        assert!(!Path::new(&worktree_path).exists());
    }
}
