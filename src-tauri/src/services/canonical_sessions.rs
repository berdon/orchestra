use std::{
    collections::{HashMap, HashSet},
    fs,
    path::Path,
};

use rusqlite::{params, Connection};

use crate::services::{
    orchestra_paths::{default_orchestra_root, infer_project_slug, project_session_dir},
    pi_sessions, projects, session_list,
};

#[derive(Debug, Default, Clone, PartialEq, Eq)]
pub(crate) struct BackfillSessionsReport {
    pub created: usize,
    pub updated: usize,
    pub transcript_missing: usize,
    pub skipped_missing_project: usize,
}

#[derive(Debug, Clone, Default)]
struct CanonicalSessionSeed {
    transcript: Option<TranscriptMetadata>,
    list_entry: Option<LegacySessionListEntry>,
    assignment: Option<AssignmentBinding>,
    lane_run: Option<LaneRunBinding>,
    agent_runtime: Option<AgentRuntimeBinding>,
    role_instance: Option<RoleInstanceBinding>,
    first_seen_at: Option<String>,
    last_seen_at: Option<String>,
}

#[derive(Debug, Clone)]
struct TranscriptMetadata {
    project_id: Option<String>,
    transcript_path: Option<String>,
    transcript_cwd: Option<String>,
    transcript_exists: bool,
    file_size: Option<i64>,
    file_mtime_ms: Option<i64>,
    last_indexed_at: Option<String>,
    title: Option<String>,
    session_status: Option<String>,
    created_at: Option<String>,
    updated_at: Option<String>,
}

#[derive(Debug, Clone)]
struct LegacySessionListEntry {
    dismissed_at: Option<String>,
    hidden_reason: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct AssignmentBinding {
    assignment_id: String,
    task_id: Option<String>,
    project_id: Option<String>,
    workflow_id: Option<String>,
    lane_id: Option<String>,
    worker_type: Option<String>,
    worker_id: Option<String>,
    role_instance_id: Option<String>,
    task_status: Option<String>,
    assignment_status: String,
    started_at: String,
    completed_at: Option<String>,
    updated_at: String,
    created_at: String,
}

#[derive(Debug, Clone)]
struct LaneRunBinding {
    task_id: Option<String>,
    project_id: Option<String>,
    workflow_id: Option<String>,
    lane_id: Option<String>,
    task_status: Option<String>,
    started_at: String,
    completed_at: Option<String>,
}

#[derive(Debug, Clone)]
struct AgentRuntimeBinding {
    project_id: String,
    agent_id: String,
    runtime_status: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct RoleInstanceBinding {
    role_instance_id: String,
    role_id: String,
    runtime_status: String,
    inferred_project_id: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct CanonicalSessionRow {
    id: String,
    project_id: String,
    session_kind: String,
    owner_worker_type: Option<String>,
    owner_worker_id: Option<String>,
    agent_id: Option<String>,
    role_id: Option<String>,
    role_instance_id: Option<String>,
    primary_task_id: Option<String>,
    primary_workflow_id: Option<String>,
    primary_lane_id: Option<String>,
    primary_assignment_id: Option<String>,
    transcript_path: Option<String>,
    transcript_cwd: Option<String>,
    transcript_exists: bool,
    file_size: Option<i64>,
    file_mtime_ms: Option<i64>,
    last_indexed_at: Option<String>,
    title: String,
    session_status: String,
    list_visibility: String,
    hidden_reason: Option<String>,
    dismissed_at: Option<String>,
    first_seen_at: String,
    last_seen_at: String,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Default)]
struct SessionForeignKeyLookup {
    project_ids: HashSet<String>,
    agent_ids: HashSet<String>,
    role_ids: HashSet<String>,
    role_instance_ids: HashSet<String>,
    task_ids: HashSet<String>,
    workflow_ids: HashSet<String>,
    assignment_ids: HashSet<String>,
    workflow_lane_keys: HashSet<String>,
}

pub(crate) fn backfill_sessions_table(
    connection: &Connection,
) -> Result<BackfillSessionsReport, String> {
    let existing_ids = load_existing_session_ids(connection)?;
    let project_ids_by_slug = load_project_ids_by_slug(connection)?;
    let foreign_key_lookup = load_session_foreign_key_lookup(connection)?;
    let mut seeds = HashMap::<String, CanonicalSessionSeed>::new();

    collect_transcript_file_seeds(connection, &project_ids_by_slug, &mut seeds)?;
    collect_session_catalog_seeds(connection, &mut seeds)?;
    collect_session_list_entry_seeds(connection, &mut seeds)?;
    collect_assignment_seeds(connection, &mut seeds)?;
    collect_lane_run_seeds(connection, &mut seeds)?;
    collect_agent_runtime_seeds(connection, &mut seeds)?;
    collect_role_instance_seeds(connection, &project_ids_by_slug, &mut seeds)?;

    let mut report = BackfillSessionsReport::default();
    for (session_id, seed) in seeds {
        let Some(row) = build_canonical_session_row(&session_id, seed, &foreign_key_lookup) else {
            report.skipped_missing_project += 1;
            continue;
        };
        if row.transcript_exists {
            // handled below after insert/update
        } else {
            report.transcript_missing += 1;
        }
        upsert_canonical_session_row(connection, &row)?;
        if existing_ids.contains(&row.id) {
            report.updated += 1;
        } else {
            report.created += 1;
        }
    }

    Ok(report)
}

fn collect_transcript_file_seeds(
    connection: &Connection,
    project_ids_by_slug: &HashMap<String, String>,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let orchestra_root = default_orchestra_root()?;
    for (project_slug, project_id) in project_ids_by_slug {
        let _ = projects::resolve_project_runtime_root(connection, project_slug)?;
        let session_dir = project_session_dir(&orchestra_root, project_slug);
        if !session_dir.exists() {
            continue;
        }

        let entries = fs::read_dir(&session_dir).map_err(|error| {
            format!(
                "Unable to read session directory {}: {error}",
                session_dir.display()
            )
        })?;

        for entry in entries {
            let entry = entry
                .map_err(|error| format!("Unable to inspect session directory entry: {error}"))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }

            let stored = match pi_sessions::summarize_session_for_catalog(&path) {
                Ok(stored) => stored,
                Err(_) => continue,
            };
            let (file_size, file_mtime_ms) = pi_sessions::session_file_fingerprint(&path)?;
            let transcript_cwd = pi_sessions::session_file_header_cwd(&path)?
                .map(|value| value.display().to_string());

            let seed = seeds.entry(stored.record.id.clone()).or_default();
            seed.merge_transcript(TranscriptMetadata {
                project_id: Some(project_id.clone()),
                transcript_path: Some(path.display().to_string()),
                transcript_cwd,
                transcript_exists: true,
                file_size: Some(file_size as i64),
                file_mtime_ms: Some(file_mtime_ms),
                last_indexed_at: None,
                title: Some(stored.record.title.clone()),
                session_status: Some(canonicalize_transcript_status(&stored.record.status)),
                created_at: Some(stored.record.created_at.clone()),
                updated_at: Some(stored.record.updated_at.clone()),
            });
            seed.note_timestamp(Some(stored.record.created_at.as_str()));
            seed.note_timestamp(Some(stored.record.updated_at.as_str()));
        }
    }

    Ok(())
}

fn collect_session_catalog_seeds(
    connection: &Connection,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT sc.session_id, p.id, sc.session_path, sc.created_at, sc.updated_at,
                   sc.title, sc.status, sc.file_size, sc.file_mtime_ms, sc.last_indexed_at
            FROM session_catalog sc
            LEFT JOIN projects p ON p.slug = sc.project_slug
            "#,
        )
        .map_err(|error| format!("Unable to prepare session catalog backfill query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, String>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, i64>(7)?,
                row.get::<_, i64>(8)?,
                row.get::<_, String>(9)?,
            ))
        })
        .map_err(|error| format!("Unable to query session catalog rows: {error}"))?;

    for row in rows {
        let (
            session_id,
            project_id,
            session_path,
            created_at,
            updated_at,
            title,
            status,
            file_size,
            file_mtime_ms,
            last_indexed_at,
        ) = row.map_err(|error| format!("Unable to read session catalog row: {error}"))?;
        let seed = seeds.entry(session_id).or_default();
        seed.merge_transcript(TranscriptMetadata {
            project_id,
            transcript_path: Some(session_path.clone()),
            transcript_cwd: None,
            transcript_exists: Path::new(&session_path).exists(),
            file_size: Some(file_size),
            file_mtime_ms: Some(file_mtime_ms),
            last_indexed_at: Some(last_indexed_at),
            title: Some(title),
            session_status: Some(canonicalize_transcript_status(&status)),
            created_at: Some(created_at.clone()),
            updated_at: Some(updated_at.clone()),
        });
        seed.note_timestamp(Some(created_at.as_str()));
        seed.note_timestamp(Some(updated_at.as_str()));
    }

    Ok(())
}

fn collect_session_list_entry_seeds(
    connection: &Connection,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT session_id, dismissed_at, hidden_reason, created_at, updated_at
            FROM session_list_entries
            "#,
        )
        .map_err(|error| format!("Unable to prepare session list backfill query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                LegacySessionListEntry {
                    dismissed_at: row.get::<_, Option<String>>(1)?,
                    hidden_reason: row.get::<_, Option<String>>(2)?,
                    created_at: row.get::<_, String>(3)?,
                    updated_at: row.get::<_, String>(4)?,
                },
            ))
        })
        .map_err(|error| format!("Unable to query session list rows: {error}"))?;

    for row in rows {
        let (session_id, entry) =
            row.map_err(|error| format!("Unable to read session list row: {error}"))?;
        let seed = seeds.entry(session_id).or_default();
        seed.note_timestamp(Some(entry.created_at.as_str()));
        seed.note_timestamp(Some(entry.updated_at.as_str()));
        seed.list_entry = Some(entry);
    }

    Ok(())
}

fn collect_assignment_seeds(
    connection: &Connection,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT tla.session_id, tla.id, tla.task_id, t.project_id, tla.workflow_id, tla.lane_id,
                   tla.worker_type, tla.worker_id, tla.role_instance_id, t.status, tla.status,
                   tla.started_at, tla.completed_at, tla.updated_at, tla.created_at
            FROM task_lane_assignments tla
            LEFT JOIN tasks t ON t.id = tla.task_id
            WHERE tla.session_id IS NOT NULL AND TRIM(tla.session_id) != ''
            ORDER BY tla.session_id ASC,
                CASE tla.status
                    WHEN 'active' THEN 0
                    WHEN 'awaiting_user_approval' THEN 1
                    WHEN 'awaiting_user_intervention' THEN 2
                    WHEN 'paused_by_user' THEN 3
                    WHEN 'queued' THEN 4
                    ELSE 5
                END,
                COALESCE(tla.completed_at, tla.updated_at, tla.created_at) DESC,
                tla.id DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task assignment backfill query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                AssignmentBinding {
                    assignment_id: row.get::<_, String>(1)?,
                    task_id: row.get::<_, Option<String>>(2)?,
                    project_id: row.get::<_, Option<String>>(3)?,
                    workflow_id: row.get::<_, Option<String>>(4)?,
                    lane_id: row.get::<_, Option<String>>(5)?,
                    worker_type: row.get::<_, Option<String>>(6)?,
                    worker_id: row.get::<_, Option<String>>(7)?,
                    role_instance_id: row.get::<_, Option<String>>(8)?,
                    task_status: row.get::<_, Option<String>>(9)?,
                    assignment_status: row.get::<_, String>(10)?,
                    started_at: row.get::<_, String>(11)?,
                    completed_at: row.get::<_, Option<String>>(12)?,
                    updated_at: row.get::<_, String>(13)?,
                    created_at: row.get::<_, String>(14)?,
                },
            ))
        })
        .map_err(|error| format!("Unable to query task assignment rows: {error}"))?;

    for row in rows {
        let (session_id, assignment) =
            row.map_err(|error| format!("Unable to read task assignment row: {error}"))?;
        let seed = seeds.entry(session_id).or_default();
        seed.note_timestamp(Some(assignment.created_at.as_str()));
        seed.note_timestamp(Some(assignment.started_at.as_str()));
        seed.note_timestamp(Some(assignment.updated_at.as_str()));
        seed.note_timestamp(assignment.completed_at.as_deref());
        if seed.assignment.is_none() {
            seed.assignment = Some(assignment);
        }
    }

    Ok(())
}

fn collect_lane_run_seeds(
    connection: &Connection,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT lr.session_id, lr.task_id, t.project_id, t.workflow_id, lr.lane_id, t.status,
                   lr.started_at, lr.completed_at
            FROM task_lane_runs lr
            LEFT JOIN tasks t ON t.id = lr.task_id
            ORDER BY lr.session_id ASC,
                     COALESCE(lr.completed_at, lr.started_at) DESC,
                     lr.id DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare lane-run backfill query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                LaneRunBinding {
                    task_id: row.get::<_, Option<String>>(1)?,
                    project_id: row.get::<_, Option<String>>(2)?,
                    workflow_id: row.get::<_, Option<String>>(3)?,
                    lane_id: row.get::<_, Option<String>>(4)?,
                    task_status: row.get::<_, Option<String>>(5)?,
                    started_at: row.get::<_, String>(6)?,
                    completed_at: row.get::<_, Option<String>>(7)?,
                },
            ))
        })
        .map_err(|error| format!("Unable to query lane-run rows: {error}"))?;

    for row in rows {
        let (session_id, lane_run) =
            row.map_err(|error| format!("Unable to read lane-run row: {error}"))?;
        let seed = seeds.entry(session_id).or_default();
        seed.note_timestamp(Some(lane_run.started_at.as_str()));
        seed.note_timestamp(lane_run.completed_at.as_deref());
        if seed.lane_run.is_none() {
            seed.lane_run = Some(lane_run);
        }
    }

    Ok(())
}

fn collect_agent_runtime_seeds(
    connection: &Connection,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT main_session_id, project_id, agent_id, status, created_at, updated_at
            FROM agent_runtime_states
            WHERE main_session_id IS NOT NULL AND TRIM(main_session_id) != ''
            "#,
        )
        .map_err(|error| format!("Unable to prepare agent runtime backfill query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                AgentRuntimeBinding {
                    project_id: row.get::<_, String>(1)?,
                    agent_id: row.get::<_, String>(2)?,
                    runtime_status: row.get::<_, String>(3)?,
                    created_at: row.get::<_, String>(4)?,
                    updated_at: row.get::<_, String>(5)?,
                },
            ))
        })
        .map_err(|error| format!("Unable to query agent runtime rows: {error}"))?;

    for row in rows {
        let (session_id, binding) =
            row.map_err(|error| format!("Unable to read agent runtime row: {error}"))?;
        let seed = seeds.entry(session_id).or_default();
        seed.note_timestamp(Some(binding.created_at.as_str()));
        seed.note_timestamp(Some(binding.updated_at.as_str()));
        seed.agent_runtime = Some(binding);
    }

    Ok(())
}

fn collect_role_instance_seeds(
    connection: &Connection,
    project_ids_by_slug: &HashMap<String, String>,
    seeds: &mut HashMap<String, CanonicalSessionSeed>,
) -> Result<(), String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT session_id, id, role_id, status, worktree_path, created_at, updated_at
            FROM role_instances
            WHERE session_id IS NOT NULL AND TRIM(session_id) != ''
            "#,
        )
        .map_err(|error| format!("Unable to prepare role instance backfill query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            let worktree_path = row.get::<_, Option<String>>(4)?;
            let inferred_project_id = worktree_path
                .as_deref()
                .map(Path::new)
                .map(infer_project_slug)
                .and_then(|slug| project_ids_by_slug.get(&slug).cloned());
            Ok((
                row.get::<_, String>(0)?,
                RoleInstanceBinding {
                    role_instance_id: row.get::<_, String>(1)?,
                    role_id: row.get::<_, String>(2)?,
                    runtime_status: row.get::<_, String>(3)?,
                    inferred_project_id,
                    created_at: row.get::<_, String>(5)?,
                    updated_at: row.get::<_, String>(6)?,
                },
            ))
        })
        .map_err(|error| format!("Unable to query role instance rows: {error}"))?;

    for row in rows {
        let (session_id, binding) =
            row.map_err(|error| format!("Unable to read role instance row: {error}"))?;
        let seed = seeds.entry(session_id).or_default();
        seed.note_timestamp(Some(binding.created_at.as_str()));
        seed.note_timestamp(Some(binding.updated_at.as_str()));
        seed.role_instance = Some(binding);
    }

    Ok(())
}

fn build_canonical_session_row(
    session_id: &str,
    seed: CanonicalSessionSeed,
    foreign_key_lookup: &SessionForeignKeyLookup,
) -> Option<CanonicalSessionRow> {
    let active_assignment = seed.assignment.as_ref().filter(|assignment| {
        matches!(
            assignment.assignment_status.as_str(),
            "active"
                | "awaiting_user_approval"
                | "awaiting_user_intervention"
                | "paused_by_user"
                | "queued"
        )
    });
    let primary_binding_task_id = first_existing_id(
        [
            seed.assignment
                .as_ref()
                .and_then(|assignment| assignment.task_id.clone()),
            seed.lane_run
                .as_ref()
                .and_then(|lane_run| lane_run.task_id.clone()),
        ],
        &foreign_key_lookup.task_ids,
    );
    let primary_binding_workflow_id = first_existing_id(
        [
            seed.assignment
                .as_ref()
                .and_then(|assignment| assignment.workflow_id.clone()),
            seed.lane_run
                .as_ref()
                .and_then(|lane_run| lane_run.workflow_id.clone()),
        ],
        &foreign_key_lookup.workflow_ids,
    );
    let primary_binding_lane_id = primary_binding_workflow_id
        .as_deref()
        .and_then(|workflow_id| {
            first_existing_lane_id(
                workflow_id,
                [
                    seed.assignment
                        .as_ref()
                        .and_then(|assignment| assignment.lane_id.clone()),
                    seed.lane_run
                        .as_ref()
                        .and_then(|lane_run| lane_run.lane_id.clone()),
                ],
                &foreign_key_lookup.workflow_lane_keys,
            )
        });
    let project_id = first_existing_id(
        [
            active_assignment.and_then(|assignment| assignment.project_id.clone()),
            seed.agent_runtime
                .as_ref()
                .map(|binding| binding.project_id.clone()),
            seed.assignment
                .as_ref()
                .and_then(|assignment| assignment.project_id.clone()),
            seed.lane_run
                .as_ref()
                .and_then(|lane_run| lane_run.project_id.clone()),
            seed.transcript
                .as_ref()
                .and_then(|transcript| transcript.project_id.clone()),
            seed.role_instance
                .as_ref()
                .and_then(|binding| binding.inferred_project_id.clone()),
        ],
        &foreign_key_lookup.project_ids,
    )?;

    let session_kind = if seed.agent_runtime.is_some() {
        "agent_main"
    } else if seed.role_instance.is_some() {
        "role_instance"
    } else if seed.assignment.is_some() || seed.lane_run.is_some() {
        "task_assignment"
    } else if seed.transcript.is_some() {
        "user_created"
    } else {
        "orphaned"
    }
    .to_string();

    let agent_id = seed
        .agent_runtime
        .as_ref()
        .map(|binding| binding.agent_id.clone())
        .filter(|agent_id| foreign_key_lookup.agent_ids.contains(agent_id));
    let role_id = first_existing_id(
        [
            seed.role_instance
                .as_ref()
                .map(|binding| binding.role_id.clone()),
            seed.assignment
                .as_ref()
                .filter(|assignment| assignment.worker_type.as_deref() == Some("role"))
                .and_then(|assignment| assignment.worker_id.clone()),
        ],
        &foreign_key_lookup.role_ids,
    );
    let role_instance_id = first_existing_id(
        [
            seed.role_instance
                .as_ref()
                .map(|binding| binding.role_instance_id.clone()),
            seed.assignment
                .as_ref()
                .and_then(|assignment| assignment.role_instance_id.clone()),
        ],
        &foreign_key_lookup.role_instance_ids,
    );
    let (owner_worker_type, owner_worker_id) = if let Some(agent_id) = agent_id.clone() {
        (Some("agent".to_string()), Some(agent_id))
    } else if let Some(role_id) = role_id.clone() {
        (Some("role".to_string()), Some(role_id))
    } else {
        (
            seed.assignment
                .as_ref()
                .and_then(|assignment| assignment.worker_type.clone()),
            seed.assignment
                .as_ref()
                .and_then(|assignment| assignment.worker_id.clone()),
        )
    };

    let task_status = seed
        .assignment
        .as_ref()
        .and_then(|assignment| assignment.task_status.clone())
        .or_else(|| {
            seed.lane_run
                .as_ref()
                .and_then(|lane_run| lane_run.task_status.clone())
        });
    let session_status = seed
        .transcript
        .as_ref()
        .and_then(|transcript| transcript.session_status.clone())
        .unwrap_or_else(|| {
            if active_assignment.is_some()
                || seed
                    .agent_runtime
                    .as_ref()
                    .is_some_and(|binding| binding.runtime_status == "running")
                || seed
                    .role_instance
                    .as_ref()
                    .is_some_and(|binding| binding.runtime_status == "running")
            {
                "active".to_string()
            } else {
                "closed".to_string()
            }
        });

    let (list_visibility, hidden_reason, dismissed_at) =
        if let Some(list_entry) = seed.list_entry.as_ref() {
            let hidden_reason = list_entry.hidden_reason.clone().or_else(|| {
                list_entry
                    .dismissed_at
                    .as_ref()
                    .map(|_| session_list::SESSION_HIDDEN_REASON_USER_DISMISSED.to_string())
            });
            (
                "hidden".to_string(),
                hidden_reason,
                list_entry.dismissed_at.clone(),
            )
        } else if active_assignment.is_some() {
            ("active".to_string(), None, None)
        } else if task_status.as_deref() == Some("completed") {
            (
                "hidden".to_string(),
                Some(session_list::SESSION_HIDDEN_REASON_TASK_COMPLETED.to_string()),
                None,
            )
        } else if task_status.as_deref() == Some("canceled") {
            (
                "hidden".to_string(),
                Some(session_list::SESSION_HIDDEN_REASON_TASK_CANCELED.to_string()),
                None,
            )
        } else if role_id.is_some() && primary_binding_task_id.is_none() {
            (
                "hidden".to_string(),
                Some(session_list::SESSION_HIDDEN_REASON_STALE_ROLE_SESSION.to_string()),
                None,
            )
        } else if matches!(session_status.as_str(), "active" | "idle") {
            ("active".to_string(), None, None)
        } else {
            ("closed".to_string(), None, None)
        };

    let first_seen_at = seed
        .first_seen_at
        .clone()
        .unwrap_or_else(crate::state::now_iso);
    let last_seen_at = seed
        .last_seen_at
        .clone()
        .unwrap_or_else(|| first_seen_at.clone());
    let created_at = seed
        .transcript
        .as_ref()
        .and_then(|transcript| transcript.created_at.clone())
        .unwrap_or_else(|| first_seen_at.clone());
    let updated_at = seed
        .transcript
        .as_ref()
        .and_then(|transcript| transcript.updated_at.clone())
        .unwrap_or_else(|| last_seen_at.clone());
    let title = seed
        .transcript
        .as_ref()
        .and_then(|transcript| transcript.title.clone())
        .filter(|title| !title.trim().is_empty())
        .unwrap_or_else(|| fallback_session_title(session_id, &seed));

    Some(CanonicalSessionRow {
        id: session_id.to_string(),
        project_id,
        session_kind,
        owner_worker_type,
        owner_worker_id,
        agent_id,
        role_id,
        role_instance_id,
        primary_task_id: primary_binding_task_id,
        primary_workflow_id: primary_binding_workflow_id,
        primary_lane_id: primary_binding_lane_id,
        primary_assignment_id: seed
            .assignment
            .as_ref()
            .map(|assignment| assignment.assignment_id.clone())
            .filter(|assignment_id| foreign_key_lookup.assignment_ids.contains(assignment_id)),
        transcript_path: seed
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.transcript_path.clone()),
        transcript_cwd: seed
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.transcript_cwd.clone()),
        transcript_exists: seed
            .transcript
            .as_ref()
            .is_some_and(|transcript| transcript.transcript_exists),
        file_size: seed
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.file_size),
        file_mtime_ms: seed
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.file_mtime_ms),
        last_indexed_at: seed
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.last_indexed_at.clone()),
        title,
        session_status,
        list_visibility,
        hidden_reason,
        dismissed_at,
        first_seen_at,
        last_seen_at,
        created_at,
        updated_at,
    })
}

fn upsert_canonical_session_row(
    connection: &Connection,
    row: &CanonicalSessionRow,
) -> Result<(), String> {
    let session_path = row
        .transcript_path
        .clone()
        .unwrap_or_else(|| format!("missing://{}", row.id));
    connection
        .execute(
            r#"
            INSERT INTO sessions (
                id, project_id, session_path, session_kind, owner_worker_type, owner_worker_id,
                agent_id, role_id, role_instance_id,
                primary_task_id, primary_workflow_id, primary_lane_id, primary_assignment_id,
                transcript_path, transcript_cwd, transcript_exists, file_size, file_mtime_ms,
                last_indexed_at, title, session_status, list_visibility, hidden_reason,
                dismissed_at, first_seen_at, last_seen_at, created_at, updated_at
            )
            VALUES (
                ?1, ?2, ?3, ?4, ?5, ?6,
                ?7, ?8, ?9,
                ?10, ?11, ?12, ?13,
                ?14, ?15, ?16, ?17, ?18,
                ?19, ?20, ?21, ?22, ?23,
                ?24, ?25, ?26, ?27, ?28
            )
            ON CONFLICT(id) DO UPDATE SET
                project_id = excluded.project_id,
                session_path = excluded.session_path,
                session_kind = excluded.session_kind,
                owner_worker_type = excluded.owner_worker_type,
                owner_worker_id = excluded.owner_worker_id,
                agent_id = excluded.agent_id,
                role_id = excluded.role_id,
                role_instance_id = excluded.role_instance_id,
                primary_task_id = excluded.primary_task_id,
                primary_workflow_id = excluded.primary_workflow_id,
                primary_lane_id = excluded.primary_lane_id,
                primary_assignment_id = excluded.primary_assignment_id,
                transcript_path = excluded.transcript_path,
                transcript_cwd = excluded.transcript_cwd,
                transcript_exists = excluded.transcript_exists,
                file_size = excluded.file_size,
                file_mtime_ms = excluded.file_mtime_ms,
                last_indexed_at = excluded.last_indexed_at,
                title = excluded.title,
                session_status = excluded.session_status,
                list_visibility = excluded.list_visibility,
                hidden_reason = excluded.hidden_reason,
                dismissed_at = excluded.dismissed_at,
                first_seen_at = excluded.first_seen_at,
                last_seen_at = excluded.last_seen_at,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at
            "#,
            params![
                row.id,
                row.project_id,
                row.transcript_path.clone().unwrap_or_default(),
                row.session_kind,
                row.owner_worker_type,
                row.owner_worker_id,
                row.agent_id,
                row.role_id,
                row.role_instance_id,
                row.primary_task_id,
                row.primary_workflow_id,
                row.primary_lane_id,
                row.primary_assignment_id,
                session_path,
                row.transcript_cwd,
                if row.transcript_exists { 1 } else { 0 },
                row.file_size,
                row.file_mtime_ms,
                row.last_indexed_at,
                row.title,
                row.session_status,
                row.list_visibility,
                row.hidden_reason,
                row.dismissed_at,
                row.first_seen_at,
                row.last_seen_at,
                row.created_at,
                row.updated_at,
            ],
        )
        .map_err(|error| format!("Unable to upsert canonical session {}: {error}", row.id))?;
    Ok(())
}

fn load_existing_session_ids(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare("SELECT id FROM sessions")
        .map_err(|error| format!("Unable to prepare canonical session id query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query canonical session ids: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read canonical session ids: {error}"))
}

fn load_project_ids_by_slug(connection: &Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT slug, id FROM projects")
        .map_err(|error| format!("Unable to prepare project lookup query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .map_err(|error| format!("Unable to query project lookup rows: {error}"))?;
    let pairs = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read project lookup rows: {error}"))?;
    Ok(pairs.into_iter().collect())
}

fn load_session_foreign_key_lookup(
    connection: &Connection,
) -> Result<SessionForeignKeyLookup, String> {
    let workflow_lane_keys = connection
        .prepare("SELECT workflow_id, id FROM workflow_lanes")
        .map_err(|error| format!("Unable to prepare workflow lane lookup query: {error}"))?
        .query_map([], |row| {
            Ok(workflow_lane_key(
                &row.get::<_, String>(0)?,
                &row.get::<_, String>(1)?,
            ))
        })
        .map_err(|error| format!("Unable to query workflow lane lookup rows: {error}"))?
        .collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to read workflow lane lookup rows: {error}"))?;

    Ok(SessionForeignKeyLookup {
        project_ids: load_id_set(connection, "projects")?,
        agent_ids: load_id_set(connection, "agents")?,
        role_ids: load_id_set(connection, "roles")?,
        role_instance_ids: load_id_set(connection, "role_instances")?,
        task_ids: load_id_set(connection, "tasks")?,
        workflow_ids: load_id_set(connection, "workflows")?,
        assignment_ids: load_id_set(connection, "task_lane_assignments")?,
        workflow_lane_keys,
    })
}

fn load_id_set(connection: &Connection, table_name: &str) -> Result<HashSet<String>, String> {
    let query = format!("SELECT id FROM {table_name}");
    let mut statement = connection
        .prepare(&query)
        .map_err(|error| format!("Unable to prepare {table_name} id lookup query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query {table_name} id lookup rows: {error}"))?;
    rows.collect::<Result<HashSet<_>, _>>()
        .map_err(|error| format!("Unable to read {table_name} id lookup rows: {error}"))
}

fn first_existing_id<const N: usize>(
    candidates: [Option<String>; N],
    valid_ids: &HashSet<String>,
) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .find(|value| valid_ids.contains(value))
}

fn first_existing_lane_id<const N: usize>(
    workflow_id: &str,
    candidates: [Option<String>; N],
    workflow_lane_keys: &HashSet<String>,
) -> Option<String> {
    candidates
        .into_iter()
        .flatten()
        .find(|lane_id| workflow_lane_keys.contains(&workflow_lane_key(workflow_id, lane_id)))
}

fn workflow_lane_key(workflow_id: &str, lane_id: &str) -> String {
    format!("{workflow_id}\u{0}{lane_id}")
}

fn canonicalize_transcript_status(status: &str) -> String {
    match status {
        "active" => "active".to_string(),
        "idle" => "idle".to_string(),
        _ => "closed".to_string(),
    }
}

fn fallback_session_title(session_id: &str, seed: &CanonicalSessionSeed) -> String {
    if let Some(task_id) = seed
        .assignment
        .as_ref()
        .and_then(|assignment| assignment.task_id.clone())
    {
        return format!("Task session {task_id}");
    }
    if let Some(task_id) = seed
        .lane_run
        .as_ref()
        .and_then(|lane_run| lane_run.task_id.clone())
    {
        return format!("Task session {task_id}");
    }
    if let Some(agent_id) = seed
        .agent_runtime
        .as_ref()
        .map(|binding| binding.agent_id.clone())
    {
        return format!("Agent session {agent_id}");
    }
    if let Some(role_id) = seed
        .role_instance
        .as_ref()
        .map(|binding| binding.role_id.clone())
    {
        return format!("Role session {role_id}");
    }
    format!("Session {}", &session_id[..session_id.len().min(8)])
}

impl CanonicalSessionSeed {
    fn merge_transcript(&mut self, source: TranscriptMetadata) {
        self.note_timestamp(source.created_at.as_deref());
        self.note_timestamp(source.updated_at.as_deref());

        match self.transcript.as_mut() {
            None => self.transcript = Some(source),
            Some(existing) => {
                if source.transcript_exists {
                    let last_indexed_at = source
                        .last_indexed_at
                        .clone()
                        .or_else(|| existing.last_indexed_at.clone());
                    *existing = source;
                    existing.last_indexed_at = last_indexed_at;
                } else {
                    if existing.project_id.is_none() {
                        existing.project_id = source.project_id;
                    }
                    if existing.transcript_path.is_none() {
                        existing.transcript_path = source.transcript_path;
                    }
                    if existing.transcript_cwd.is_none() {
                        existing.transcript_cwd = source.transcript_cwd;
                    }
                    if existing.file_size.is_none() {
                        existing.file_size = source.file_size;
                    }
                    if existing.file_mtime_ms.is_none() {
                        existing.file_mtime_ms = source.file_mtime_ms;
                    }
                    if existing.last_indexed_at.is_none() {
                        existing.last_indexed_at = source.last_indexed_at;
                    }
                    if existing.title.is_none() {
                        existing.title = source.title;
                    }
                    if existing.session_status.is_none() {
                        existing.session_status = source.session_status;
                    }
                    if existing.created_at.is_none() {
                        existing.created_at = source.created_at;
                    }
                    if existing.updated_at.is_none() {
                        existing.updated_at = source.updated_at;
                    }
                }
            }
        }
    }

    fn note_timestamp(&mut self, timestamp: Option<&str>) {
        let Some(timestamp) = timestamp.filter(|value| !value.trim().is_empty()) else {
            return;
        };
        match self.first_seen_at.as_ref() {
            Some(current) if current.as_str() <= timestamp => {}
            _ => self.first_seen_at = Some(timestamp.to_string()),
        }
        match self.last_seen_at.as_ref() {
            Some(current) if current.as_str() >= timestamp => {}
            _ => self.last_seen_at = Some(timestamp.to_string()),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::{database, orchestra_paths::project_root};
    use std::{env, fs, path::PathBuf};
    use uuid::Uuid;

    fn with_temp_storage_root<T>(label: &str, action: impl FnOnce(PathBuf) -> T) -> T {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_root = env::var_os("ORCHESTRA_STORAGE_ROOT");
        let root = env::temp_dir().join(format!("{label}-{}", Uuid::new_v4().simple()));
        fs::create_dir_all(&root).expect("temp storage root should create");
        unsafe {
            env::set_var("ORCHESTRA_STORAGE_ROOT", &root);
        }
        let result = action(root.clone());
        match previous_root {
            Some(value) => unsafe { env::set_var("ORCHESTRA_STORAGE_ROOT", value) },
            None => unsafe { env::remove_var("ORCHESTRA_STORAGE_ROOT") },
        }
        let _ = fs::remove_dir_all(root);
        result
    }

    fn seed_project(connection: &Connection, project_id: &str, slug: &str) {
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'ORC', NULL, ?4, ?4)",
                params![project_id, slug, slug, now],
            )
            .expect("project should seed");
    }

    fn seed_workflow(connection: &Connection, workflow_id: &str, lane_id: &str) {
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 0, ?4, ?4)",
                params![workflow_id, workflow_id, workflow_id, now],
            )
            .expect("workflow should seed");
        connection
            .execute(
                r#"INSERT INTO workflow_lanes (
                        id, workflow_id, lane_key, name, description, lane_order,
                        assigned_entity_type, assigned_entity_id, entry_prompt_template,
                        use_separate_worktree, require_user_approval_on_success,
                        success_transition_type, success_target_lane_id,
                        failure_transition_type, failure_target_lane_id,
                        user_intervention_target_lane_id, created_at, updated_at
                    ) VALUES (
                        ?1, ?2, ?1, ?1, NULL, 0,
                        'user', NULL, NULL,
                        0, 0,
                        'end', NULL,
                        'end', NULL,
                        NULL, ?3, ?3
                    )"#,
                params![lane_id, workflow_id, now],
            )
            .expect("workflow lane should seed");
    }

    fn write_session_file(
        session_dir: &Path,
        session_id: &str,
        title: &str,
        message_text: &str,
        cwd: &Path,
    ) {
        fs::create_dir_all(session_dir).expect("session dir should create");
        let file_name = format!("2026-04-30T00-00-00Z_{session_id}.jsonl");
        let path = session_dir.join(file_name);
        let content = format!(
            concat!(
                "{{\"type\":\"session\",\"version\":3,\"id\":\"{}\",\"timestamp\":\"2026-04-30T00:00:00Z\",\"cwd\":\"{}\"}}\n",
                "{{\"type\":\"session_info\",\"id\":\"info-1\",\"parentId\":null,\"timestamp\":\"2026-04-30T00:00:01Z\",\"name\":\"{}\"}}\n",
                "{{\"type\":\"message\",\"id\":\"msg-1\",\"timestamp\":\"2026-04-30T00:00:02Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{}\"}}],\"timestamp\":1714435202000}}}}\n"
            ),
            session_id,
            cwd.display(),
            title,
            message_text,
        );
        fs::write(&path, content).expect("session file should write");
    }

    #[test]
    fn backfill_sessions_table_copies_transcript_assignment_and_hidden_metadata() {
        with_temp_storage_root("canonical-sessions-transcript", |root| {
            let connection = Connection::open_in_memory().expect("in-memory db should open");
            database::apply_migrations(&connection).expect("migrations should apply");

            seed_project(&connection, "project-1", "orchestra");
            seed_workflow(&connection, "workflow-1", "lane-1");
            let runtime_root = project_root(&root, "orchestra");
            let session_dir = project_session_dir(&root, "orchestra");
            let session_id = Uuid::new_v4().to_string();
            write_session_file(
                &session_dir,
                &session_id,
                "Canonical backfill",
                "hello",
                &runtime_root,
            );

            let now = crate::state::now_iso();
            connection
                .execute(
                    "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, auto_blocked_by_dependencies, archived, source_schedule_id, source_schedule_occurrence_id, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'ORC-1', 'Task 1', NULL, 'task', 'ready', 'P1', 'workflow-1', 'lane-1', 'user', NULL, NULL, NULL, 10, 0, 0, NULL, NULL, ?1, ?1)",
                    params![now],
                )
                .expect("task should seed");
            connection
                .execute(
                    "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-1', 'workflow-1', 'lane-1', 'user', NULL, 'active', ?1, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?2, NULL, ?2, ?2)",
                    params![session_id, now],
                )
                .expect("assignment should seed");
            connection
                .execute(
                    "INSERT INTO session_list_entries (session_id, dismissed_at, hidden_reason, created_at, updated_at) VALUES (?1, ?2, NULL, ?2, ?2)",
                    params![session_id, now],
                )
                .expect("session list entry should seed");

            let first = backfill_sessions_table(&connection).expect("backfill should succeed");
            assert_eq!(first.created, 1);
            assert_eq!(first.updated, 0);
            assert_eq!(first.transcript_missing, 0);

            let row = connection
                .query_row(
                    "SELECT project_id, session_kind, owner_worker_type, primary_task_id, primary_assignment_id, transcript_exists, title, session_status, list_visibility, hidden_reason, dismissed_at FROM sessions WHERE id = ?1",
                    [session_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, String>(8)?,
                            row.get::<_, Option<String>>(9)?,
                            row.get::<_, Option<String>>(10)?,
                        ))
                    },
                )
                .expect("canonical session row should exist");
            assert_eq!(row.0, "project-1");
            assert_eq!(row.1, "task_assignment");
            assert_eq!(row.2.as_deref(), Some("user"));
            assert_eq!(row.3.as_deref(), Some("task-1"));
            assert_eq!(row.4.as_deref(), Some("assignment-1"));
            assert_eq!(row.5, 1);
            assert_eq!(row.6, "Canonical backfill");
            assert_eq!(row.7, "active");
            assert_eq!(row.8, "hidden");
            assert_eq!(
                row.9.as_deref(),
                Some(session_list::SESSION_HIDDEN_REASON_USER_DISMISSED)
            );
            assert!(row.10.is_some());

            let second =
                backfill_sessions_table(&connection).expect("second backfill should succeed");
            assert_eq!(second.created, 0);
            assert_eq!(second.updated, 1);
        });
    }

    #[test]
    fn backfill_sessions_table_creates_transcript_missing_agent_main_rows() {
        with_temp_storage_root("canonical-sessions-agent", |_root| {
            let connection = Connection::open_in_memory().expect("in-memory db should open");
            database::apply_migrations(&connection).expect("migrations should apply");

            seed_project(&connection, "project-1", "orchestra");
            let now = crate::state::now_iso();
            let session_id = Uuid::new_v4().to_string();
            connection
                .execute(
                    "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, scope, project_id, thinking_level, compaction_window, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES ('agent-1', 'agent-1', 'Agent 1', NULL, NULL, NULL, NULL, NULL, 'project', 'project-1', 'off', NULL, '[]', 0, 0, 0, ?1, ?1)",
                    params![now],
                )
                .expect("agent should seed");
            connection
                .execute(
                    "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-1', 'agent-1', 'idle', ?1, '/tmp/runtime', NULL, NULL, NULL, ?2, ?2)",
                    params![session_id, now],
                )
                .expect("agent runtime should seed");

            let report = backfill_sessions_table(&connection).expect("backfill should succeed");
            assert_eq!(report.created, 1);
            assert_eq!(report.transcript_missing, 1);

            let row = connection
                .query_row(
                    "SELECT project_id, session_kind, owner_worker_type, owner_worker_id, agent_id, transcript_exists, session_status, list_visibility FROM sessions WHERE id = ?1",
                    [session_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, i64>(5)?,
                            row.get::<_, String>(6)?,
                            row.get::<_, String>(7)?,
                        ))
                    },
                )
                .expect("agent canonical row should exist");
            assert_eq!(row.0, "project-1");
            assert_eq!(row.1, "agent_main");
            assert_eq!(row.2.as_deref(), Some("agent"));
            assert_eq!(row.3.as_deref(), Some("agent-1"));
            assert_eq!(row.4.as_deref(), Some("agent-1"));
            assert_eq!(row.5, 0);
            assert_eq!(row.6, "closed");
            assert_eq!(row.7, "closed");
        });
    }

    #[test]
    fn backfill_sessions_table_creates_stale_role_rows_without_transcripts() {
        with_temp_storage_root("canonical-sessions-role", |root| {
            let connection = Connection::open_in_memory().expect("in-memory db should open");
            database::apply_migrations(&connection).expect("migrations should apply");

            seed_project(&connection, "project-1", "orchestra");
            let now = crate::state::now_iso();
            let session_id = Uuid::new_v4().to_string();
            connection
                .execute(
                    "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, compaction_window, direct_permissions, archived, created_at, updated_at) VALUES ('role-1', 'role-1', 'Role 1', NULL, NULL, NULL, NULL, 'off', 1, NULL, '[]', 0, ?1, ?1)",
                    params![now],
                )
                .expect("role should seed");
            connection
                .execute(
                    "INSERT INTO role_instances (id, role_id, display_name, status, current_queue_entry_id, session_id, worktree_path, last_heartbeat_at, last_error, created_at, updated_at) VALUES ('instance-1', 'role-1', 'Role Instance 1', 'completed', NULL, ?1, ?2, NULL, NULL, ?3, ?3)",
                    params![session_id, project_root(&root, "orchestra").display().to_string(), now],
                )
                .expect("role instance should seed");

            let report = backfill_sessions_table(&connection).expect("backfill should succeed");
            assert_eq!(report.created, 1);
            assert_eq!(report.transcript_missing, 1);

            let row = connection
                .query_row(
                    "SELECT project_id, session_kind, owner_worker_type, owner_worker_id, role_id, role_instance_id, transcript_exists, list_visibility, hidden_reason FROM sessions WHERE id = ?1",
                    [session_id.as_str()],
                    |row| {
                        Ok((
                            row.get::<_, String>(0)?,
                            row.get::<_, String>(1)?,
                            row.get::<_, Option<String>>(2)?,
                            row.get::<_, Option<String>>(3)?,
                            row.get::<_, Option<String>>(4)?,
                            row.get::<_, Option<String>>(5)?,
                            row.get::<_, i64>(6)?,
                            row.get::<_, String>(7)?,
                            row.get::<_, Option<String>>(8)?,
                        ))
                    },
                )
                .expect("role canonical row should exist");
            assert_eq!(row.0, "project-1");
            assert_eq!(row.1, "role_instance");
            assert_eq!(row.2.as_deref(), Some("role"));
            assert_eq!(row.3.as_deref(), Some("role-1"));
            assert_eq!(row.4.as_deref(), Some("role-1"));
            assert_eq!(row.5.as_deref(), Some("instance-1"));
            assert_eq!(row.6, 0);
            assert_eq!(row.7, "hidden");
            assert_eq!(
                row.8.as_deref(),
                Some(session_list::SESSION_HIDDEN_REASON_STALE_ROLE_SESSION)
            );
        });
    }

    #[test]
    fn backfill_sessions_table_skips_rows_with_missing_project_foreign_key() {
        with_temp_storage_root("canonical-sessions-missing-project", |_root| {
            let connection = Connection::open_in_memory().expect("in-memory db should open");
            database::apply_migrations(&connection).expect("migrations should apply");

            seed_project(&connection, "project-1", "orchestra");
            seed_workflow(&connection, "workflow-1", "lane-1");
            let now = crate::state::now_iso();
            let session_id = Uuid::new_v4().to_string();
            connection
                .execute(
                    "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, compaction_window, direct_permissions, archived, created_at, updated_at) VALUES ('role-1', 'role-1', 'Role 1', NULL, NULL, NULL, NULL, 'off', 1, NULL, '[]', 0, ?1, ?1)",
                    params![now],
                )
                .expect("role should seed");
            connection
                .execute(
                    "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, auto_blocked_by_dependencies, archived, source_schedule_id, source_schedule_occurrence_id, created_at, updated_at) VALUES ('task-1', 'missing-project', 1, 'ORC-1', 'Task 1', NULL, 'task', 'in_progress', 'P1', 'workflow-1', 'lane-1', 'role', 'role-1', NULL, NULL, 10, 0, 0, NULL, NULL, ?1, ?1)",
                    params![now],
                )
                .expect("task should seed even with stale project id");
            connection
                .execute(
                    "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-1', 'workflow-1', 'lane-1', 'role', 'role-1', 'awaiting_user_approval', ?1, NULL, NULL, NULL, NULL, NULL, NULL, 0, NULL, ?2, NULL, ?2, ?2)",
                    params![session_id, now],
                )
                .expect("assignment should seed");
            connection
                .execute(
                    "INSERT INTO task_lane_runs (id, task_id, lane_id, session_id, result, notes, started_at, completed_at) VALUES ('lane-run-1', 'task-1', 'lane-1', ?1, 'needs_user', NULL, ?2, NULL)",
                    params![session_id, now],
                )
                .expect("lane run should seed");

            let report = backfill_sessions_table(&connection).expect("backfill should succeed");
            assert_eq!(report.created, 0);
            assert_eq!(report.updated, 0);
            assert_eq!(report.skipped_missing_project, 1);
            assert_eq!(
                connection
                    .query_row(
                        "SELECT COUNT(*) FROM sessions WHERE id = ?1",
                        [session_id.as_str()],
                        |row| row.get::<_, i64>(0),
                    )
                    .expect("session count should query"),
                0
            );
        });
    }
}
