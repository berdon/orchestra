use std::path::Path;

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::{RoleInstance, RoleOperationsDetail},
    services::{
        git_worktrees, pi_sessions, projects, role_runtime, roles, session_ownership,
        session_records, task_repositories, task_runtime, tasks, workflows,
    },
};

pub fn dispatch_role_queue(
    connection: &mut Connection,
    _project_root: &Path,
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
        if !role_runtime::queue_entry_is_valid(connection, &queue_entry)? {
            connection
                .execute(
                    r#"
                    UPDATE role_queue_entries
                    SET status = 'canceled',
                        assigned_instance_id = NULL,
                        completed_at = ?2,
                        updated_at = ?2
                    WHERE id = ?1 AND status = 'queued'
                    "#,
                    params![queue_entry.id, crate::state::now_iso()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to cancel invalid role queue entry {}: {error}",
                        queue_entry.id
                    )
                })?;
            continue;
        }
        let instance = role_runtime::create_role_instance(
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
        )?;

        if !claim_queue_entry_for_instance(connection, &queue_entry.id, &instance.id)? {
            continue;
        }

        let setup_result = (|| -> Result<(), String> {
            let (entry_project_root, entry_session_dir) =
                resolve_queue_entry_context(connection, _project_root, session_dir, &queue_entry)?;
            let runtime_cwd = resolve_instance_runtime_cwd(
                connection,
                &entry_project_root,
                &entry_session_dir,
                &role.slug,
                &instance,
                &queue_entry,
            )?;
            let session_id = ensure_instance_session(
                connection,
                &runtime_cwd,
                &entry_session_dir,
                &role,
                &queue_entry,
                &instance,
            )?;

            finalize_queue_entry_assignment(
                connection,
                &instance.id,
                &session_id,
                runtime_cwd.to_string_lossy().as_ref(),
            )
        })();

        if let Err(error) = setup_result {
            let _ = release_claimed_queue_entry(connection, &queue_entry.id, &instance.id);
            return Err(error);
        }
    }

    role_runtime::get_role_operations(connection, role_id)
}

pub fn complete_role_run(session_id: &str) -> Result<(), String> {
    let mut connection = crate::services::database::open_connection()?;
    complete_role_run_with_connection(&mut connection, session_id)
}

fn complete_role_run_with_connection(
    connection: &mut Connection,
    session_id: &str,
) -> Result<(), String> {
    let Some(instance_id) =
        session_ownership::load_session_authorization_actor(connection, session_id)?
            .filter(|authorization| authorization.actor_type == "role_instance")
            .map(|authorization| authorization.actor_id)
    else {
        return Ok(());
    };

    if session_ownership::load_session_open_assignment(connection, session_id)?.is_some() {
        return Ok(());
    }

    let instance = role_runtime::get_role_instance(connection, &instance_id)?;
    let now = crate::state::now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role completion transaction: {error}"))?;
    if let Some(queue_entry_id) = instance.current_queue_entry_id.as_deref() {
        tx.execute(
            "UPDATE role_queue_entries SET status = 'completed', completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![queue_entry_id, now],
        )
        .map_err(|error| format!("Unable to complete role queue entry {queue_entry_id}: {error}"))?;
    }

    tx.execute(
        "UPDATE role_instances SET status = 'idle', current_queue_entry_id = NULL, updated_at = ?2 WHERE id = ?1",
        params![instance.id, now],
    )
    .map_err(|error| format!("Unable to mark role instance {} idle: {error}", instance.id))?;
    tx.commit()
        .map_err(|error| format!("Unable to commit role completion transaction: {error}"))?;
    Ok(())
}

pub fn fail_role_run(session_id: &str, error_message: &str) -> Result<(), String> {
    let mut connection = crate::services::database::open_connection()?;
    fail_role_run_with_connection(&mut connection, session_id, error_message)
}

fn fail_role_run_with_connection(
    connection: &mut Connection,
    session_id: &str,
    error_message: &str,
) -> Result<(), String> {
    let Some(instance_id) =
        session_ownership::load_session_authorization_actor(connection, session_id)?
            .filter(|authorization| authorization.actor_type == "role_instance")
            .map(|authorization| authorization.actor_id)
    else {
        return Ok(());
    };

    if session_ownership::load_session_open_assignment(connection, session_id)?.is_some() {
        return Ok(());
    }

    let instance = role_runtime::get_role_instance(connection, &instance_id)?;
    let now = crate::state::now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start role failure transaction: {error}"))?;
    if let Some(queue_entry_id) = instance.current_queue_entry_id.as_deref() {
        tx.execute(
            "UPDATE role_queue_entries SET status = 'completed', completed_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![queue_entry_id, now],
        )
        .map_err(|error| format!("Unable to finish failed role queue entry {queue_entry_id}: {error}"))?;
    }

    tx.execute(
        "UPDATE role_instances SET status = 'failed', current_queue_entry_id = NULL, last_error = ?2, updated_at = ?3 WHERE id = ?1",
        params![instance.id, error_message, now],
    )
    .map_err(|error| format!("Unable to mark role instance {} failed: {error}", instance.id))?;
    tx.commit()
        .map_err(|error| format!("Unable to commit role failure transaction: {error}"))?;
    Ok(())
}

pub fn mark_role_instance_running(
    connection: &Connection,
    instance_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE role_instances SET status = 'running', updated_at = ?2 WHERE id = ?1",
            params![instance_id, crate::state::now_iso()],
        )
        .map_err(|error| format!("Unable to mark role instance {instance_id} running: {error}"))?;
    Ok(())
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
        "UPDATE role_instances SET status = ?2, current_queue_entry_id = NULL, session_id = NULL, last_error = ?3, updated_at = ?4 WHERE id = ?1",
        params![
            instance.id,
            match normalized_outcome.as_str() {
                "failure" => "failed",
                "canceled" => "canceled",
                _ => "completed",
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

    if let Some(session_id) = instance.session_id.as_deref() {
        let _ =
            session_records::close_active_assignment_session(connection, session_id, None, false);
    }

    let _ = dispatch_role_queue(connection, project_root, session_dir, &instance.role_id)?;

    role_runtime::get_role_operations(connection, &instance.role_id)
}

fn deduplicate_open_role_lane_queue_state(
    connection: &Connection,
    role_id: &str,
    reason: &str,
) -> Result<(), String> {
    let now = crate::state::now_iso();
    let mut queue_entries_by_lane =
        std::collections::BTreeMap::<(String, String), Vec<crate::models::RoleQueueEntry>>::new();

    for queue_entry in role_runtime::list_role_queue_entries(connection, Some(role_id))? {
        if queue_entry.source_type != "workflow_lane"
            || !matches!(queue_entry.status.as_str(), "queued" | "assigned")
        {
            continue;
        }
        let (Some(task_id), Some(lane_id)) = (
            queue_entry.source_task_id.as_deref(),
            queue_entry.source_lane_id.as_deref(),
        ) else {
            continue;
        };
        queue_entries_by_lane
            .entry((task_id.to_string(), lane_id.to_string()))
            .or_default()
            .push(queue_entry);
    }

    let mut assignments = task_runtime::list_current_role_assignments(connection, role_id)?;
    assignments.sort_by(|left, right| {
        left.created_at
            .cmp(&right.created_at)
            .then_with(|| left.id.cmp(&right.id))
    });

    let mut keep_assignment_by_lane = std::collections::BTreeMap::new();
    let mut keep_queue_entry_by_lane = std::collections::BTreeMap::new();
    for assignment in assignments {
        let key = (assignment.task_id.clone(), assignment.lane_id.clone());
        if let Some(keep_assignment_id) = keep_assignment_by_lane.get(&key) {
            connection
                .execute(
                    r#"
                    UPDATE task_lane_assignments
                    SET status = 'canceled',
                        session_id = NULL,
                        runtime_cwd = NULL,
                        role_instance_id = NULL,
                        pending_outcome = NULL,
                        completion_notes = ?2,
                        completed_at = ?3,
                        updated_at = ?3
                    WHERE id = ?1 AND status IN ('queued', 'active', 'awaiting_user_approval', 'awaiting_user_intervention')
                    "#,
                    params![assignment.id, reason, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to cancel duplicate task assignment {} during role reset cleanup (keeping {}): {error}",
                        assignment.id, keep_assignment_id
                    )
                })?;
            continue;
        }

        keep_assignment_by_lane.insert(key.clone(), assignment.id.clone());
        let canonical_queue_entry_id = assignment
            .role_queue_entry_id
            .clone()
            .filter(|queue_entry_id| {
                queue_entries_by_lane
                    .get(&key)
                    .map(|entries| entries.iter().any(|entry| entry.id == *queue_entry_id))
                    .unwrap_or(false)
            })
            .or_else(|| {
                queue_entries_by_lane
                    .get(&key)
                    .and_then(|entries| entries.first().map(|entry| entry.id.clone()))
            });

        if let Some(queue_entry_id) = canonical_queue_entry_id {
            keep_queue_entry_by_lane.insert(key.clone(), queue_entry_id.clone());
            if assignment.role_queue_entry_id.as_deref() != Some(queue_entry_id.as_str()) {
                connection
                    .execute(
                        "UPDATE task_lane_assignments SET role_queue_entry_id = ?2, updated_at = ?3 WHERE id = ?1",
                        params![assignment.id, queue_entry_id, now],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to repoint task assignment {} to canonical role queue entry {} during reset cleanup: {error}",
                            assignment.id, queue_entry_id
                        )
                    })?;
            }
        }
    }

    for (key, queue_entries) in queue_entries_by_lane {
        let keep_queue_entry_id = keep_queue_entry_by_lane
            .get(&key)
            .cloned()
            .unwrap_or_else(|| queue_entries[0].id.clone());
        for queue_entry in queue_entries {
            if queue_entry.id == keep_queue_entry_id {
                continue;
            }
            connection
                .execute(
                    r#"
                    UPDATE role_queue_entries
                    SET status = 'canceled',
                        assigned_instance_id = NULL,
                        started_at = NULL,
                        completed_at = ?2,
                        updated_at = ?2
                    WHERE id = ?1 AND status IN ('queued', 'assigned')
                    "#,
                    params![queue_entry.id, now],
                )
                .map_err(|error| {
                    format!(
                        "Unable to cancel duplicate role queue entry {} during reset cleanup: {error}",
                        queue_entry.id
                    )
                })?;
        }
    }

    Ok(())
}

fn session_dir_for_task_id(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<std::path::PathBuf>, String> {
    let Ok(task) = tasks::get_task_context(connection, task_id) else {
        return Ok(None);
    };
    let project = projects::get_project(connection, &task.project_id)?;
    let orchestra_root = crate::services::orchestra_paths::default_orchestra_root()?;
    Ok(Some(crate::services::orchestra_paths::project_session_dir(
        &orchestra_root,
        &project.slug,
    )))
}

fn collect_role_reset_session_contexts(
    connection: &Connection,
    role_id: &str,
    assignments: &[crate::models::TaskLaneAssignment],
) -> Result<Vec<(String, std::path::PathBuf)>, String> {
    let mut session_contexts = std::collections::BTreeMap::new();

    for assignment in assignments {
        let assignment_session_dir = session_dir_for_task_id(connection, &assignment.task_id)?;
        if let (Some(session_id), Some(session_dir)) = (
            assignment.session_id.as_deref(),
            assignment_session_dir.as_ref(),
        ) {
            session_contexts.insert(session_id.to_string(), session_dir.clone());
        }

        if let Some(role_instance_id) = assignment.role_instance_id.as_deref() {
            if let Some(session_id) = connection
                .query_row(
                    "SELECT session_id FROM role_instances WHERE id = ?1",
                    [role_instance_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to query role instance {} during reset: {error}",
                        role_instance_id
                    )
                })?
                .flatten()
            {
                if let Some(session_dir) = assignment_session_dir.as_ref() {
                    session_contexts.insert(session_id, session_dir.clone());
                }
            }
        }

        if let Some(queue_entry_id) = assignment.role_queue_entry_id.as_deref() {
            if let Some(assigned_instance_id) = connection
                .query_row(
                    "SELECT assigned_instance_id FROM role_queue_entries WHERE id = ?1",
                    [queue_entry_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to query role queue entry {} during reset: {error}",
                        queue_entry_id
                    )
                })?
                .flatten()
            {
                if let Some(session_id) = connection
                    .query_row(
                        "SELECT session_id FROM role_instances WHERE id = ?1",
                        [assigned_instance_id.as_str()],
                        |row| row.get::<_, Option<String>>(0),
                    )
                    .optional()
                    .map_err(|error| {
                        format!(
                            "Unable to query queued role instance {} during reset: {error}",
                            assigned_instance_id
                        )
                    })?
                    .flatten()
                {
                    if let Some(session_dir) = assignment_session_dir.as_ref() {
                        session_contexts.insert(session_id, session_dir.clone());
                    }
                }
            }
        }
    }

    let mut statement = connection
        .prepare(
            "SELECT session_id, current_queue_entry_id FROM role_instances WHERE role_id = ?1 AND session_id IS NOT NULL",
        )
        .map_err(|error| {
            format!(
                "Unable to prepare role session query for {}: {error}",
                role_id
            )
        })?;
    let rows = statement
        .query_map([role_id], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?))
        })
        .map_err(|error| format!("Unable to query role sessions for {}: {error}", role_id))?;
    for row in rows {
        let (session_id, current_queue_entry_id) =
            row.map_err(|error| format!("Unable to read role session for {}: {error}", role_id))?;
        if session_contexts.contains_key(&session_id) {
            continue;
        }

        let session_dir = if let Some(queue_entry_id) = current_queue_entry_id.as_deref() {
            let source_task_id = connection
                .query_row(
                    "SELECT source_task_id FROM role_queue_entries WHERE id = ?1",
                    [queue_entry_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to query role queue entry {} for session context lookup: {error}",
                        queue_entry_id
                    )
                })?
                .flatten();
            if let Some(task_id) = source_task_id.as_deref() {
                session_dir_for_task_id(connection, task_id)?
            } else {
                None
            }
        } else {
            None
        };

        if let Some(session_dir) = session_dir {
            session_contexts.insert(session_id, session_dir);
        } else if let Ok(context) =
            crate::services::pi_sessions::find_session_context_for_session(&session_id)
        {
            session_contexts.insert(session_id, context.session_dir);
        }
    }

    Ok(session_contexts.into_iter().collect())
}

pub fn reset_role_assignments(
    connection: &mut Connection,
    role_id: &str,
) -> Result<
    (
        RoleOperationsDetail,
        Vec<String>,
        Vec<(String, std::path::PathBuf)>,
    ),
    String,
> {
    let existing_assignments = task_runtime::list_current_role_assignments(connection, role_id)?;
    let session_contexts =
        collect_role_reset_session_contexts(connection, role_id, &existing_assignments)?;
    let assignments = task_runtime::reset_role_assignments_to_queue(
        connection,
        role_id,
        "Role assignments reset by operator",
    )?;

    let now = crate::state::now_iso();
    connection
        .execute(
            r#"
            UPDATE role_queue_entries
            SET status = 'queued',
                assigned_instance_id = NULL,
                started_at = NULL,
                completed_at = NULL,
                updated_at = ?2
            WHERE role_id = ?1 AND status = 'assigned'
            "#,
            params![role_id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to clear assigned role queue entries for {}: {error}",
                role_id
            )
        })?;

    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = CASE
                    WHEN status IN ('completed', 'failed', 'canceled') THEN status
                    ELSE 'canceled'
                END,
                current_queue_entry_id = NULL,
                session_id = NULL,
                worktree_path = NULL,
                last_error = CASE
                    WHEN status IN ('completed', 'failed', 'canceled') THEN last_error
                    ELSE 'Role assignments reset by operator'
                END,
                updated_at = ?2
            WHERE role_id = ?1
            "#,
            params![role_id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to clear role runtime state for {}: {error}",
                role_id
            )
        })?;
    deduplicate_open_role_lane_queue_state(
        connection,
        role_id,
        "Duplicate role lane assignment removed during role reset",
    )?;
    let detail = role_runtime::get_role_operations(connection, role_id)?;
    let task_ids = assignments
        .iter()
        .map(|assignment| assignment.task_id.clone())
        .collect();
    Ok((detail, task_ids, session_contexts))
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
        let shared_task_root = Path::new(&task_repositories::shared_task_workspaces_root(
            project_root,
        ))
        .to_path_buf();
        let should_dispose = !Path::new(worktree_path).starts_with(&shared_task_root);
        if should_dispose {
            git_worktrees::dispose_runtime_dir(Path::new(worktree_path))?;
        }
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

fn resolve_queue_entry_context(
    connection: &Connection,
    fallback_project_root: &Path,
    fallback_session_dir: &Path,
    queue_entry: &crate::models::RoleQueueEntry,
) -> Result<(std::path::PathBuf, std::path::PathBuf), String> {
    let Some(task_id) = queue_entry.source_task_id.as_deref() else {
        return Ok((
            fallback_project_root.to_path_buf(),
            fallback_session_dir.to_path_buf(),
        ));
    };

    let Ok(task) = tasks::get_task_context(connection, task_id) else {
        return Ok((
            fallback_project_root.to_path_buf(),
            fallback_session_dir.to_path_buf(),
        ));
    };
    let Ok(context) = pi_sessions::session_context_for_project_id(&task.project_id) else {
        return Ok((
            fallback_project_root.to_path_buf(),
            fallback_session_dir.to_path_buf(),
        ));
    };
    Ok((context.project_root, context.session_dir))
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
            "SELECT COUNT(*) FROM role_instances WHERE role_id = ?1 AND status = 'running'",
            [role_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to count active role instances for {role_id}: {error}"))
}

fn resolve_instance_runtime_cwd(
    connection: &Connection,
    project_root: &Path,
    session_dir: &Path,
    role_slug: &str,
    instance: &RoleInstance,
    queue_entry: &crate::models::RoleQueueEntry,
) -> Result<std::path::PathBuf, String> {
    let existing = instance
        .worktree_path
        .as_deref()
        .filter(|path| Path::new(path).exists())
        .map(Path::new)
        .map(Path::to_path_buf);

    if let Some(path) = existing {
        return Ok(path);
    }

    let path = if let Some(task_id) = queue_entry.source_task_id.as_deref() {
        let task = tasks::get_task_context(connection, task_id)?;
        let lane = queue_entry
            .source_workflow_id
            .as_deref()
            .zip(queue_entry.source_lane_id.as_deref())
            .and_then(|(workflow_id, lane_id)| {
                workflows::get_workflow(connection, workflow_id)
                    .ok()
                    .and_then(|workflow| workflow.lanes.into_iter().find(|lane| lane.id == lane_id))
            })
            .or_else(|| {
                task.current_lane_id.as_deref().and_then(|lane_id| {
                    task.workflow_id.as_deref().and_then(|workflow_id| {
                        workflows::get_workflow(connection, workflow_id)
                            .ok()
                            .and_then(|workflow| {
                                workflow.lanes.into_iter().find(|lane| lane.id == lane_id)
                            })
                    })
                })
            });

        let runtime_root = if lane
            .as_ref()
            .is_some_and(task_runtime::lane_uses_separate_worktree)
        {
            git_worktrees::ensure_role_runtime_dir(session_dir, role_slug, &instance.id)?
        } else if lane.is_some() {
            projects::get_project(connection, &task.project_id)
                .ok()
                .and_then(|project| {
                    crate::services::orchestra_paths::default_orchestra_root()
                        .ok()
                        .map(|root| {
                            crate::services::orchestra_paths::project_root(&root, &project.slug)
                        })
                })
                .map(|root| {
                    Path::new(&task_repositories::shared_task_workspaces_root(&root)).to_path_buf()
                })
                .unwrap_or_else(|| {
                    Path::new(&task_repositories::shared_task_workspaces_root(
                        project_root,
                    ))
                    .to_path_buf()
                })
        } else {
            git_worktrees::ensure_role_runtime_dir(session_dir, role_slug, &instance.id)?
        };
        Path::new(&task_repositories::task_workspace_root(
            runtime_root.to_string_lossy().as_ref(),
            &task.id,
        ))
        .to_path_buf()
    } else {
        git_worktrees::ensure_role_runtime_dir(session_dir, role_slug, &instance.id)?
    };

    std::fs::create_dir_all(&path).map_err(|error| {
        format!(
            "Unable to create role runtime cwd {}: {error}",
            path.display()
        )
    })?;

    if let Some(task_id) = queue_entry.source_task_id.as_deref() {
        if let Ok(task) = tasks::get_task_context(connection, task_id) {
            let _ = task_runtime::ensure_task_repository_workspaces(
                &task,
                path.to_string_lossy().as_ref(),
            );
        }
    }

    connection
        .execute(
            "UPDATE role_instances SET worktree_path = ?2, updated_at = ?3 WHERE id = ?1",
            params![instance.id, path.to_string_lossy(), crate::state::now_iso()],
        )
        .map_err(|error| {
            format!(
                "Unable to update worktree path for role instance {}: {error}",
                instance.id
            )
        })?;

    Ok(path)
}

fn ensure_instance_session(
    connection: &Connection,
    runtime_cwd: &Path,
    session_dir: &Path,
    role: &crate::models::RoleDefinition,
    queue_entry: &crate::models::RoleQueueEntry,
    instance: &RoleInstance,
) -> Result<String, String> {
    let runtime_cwd_string = runtime_cwd.display().to_string();
    let project_id = queue_entry
        .source_task_id
        .as_deref()
        .map(|task_id| tasks::get_task_context(connection, task_id).map(|task| task.project_id))
        .transpose()?;
    let created = session_records::create_session_record(
        connection,
        runtime_cwd,
        session_dir,
        session_records::CreateSessionRecordInput {
            project_id: project_id.as_deref(),
            title: Some(&format!("{} · {}", role.name, queue_entry.title)),
            session_kind: session_records::SESSION_KIND_ROLE_INSTANCE,
            agent_id: None,
            role_instance_id: Some(instance.id.as_str()),
            task_id: queue_entry.source_task_id.as_deref(),
            workflow_id: queue_entry.source_workflow_id.as_deref(),
            lane_id: queue_entry.source_lane_id.as_deref(),
            assignment: None,
            worker_type: Some("role"),
            worker_id: Some(role.id.as_str()),
            runtime_cwd: Some(runtime_cwd_string.as_str()),
            subscribed: false,
            agent_runtime: None,
            update_role_instance_session: true,
        },
    )?;

    apply_role_session_defaults(runtime_cwd, session_dir, &created.record.id, role)?;

    Ok(created.record.id)
}

pub(crate) fn apply_role_session_defaults(
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

fn claim_queue_entry_for_instance(
    connection: &Connection,
    queue_entry_id: &str,
    instance_id: &str,
) -> Result<bool, String> {
    let now = crate::state::now_iso();

    let claimed = connection
        .execute(
            r#"
            UPDATE role_queue_entries
            SET status = 'assigned',
                assigned_instance_id = ?2,
                started_at = COALESCE(started_at, ?3),
                updated_at = ?3
            WHERE id = ?1 AND status = 'queued'
            "#,
            params![queue_entry_id, instance_id, now],
        )
        .map_err(|error| format!("Unable to claim role queue entry {queue_entry_id}: {error}"))?;

    if claimed == 0 {
        return Ok(false);
    }

    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = 'running',
                current_queue_entry_id = ?2,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![instance_id, queue_entry_id, now],
        )
        .map_err(|error| format!("Unable to claim role instance {instance_id}: {error}"))?;

    Ok(true)
}

fn finalize_queue_entry_assignment(
    connection: &Connection,
    instance_id: &str,
    session_id: &str,
    worktree_path: &str,
) -> Result<(), String> {
    let now = crate::state::now_iso();

    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = 'running',
                session_id = ?2,
                worktree_path = ?3,
                updated_at = ?4
            WHERE id = ?1
            "#,
            params![instance_id, session_id, worktree_path, now],
        )
        .map_err(|error| format!("Unable to finalize role instance {instance_id}: {error}"))?;

    Ok(())
}

fn release_claimed_queue_entry(
    connection: &Connection,
    queue_entry_id: &str,
    instance_id: &str,
) -> Result<(), String> {
    let now = crate::state::now_iso();

    connection
        .execute(
            r#"
            UPDATE role_queue_entries
            SET status = 'queued',
                assigned_instance_id = NULL,
                started_at = NULL,
                updated_at = ?2
            WHERE id = ?1
            "#,
            params![queue_entry_id, now],
        )
        .map_err(|error| {
            format!("Unable to release claimed role queue entry {queue_entry_id}: {error}")
        })?;

    connection
        .execute(
            r#"
            UPDATE role_instances
            SET status = 'failed',
                current_queue_entry_id = NULL,
                last_error = COALESCE(last_error, 'Failed to provision single-use role runtime instance'),
                updated_at = ?2
            WHERE id = ?1
            "#,
            params![instance_id, now],
        )
        .map_err(|error| format!("Unable to release claimed role instance {instance_id}: {error}"))?;

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
        models::{
            RoleInstanceInput, RoleQueueEntryInput, TaskUpsertInput, WorkflowLaneInput,
            WorkflowUpsertInput,
        },
        services::{
            database::initialize_database_at, pi_sessions, role_runtime, roles, task_runtime,
            tasks, workflows,
        },
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
        let connection = Connection::open(path).expect("database should open");
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("default project should seed");
        connection
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
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: Vec::new(),
            },
        )
        .expect("role should create")
    }

    #[test]
    fn claim_queue_entry_only_succeeds_once() {
        let mut connection = open_test_connection("role-dispatch-claim-once");
        let role = create_role(&mut connection, "Planner", 1);
        let first_instance = role_runtime::create_role_instance(
            &mut connection,
            RoleInstanceInput {
                role_id: role.id.clone(),
                display_name: None,
                status: Some("idle".into()),
                current_queue_entry_id: None,
                session_id: None,
                worktree_path: None,
                last_heartbeat_at: None,
                last_error: None,
            },
        )
        .expect("first instance should create");
        let second_instance = role_runtime::create_role_instance(
            &mut connection,
            RoleInstanceInput {
                role_id: role.id.clone(),
                display_name: None,
                status: Some("idle".into()),
                current_queue_entry_id: None,
                session_id: None,
                worktree_path: None,
                last_heartbeat_at: None,
                last_error: None,
            },
        )
        .expect("second instance should create");

        let queue_entry = role_runtime::enqueue_role_work(
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

        assert!(
            claim_queue_entry_for_instance(&connection, &queue_entry.id, &first_instance.id)
                .expect("first claim should succeed")
        );
        assert!(
            !claim_queue_entry_for_instance(&connection, &queue_entry.id, &second_instance.id)
                .expect("second claim should be rejected")
        );
    }

    #[test]
    fn active_role_assignment_keeps_capacity_after_agent_end_until_transition() {
        let mut connection = open_test_connection("role-dispatch-active-session-stability");
        let role = create_role(&mut connection, "Stable", 1);
        let project_root = init_test_repo("role-dispatch-active-session-stability-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Stable Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-stable".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let now = crate::state::now_iso();
        connection.execute(
            "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project should insert");
        connection.execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-stable', 'orchestra', 'role-stable', 'Role Stable Repo', ?1, NULL, 'main', ?2, ?2)",
            params![project_root.display().to_string(), now.as_str()],
        ).expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Stable assignment".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-stable".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-stable".into()),
                repository_ids: vec!["repo-stable".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let assignment = task_runtime::dispatch_task_lane(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
        )
        .expect("task should dispatch");
        let session_id = assignment.session_id.clone().expect("session should exist");
        let detail_before = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role ops should load before completion");
        assert_eq!(detail_before.active_instance_count, 1);
        assert_eq!(detail_before.assigned_count, 1);

        complete_role_run_with_connection(&mut connection, &session_id)
            .expect("agent_end completion should not drop active assignment capacity");

        let detail_after = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role ops should load after completion");
        assert_eq!(detail_after.active_instance_count, 1);
        assert_eq!(detail_after.assigned_count, 1);
        assert!(detail_after
            .instances
            .iter()
            .any(|instance| instance.session_id.as_deref() == Some(session_id.as_str())));
    }

    #[test]
    fn active_role_assignment_keeps_capacity_after_process_end_until_transition() {
        let mut connection = open_test_connection("role-dispatch-process-end-stability");
        let role = create_role(&mut connection, "Stable", 1);
        let project_root = init_test_repo("role-dispatch-process-end-stability-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Stable Fail Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-stable-fail".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let now = crate::state::now_iso();
        connection.execute(
            "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project should insert");
        connection.execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-stable-fail', 'orchestra', 'role-stable-fail', 'Role Stable Fail Repo', ?1, NULL, 'main', ?2, ?2)",
            params![project_root.display().to_string(), now.as_str()],
        ).expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Stable assignment fail".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-stable-fail".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-stable-fail".into()),
                repository_ids: vec!["repo-stable-fail".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let assignment = task_runtime::dispatch_task_lane(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
        )
        .expect("task should dispatch");
        let session_id = assignment.session_id.clone().expect("session should exist");

        fail_role_run_with_connection(&mut connection, &session_id, "process ended")
            .expect("process end should not drop active assignment state");

        let detail_after = role_runtime::get_role_operations(&connection, &role.id)
            .expect("role ops should load after process end");
        assert_eq!(detail_after.active_instance_count, 1);
        assert_eq!(detail_after.assigned_count, 1);
        assert!(detail_after
            .instances
            .iter()
            .any(|instance| instance.session_id.as_deref() == Some(session_id.as_str())));
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
    fn workflow_lane_first_entry_creates_a_new_role_session() {
        let mut connection = open_test_connection("role-dispatch-new-lane-session");
        let role = create_role(&mut connection, "Builder", 1);
        let project_root = init_test_repo("role-dispatch-new-lane-session-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Lane dispatch flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");

        let old_session = pi_sessions::create_session_file(
            &project_root,
            &session_dir,
            Some("Old instance session"),
            false,
        )
        .expect("old session should create");
        let instance = role_runtime::create_role_instance(
            &mut connection,
            RoleInstanceInput {
                role_id: role.id.clone(),
                display_name: None,
                status: Some("idle".into()),
                current_queue_entry_id: None,
                session_id: Some(old_session.record.id.clone()),
                worktree_path: None,
                last_heartbeat_at: None,
                last_error: None,
            },
        )
        .expect("idle role instance should create");

        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "First lane entry".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "role".into(),
                assignee_id: Some(role.id.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        role_runtime::enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "workflow_lane".into(),
                source_task_id: Some(task.id.clone()),
                source_workflow_id: Some(workflow.id.clone()),
                source_lane_id: Some("lane-implement".into()),
                title: "Enter implement lane".into(),
                summary: None,
                entry_prompt: Some("Implement the work".into()),
            },
        )
        .expect("queue work should succeed");

        let detail = dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
            .expect("dispatch should succeed");
        let running_instance = detail
            .instances
            .iter()
            .find(|entry| entry.status == "running")
            .expect("fresh running instance should exist");
        assert_ne!(running_instance.id, instance.id);
        assert_ne!(
            running_instance.session_id.as_deref(),
            Some(old_session.record.id.as_str())
        );
        assert_eq!(
            detail
                .instances
                .iter()
                .filter(|entry| entry.role_id == role.id)
                .count(),
            2
        );
    }

    #[test]
    fn workflow_lane_reentry_creates_a_fresh_role_session() {
        let mut connection = open_test_connection("role-dispatch-reentry-session");
        let role = create_role(&mut connection, "Builder", 1);
        let project_root = init_test_repo("role-dispatch-reentry-session-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");

        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Lane reentry flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");

        let stale_session = pi_sessions::create_session_file(
            &project_root,
            &session_dir,
            Some("Stale instance session"),
            false,
        )
        .expect("stale session should create");
        let prior_lane_session = pi_sessions::create_session_file(
            &project_root,
            &session_dir,
            Some("Prior lane session"),
            false,
        )
        .expect("prior lane session should create");
        let instance = role_runtime::create_role_instance(
            &mut connection,
            RoleInstanceInput {
                role_id: role.id.clone(),
                display_name: None,
                status: Some("idle".into()),
                current_queue_entry_id: None,
                session_id: Some(stale_session.record.id.clone()),
                worktree_path: None,
                last_heartbeat_at: None,
                last_error: None,
            },
        )
        .expect("idle role instance should create");

        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Lane reentry".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-implement".into()),
                assignee_type: "role".into(),
                assignee_id: Some(role.id.clone()),
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        connection
            .execute(
                r#"
                INSERT INTO task_lane_assignments (
                    id, task_id, workflow_id, lane_id, worker_type, worker_id, status,
                    session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt,
                    started_at, completed_at, created_at, updated_at
                ) VALUES (
                    'prior-assignment', ?1, ?2, 'lane-implement', 'role', ?3, 'completed',
                    ?4, NULL, NULL, 'old-instance', NULL,
                    '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z'
                )
                "#,
                params![
                    task.id.as_str(),
                    workflow.id.as_str(),
                    role.id.as_str(),
                    prior_lane_session.record.id.as_str()
                ],
            )
            .expect("prior assignment should insert");

        role_runtime::enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "workflow_lane".into(),
                source_task_id: Some(task.id.clone()),
                source_workflow_id: Some(workflow.id.clone()),
                source_lane_id: Some("lane-implement".into()),
                title: "Re-enter implement lane".into(),
                summary: None,
                entry_prompt: Some("Implement the work again".into()),
            },
        )
        .expect("queue work should succeed");

        let detail = dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
            .expect("dispatch should succeed");
        let running_instance = detail
            .instances
            .iter()
            .find(|entry| entry.status == "running")
            .expect("fresh running instance should exist");
        assert_ne!(running_instance.id, instance.id);
        assert_ne!(
            running_instance.session_id.as_deref(),
            Some(stale_session.record.id.as_str())
        );
        assert_ne!(
            running_instance.session_id.as_deref(),
            Some(prior_lane_session.record.id.as_str())
        );
    }

    #[test]
    fn creates_a_fresh_role_instance_for_each_assignment() {
        let mut connection = open_test_connection("role-dispatch-single-use");
        let role = create_role(&mut connection, "Reviewer", 1);
        let project_root = init_test_repo("role-dispatch-single-use-project");
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
                title: "First assignment".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect("first queue work should succeed");

        let first_dispatch =
            dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
                .expect("first dispatch should succeed");
        let first_instance = first_dispatch
            .instances
            .first()
            .expect("first instance should exist")
            .clone();
        let first_session = first_instance
            .session_id
            .clone()
            .expect("first session should exist");
        let first_worktree = first_instance
            .worktree_path
            .clone()
            .expect("first worktree should exist");

        release_role_instance(
            &mut connection,
            &project_root,
            &session_dir,
            &first_instance.id,
            "success",
            None,
        )
        .expect("first release should succeed");

        role_runtime::enqueue_role_work(
            &mut connection,
            RoleQueueEntryInput {
                role_id: role.id.clone(),
                source_type: "manual".into(),
                source_task_id: None,
                source_workflow_id: None,
                source_lane_id: None,
                title: "Second assignment".into(),
                summary: None,
                entry_prompt: None,
            },
        )
        .expect("second queue work should succeed");

        let second_dispatch =
            dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
                .expect("second dispatch should succeed");
        let second_instance = second_dispatch
            .instances
            .iter()
            .find(|entry| entry.status == "running")
            .expect("second running instance should exist");
        assert_ne!(second_instance.id, first_instance.id);
        assert_ne!(
            second_instance.session_id.as_deref(),
            Some(first_session.as_str())
        );
        assert_ne!(
            second_instance.worktree_path.as_deref(),
            Some(first_worktree.as_str())
        );
    }

    #[test]
    fn resets_role_assignments_back_to_queue() {
        let mut connection = open_test_connection("role-reset-assignments");
        let role = create_role(&mut connection, "Resettable", 1);
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Reset Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-reset".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("role-reset-assignments-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let now = crate::state::now_iso();
        connection.execute(
            "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project should insert");
        connection.execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-reset', 'orchestra', 'role-reset', 'Role Reset Repo', ?1, NULL, 'main', ?2, ?2)",
            params![project_root.display().to_string(), now.as_str()],
        ).expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Reset role assignment".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-reset".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-reset".into()),
                repository_ids: vec!["repo-reset".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let assignment = task_runtime::dispatch_task_lane(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
        )
        .expect("task should dispatch");
        assert_eq!(assignment.status, "active");
        let original_session_id = assignment.session_id.clone();

        let (detail, changed_task_ids, changed_session_ids) =
            reset_role_assignments(&mut connection, &role.id).expect("role reset should succeed");
        assert_eq!(changed_task_ids, vec![task.id.clone()]);
        let changed_session_id_values = changed_session_ids
            .iter()
            .map(|(session_id, _)| session_id.clone())
            .collect::<Vec<_>>();
        if !changed_session_id_values.is_empty() {
            assert_eq!(
                changed_session_id_values,
                vec![original_session_id.clone().expect("session should exist")]
            );
        }
        assert_eq!(detail.queued_count, 1);
        assert_eq!(detail.active_instance_count, 0);
        assert!(detail
            .instances
            .iter()
            .all(|instance| instance.current_queue_entry_id.is_none()));
        assert!(detail
            .instances
            .iter()
            .all(|instance| instance.session_id.is_none()));

        let reset_task =
            tasks::get_task_context(&connection, &task.id).expect("task should reload");
        assert_eq!(reset_task.status, "ready");
        let queued_assignment = reset_task
            .active_lane_assignment
            .expect("queued assignment should remain");
        assert_eq!(queued_assignment.status, "queued");
        assert!(queued_assignment.session_id.is_none());
        assert!(queued_assignment.role_instance_id.is_none());

        let _ = dispatch_role_queue(&mut connection, &project_root, &session_dir, &role.id)
            .expect("queue should redispatch");
        let activated = task_runtime::activate_queued_role_assignments(&connection)
            .expect("queued assignment should activate");
        assert_eq!(activated.len(), 1);
        assert_eq!(activated[0].task_id, task.id);
        assert_eq!(activated[0].status, "active");
        assert!(activated[0].session_id.is_some());
    }

    #[test]
    fn reset_role_assignments_clears_session_ids_for_multiple_instances() {
        let mut connection = open_test_connection("role-reset-all-sessions");
        let role = create_role(&mut connection, "Resettable", 2);
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Reset Multi Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-reset-multi".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("role-reset-all-sessions-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let now = crate::state::now_iso();
        connection.execute(
            "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project should insert");
        connection.execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-reset-multi', 'orchestra', 'role-reset-multi', 'Role Reset Multi Repo', ?1, NULL, 'main', ?2, ?2)",
            params![project_root.display().to_string(), now.as_str()],
        ).expect("repository should insert");

        for title in ["First", "Second"] {
            let task = tasks::create_task(
                &mut connection,
                Some("orchestra"),
                TaskUpsertInput {
                    title: title.into(),
                    description: None,
                    task_type: "task".into(),
                    tags: Vec::new(),
                    status: "ready".into(),
                    priority: "P2".into(),
                    workflow_id: Some(workflow.id.clone()),
                    current_lane_id: Some("lane-reset-multi".into()),
                    assignee_type: "unassigned".into(),
                    assignee_id: None,
                    repository_id: Some("repo-reset-multi".into()),
                    repository_ids: vec!["repo-reset-multi".into()],
                    parent_task_id: None,
                    whip_max_attempts: None,
                    archived: None,
                },
            )
            .expect("task should create");
            task_runtime::dispatch_task_lane(
                &mut connection,
                &project_root,
                &session_dir,
                &task.id,
            )
            .expect("task should dispatch");
        }

        let (detail, _, session_ids) =
            reset_role_assignments(&mut connection, &role.id).expect("reset should succeed");
        assert_eq!(detail.queued_count, 2);
        assert_eq!(session_ids.len(), 2);
        assert!(detail
            .instances
            .iter()
            .all(|instance| instance.session_id.is_none()));
    }

    #[test]
    fn reset_role_assignments_deduplicates_open_queue_entries_and_assignments() {
        let mut connection = open_test_connection("role-reset-dedup");
        let role = create_role(&mut connection, "Resettable", 1);
        let workflow = workflows::create_workflow(
            &mut connection,
            WorkflowUpsertInput {
                name: "Reset Dedup Flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-reset-dedup".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some(role.slug.clone()),
                    entry_prompt_template: Some("Implement the task".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    needs_work_target_lane_id: None,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should create");
        let project_root = init_test_repo("role-reset-dedup-project");
        let session_dir = project_root
            .parent()
            .expect("repo should have parent")
            .join("sessions");
        fs::create_dir_all(&session_dir).expect("session dir should create");
        let now = crate::state::now_iso();
        connection.execute(
            "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("project should insert");
        connection.execute(
            "INSERT INTO repositories (id, project_id, slug, name, local_path, remote_url, default_branch, created_at, updated_at) VALUES ('repo-reset-dedup', 'orchestra', 'role-reset-dedup', 'Role Reset Dedup Repo', ?1, NULL, 'main', ?2, ?2)",
            params![project_root.display().to_string(), now.as_str()],
        ).expect("repository should insert");
        let task = tasks::create_task(
            &mut connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: "Reset duplicate role assignment".into(),
                description: None,
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: Some(workflow.id.clone()),
                current_lane_id: Some("lane-reset-dedup".into()),
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: Some("repo-reset-dedup".into()),
                repository_ids: vec!["repo-reset-dedup".into()],
                parent_task_id: None,
                whip_max_attempts: None,
                archived: None,
            },
        )
        .expect("task should create");

        let assignment = task_runtime::dispatch_task_lane(
            &mut connection,
            &project_root,
            &session_dir,
            &task.id,
        )
        .expect("task should dispatch");
        let _original_queue_entry_id = assignment
            .role_queue_entry_id
            .clone()
            .expect("queue entry should exist");

        let duplicate_queue_entry_id = "queue-duplicate-reset";
        connection.execute(
            "INSERT INTO role_queue_entries (id, role_id, status, source_type, source_task_id, source_workflow_id, source_lane_id, title, summary, entry_prompt, assigned_instance_id, created_at, updated_at, started_at, completed_at) VALUES (?1, ?2, 'queued', 'workflow_lane', ?3, ?4, ?5, 'ORC-1 · Duplicate', NULL, NULL, NULL, ?6, ?6, NULL, NULL)",
            params![
                duplicate_queue_entry_id,
                role.id.as_str(),
                task.id.as_str(),
                workflow.id.as_str(),
                "lane-reset-dedup",
                now.as_str(),
            ],
        ).expect("duplicate queue entry should insert");
        connection.execute(
            "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-duplicate-reset', ?1, ?2, 'lane-reset-dedup', 'role', ?3, 'queued', NULL, NULL, ?4, NULL, 'Prompt', NULL, NULL, 0, NULL, ?5, NULL, ?5, ?5)",
            params![
                task.id.as_str(),
                workflow.id.as_str(),
                role.id.as_str(),
                duplicate_queue_entry_id,
                now.as_str(),
            ],
        ).expect("duplicate assignment should insert");

        let (detail, changed_task_ids, _) =
            reset_role_assignments(&mut connection, &role.id).expect("reset should succeed");
        assert_eq!(changed_task_ids, vec![task.id.clone(), task.id.clone()]);
        assert_eq!(detail.queued_count, 1);

        let open_assignments = task_runtime::list_current_role_assignments(&connection, &role.id)
            .expect("open assignments should list");
        assert_eq!(open_assignments.len(), 1);
        assert_eq!(open_assignments[0].task_id, task.id);
        assert_eq!(open_assignments[0].lane_id, "lane-reset-dedup");
        assert_eq!(open_assignments[0].status, "queued");

        let queue_entries =
            role_runtime::list_role_queue_entries(&connection, Some(role.id.as_str()))
                .expect("queue entries should list");
        assert_eq!(queue_entries.len(), 2);
        let queued_entry = queue_entries
            .iter()
            .find(|entry| entry.status == "queued")
            .expect("one queued queue entry should remain");
        assert_eq!(
            open_assignments[0].role_queue_entry_id.as_deref(),
            Some(queued_entry.id.as_str())
        );
        assert_eq!(
            queue_entries
                .iter()
                .filter(|entry| entry.status == "queued")
                .count(),
            1
        );
        assert_eq!(
            queue_entries
                .iter()
                .find(|entry| entry.id == duplicate_queue_entry_id)
                .expect("duplicate queue entry should remain for history")
                .status,
            if queued_entry.id == duplicate_queue_entry_id {
                "queued"
            } else {
                "canceled"
            }
        );
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
        assert_eq!(released.instances[0].status, "completed");

        let disposed = dispose_role_instance(&mut connection, &project_root, &instance.id)
            .expect("dispose should succeed");
        assert_eq!(disposed.instances[0].status, "completed");
        assert!(!Path::new(&worktree_path).exists());
    }
}
