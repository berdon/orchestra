use std::{
    fs,
    path::{Path, PathBuf},
};

use rusqlite::{params, Connection, OptionalExtension};

use crate::{
    models::SessionRecord,
    services::{orchestra_paths::infer_project_slug, pi_sessions},
    state::now_iso,
};

pub const SESSION_KIND_STANDALONE: &str = "standalone";
pub const SESSION_KIND_AGENT_MAIN: &str = "agent_main";
pub const SESSION_KIND_ROLE_INSTANCE: &str = "role_instance";
pub const SESSION_KIND_TASK_ASSIGNMENT: &str = "task_assignment";

pub const LIFECYCLE_ACTIVE: &str = "active";
pub const LIFECYCLE_CLOSED: &str = "closed";
pub const LIFECYCLE_ARCHIVED: &str = "archived";
pub const LIFECYCLE_SUPERSEDED: &str = "superseded";

#[derive(Debug, Clone, Copy)]
pub struct AgentRuntimeBinding<'a> {
    pub project_id: &'a str,
    pub agent_id: &'a str,
    pub runtime_cwd: Option<&'a str>,
    pub current_queue_entry_id: Option<&'a str>,
    pub status: &'a str,
    pub last_error: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct AssignmentBinding<'a> {
    pub assignment_id: &'a str,
    pub runtime_cwd: Option<&'a str>,
}

#[derive(Debug, Clone, Copy)]
pub struct CreateSessionRecordInput<'a> {
    pub project_id: Option<&'a str>,
    pub title: Option<&'a str>,
    pub session_kind: &'a str,
    pub agent_id: Option<&'a str>,
    pub role_instance_id: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub workflow_id: Option<&'a str>,
    pub lane_id: Option<&'a str>,
    pub assignment: Option<AssignmentBinding<'a>>,
    pub worker_type: Option<&'a str>,
    pub worker_id: Option<&'a str>,
    pub runtime_cwd: Option<&'a str>,
    pub subscribed: bool,
    pub agent_runtime: Option<AgentRuntimeBinding<'a>>,
    pub update_role_instance_session: bool,
}

pub type RotateSessionRecordInput<'a> = CreateSessionRecordInput<'a>;

#[derive(Debug, Clone)]
struct SessionSeed {
    session_id: String,
    session_path: PathBuf,
    title: String,
    created_at: String,
    project_id: Option<String>,
    runtime_cwd: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CanonicalSessionRow {
    pub id: String,
    pub project_id: Option<String>,
    pub project_slug: Option<String>,
    pub session_path: PathBuf,
    pub title: String,
    pub session_kind: String,
    pub session_status: String,
    pub list_visibility: String,
    pub hidden_reason: Option<String>,
    pub dismissed_at: Option<String>,
    pub task_id: Option<String>,
    pub workflow_id: Option<String>,
    pub lane_id: Option<String>,
    pub assignment_id: Option<String>,
    pub primary_task_id: Option<String>,
    pub primary_workflow_id: Option<String>,
    pub primary_lane_id: Option<String>,
    pub primary_assignment_id: Option<String>,
    pub worker_type: Option<String>,
    pub worker_id: Option<String>,
    pub owner_worker_type: Option<String>,
    pub owner_worker_id: Option<String>,
    pub agent_id: Option<String>,
    pub role_id: Option<String>,
    pub role_instance_id: Option<String>,
    pub runtime_cwd: Option<String>,
    pub transcript_cwd: Option<String>,
    pub transcript_exists: bool,
    pub lifecycle_state: String,
    pub created_at: String,
    pub updated_at: String,
    pub catalog_created_at: Option<String>,
    pub catalog_updated_at: Option<String>,
    pub catalog_status: Option<String>,
    pub catalog_title: Option<String>,
}

impl CanonicalSessionRow {
    pub fn effective_title(&self) -> String {
        normalized_non_empty(self.title.as_str())
            .or_else(|| self.catalog_title.clone())
            .unwrap_or_else(|| format!("Session {}", &self.id[..self.id.len().min(8)]))
    }

    pub fn effective_status(&self) -> String {
        if self.lifecycle_state != LIFECYCLE_ACTIVE {
            return "closed".to_string();
        }
        self.catalog_status
            .clone()
            .unwrap_or_else(|| self.session_status.clone())
    }

    pub fn effective_created_at(&self) -> String {
        self.catalog_created_at
            .clone()
            .unwrap_or_else(|| self.created_at.clone())
    }

    pub fn effective_updated_at(&self) -> String {
        self.catalog_updated_at
            .clone()
            .unwrap_or_else(|| self.updated_at.clone())
    }

    pub fn effective_task_id(&self) -> Option<&str> {
        self.task_id.as_deref().or(self.primary_task_id.as_deref())
    }

    pub fn effective_workflow_id(&self) -> Option<&str> {
        self.workflow_id
            .as_deref()
            .or(self.primary_workflow_id.as_deref())
    }

    pub fn effective_lane_id(&self) -> Option<&str> {
        self.lane_id.as_deref().or(self.primary_lane_id.as_deref())
    }

    pub fn effective_assignment_id(&self) -> Option<&str> {
        self.assignment_id
            .as_deref()
            .or(self.primary_assignment_id.as_deref())
    }

    pub fn effective_worker_type(&self) -> Option<&str> {
        self.worker_type
            .as_deref()
            .or(self.owner_worker_type.as_deref())
    }

    pub fn effective_worker_id(&self) -> Option<&str> {
        self.worker_id
            .as_deref()
            .or(self.owner_worker_id.as_deref())
    }

    pub fn to_record(&self, subscribed: bool) -> SessionRecord {
        SessionRecord {
            id: self.id.clone(),
            title: self.effective_title(),
            status: self.effective_status(),
            created_at: self.effective_created_at(),
            updated_at: self.effective_updated_at(),
            subscribed,
            events: Vec::new(),
            terminal_attached: false,
            debug_info: None,
            task_id: None,
            task_project_id: None,
            task_number: None,
            task_title: None,
            active_task_id: None,
            active_task_project_id: None,
            active_task_number: None,
            active_task_title: None,
            worker_type: None,
            worker_name: None,
            list_visibility: None,
            messageability: None,
            control_capabilities: None,
            control_operation: None,
        }
    }
}

#[derive(Debug, Clone, Default)]
struct RepairSessionBindingSeed {
    project_id: Option<String>,
    session_kind: Option<String>,
    agent_id: Option<String>,
    role_instance_id: Option<String>,
    task_id: Option<String>,
    workflow_id: Option<String>,
    lane_id: Option<String>,
    assignment_id: Option<String>,
    worker_type: Option<String>,
    worker_id: Option<String>,
    runtime_cwd: Option<String>,
}

pub struct SessionContextBinding<'a> {
    pub project_id: Option<&'a str>,
    pub session_kind: Option<&'a str>,
    pub worker_type: Option<&'a str>,
    pub worker_id: Option<&'a str>,
    pub agent_id: Option<&'a str>,
    pub role_instance_id: Option<&'a str>,
    pub task_id: Option<&'a str>,
    pub workflow_id: Option<&'a str>,
    pub lane_id: Option<&'a str>,
    pub assignment_id: Option<&'a str>,
    pub runtime_cwd: Option<&'a Path>,
}

pub struct SessionCloseInput<'a> {
    pub project_id: Option<&'a str>,
    pub lifecycle_state: &'a str,
    pub clear_assignment_binding: bool,
    pub archive: bool,
}

pub fn create_session_record(
    connection: &Connection,
    project_root: &Path,
    session_dir: &Path,
    input: CreateSessionRecordInput<'_>,
) -> Result<pi_sessions::StoredSession, String> {
    let stored = pi_sessions::create_session_file_unindexed(
        project_root,
        session_dir,
        input.title,
        input.subscribed,
    )?;
    let project_slug = project_slug_for_session_dir(session_dir)?;
    let write_result = (|| {
        upsert_session_row(
            connection,
            SessionRowWrite {
                session_id: stored.record.id.as_str(),
                project_id: input.project_id,
                session_path: stored.path.as_path(),
                title: stored.record.title.as_str(),
                session_kind: input.session_kind,
                agent_id: input.agent_id,
                role_instance_id: input.role_instance_id,
                task_id: input.task_id,
                workflow_id: input.workflow_id,
                lane_id: input.lane_id,
                assignment_id: existing_assignment_id(
                    connection,
                    input
                        .assignment
                        .as_ref()
                        .map(|binding| binding.assignment_id),
                )?,
                worker_type: input.worker_type,
                worker_id: input.worker_id,
                runtime_cwd: input
                    .assignment
                    .as_ref()
                    .and_then(|binding| binding.runtime_cwd)
                    .or(input.runtime_cwd),
                lifecycle_state: LIFECYCLE_ACTIVE,
                supersedes_session_id: None,
                superseded_by_session_id: None,
                closed_at: None,
                archived_at: None,
                created_at: stored.record.created_at.as_str(),
                updated_at: stored.record.updated_at.as_str(),
            },
        )?;
        pi_sessions::index_stored_session(connection, &project_slug, &stored)?;
        apply_legacy_bindings(connection, &stored.record.id, &input)?;
        Ok::<_, String>(())
    })();

    if let Err(error) = write_result {
        let _ = connection.execute("DELETE FROM sessions WHERE id = ?1", [&stored.record.id]);
        let _ = pi_sessions::delete_session_file(session_dir, &stored.record.id);
        return Err(error);
    }

    Ok(stored)
}

pub fn rotate_session_record(
    connection: &Connection,
    project_root: &Path,
    session_dir: &Path,
    old_session_id: &str,
    input: RotateSessionRecordInput<'_>,
) -> Result<pi_sessions::StoredSession, String> {
    let old_seed = load_session_seed(
        connection,
        old_session_id,
        input.project_id,
        Some(input.session_kind),
    )?;
    let stored = create_session_record(connection, project_root, session_dir, input)?;
    let now = now_iso();

    connection
        .execute(
            "UPDATE sessions SET supersedes_session_id = ?2, updated_at = ?3 WHERE id = ?1",
            params![stored.record.id, old_session_id, now],
        )
        .map_err(|error| {
            format!(
                "Unable to link successor session {} to {}: {error}",
                stored.record.id, old_session_id
            )
        })?;

    upsert_session_row(
        connection,
        SessionRowWrite {
            session_id: old_seed.session_id.as_str(),
            project_id: old_seed.project_id.as_deref(),
            session_path: old_seed.session_path.as_path(),
            title: old_seed.title.as_str(),
            session_kind: input.session_kind,
            agent_id: None,
            role_instance_id: None,
            task_id: None,
            workflow_id: None,
            lane_id: None,
            assignment_id: None,
            worker_type: None,
            worker_id: None,
            runtime_cwd: old_seed.runtime_cwd.as_deref(),
            lifecycle_state: LIFECYCLE_SUPERSEDED,
            supersedes_session_id: None,
            superseded_by_session_id: Some(stored.record.id.as_str()),
            closed_at: Some(now.as_str()),
            archived_at: None,
            created_at: old_seed.created_at.as_str(),
            updated_at: now.as_str(),
        },
    )?;

    Ok(stored)
}

pub fn bind_session_context(
    connection: &Connection,
    session_id: &str,
    binding: SessionContextBinding<'_>,
) -> Result<(), String> {
    let seed = load_session_seed(
        connection,
        session_id,
        binding.project_id,
        binding.session_kind,
    )?;
    let now = now_iso();
    let assignment_id = existing_assignment_id(connection, binding.assignment_id)?;
    let (transcript_exists, file_size, file_mtime_ms) =
        transcript_file_metadata(seed.session_path.as_path());
    connection
        .execute(
            r#"
            UPDATE sessions
            SET project_id = COALESCE(?2, project_id),
                session_path = ?3,
                transcript_path = ?3,
                title = ?4,
                session_kind = COALESCE(?5, session_kind),
                session_status = ?6,
                list_visibility = CASE
                    WHEN hidden_reason IS NOT NULL OR dismissed_at IS NOT NULL THEN 'hidden'
                    ELSE ?7
                END,
                agent_id = ?8,
                role_instance_id = ?9,
                task_id = ?10,
                workflow_id = ?11,
                lane_id = ?12,
                assignment_id = ?13,
                primary_task_id = ?10,
                primary_workflow_id = ?11,
                primary_lane_id = ?12,
                primary_assignment_id = ?13,
                worker_type = ?14,
                worker_id = ?15,
                owner_worker_type = ?14,
                owner_worker_id = ?15,
                runtime_cwd = COALESCE(?16, runtime_cwd),
                transcript_cwd = COALESCE(?16, transcript_cwd),
                lifecycle_state = ?17,
                transcript_exists = ?18,
                file_size = ?19,
                file_mtime_ms = ?20,
                last_indexed_at = ?21,
                last_seen_at = ?21,
                updated_at = ?21,
                closed_at = NULL,
                archived_at = NULL
            WHERE id = ?1
            "#,
            params![
                session_id,
                seed.project_id,
                seed.session_path.display().to_string(),
                seed.title,
                binding.session_kind,
                session_status_for_lifecycle(LIFECYCLE_ACTIVE),
                list_visibility_for_lifecycle(LIFECYCLE_ACTIVE),
                binding.agent_id,
                binding.role_instance_id,
                binding.task_id,
                binding.workflow_id,
                binding.lane_id,
                assignment_id,
                binding.worker_type,
                binding.worker_id,
                binding.runtime_cwd.map(|path| path.display().to_string()),
                LIFECYCLE_ACTIVE,
                if transcript_exists { 1 } else { 0 },
                file_size,
                file_mtime_ms,
                now,
            ],
        )
        .map_err(|error| format!("Unable to bind canonical session row {session_id}: {error}"))?;
    Ok(())
}

pub fn close_session_context(
    connection: &Connection,
    session_id: &str,
    input: SessionCloseInput<'_>,
) -> Result<(), String> {
    let seed = load_session_seed(connection, session_id, input.project_id, None)?;
    let now = now_iso();
    let archived_at = if input.archive {
        Some(now.clone())
    } else {
        None
    };
    let (primary_task_id, primary_workflow_id, primary_lane_id, primary_assignment_id) =
        current_session_binding(connection, session_id)?;
    let (task_id, workflow_id, lane_id, assignment_id) = if input.clear_assignment_binding {
        (
            None::<String>,
            None::<String>,
            None::<String>,
            None::<String>,
        )
    } else {
        (
            primary_task_id.clone(),
            primary_workflow_id.clone(),
            primary_lane_id.clone(),
            primary_assignment_id.clone(),
        )
    };
    let (transcript_exists, file_size, file_mtime_ms) =
        transcript_file_metadata(seed.session_path.as_path());
    connection
        .execute(
            r#"
            UPDATE sessions
            SET project_id = COALESCE(?2, project_id),
                session_path = ?3,
                transcript_path = ?3,
                title = ?4,
                task_id = ?5,
                workflow_id = ?6,
                lane_id = ?7,
                assignment_id = ?8,
                primary_task_id = ?9,
                primary_workflow_id = ?10,
                primary_lane_id = ?11,
                primary_assignment_id = ?12,
                session_status = ?13,
                list_visibility = CASE
                    WHEN hidden_reason IS NOT NULL OR dismissed_at IS NOT NULL THEN 'hidden'
                    ELSE ?14
                END,
                lifecycle_state = ?15,
                transcript_exists = ?16,
                file_size = ?17,
                file_mtime_ms = ?18,
                last_indexed_at = ?19,
                last_seen_at = ?19,
                updated_at = ?19,
                closed_at = ?20,
                archived_at = COALESCE(?21, archived_at)
            WHERE id = ?1
            "#,
            params![
                session_id,
                seed.project_id,
                seed.session_path.display().to_string(),
                seed.title,
                task_id,
                workflow_id,
                lane_id,
                assignment_id,
                primary_task_id,
                primary_workflow_id,
                primary_lane_id,
                primary_assignment_id,
                session_status_for_lifecycle(input.lifecycle_state),
                list_visibility_for_lifecycle(input.lifecycle_state),
                input.lifecycle_state,
                if transcript_exists { 1 } else { 0 },
                file_size,
                file_mtime_ms,
                now,
                now,
                archived_at,
            ],
        )
        .map_err(|error| format!("Unable to close canonical session row {session_id}: {error}"))?;
    Ok(())
}

pub fn close_active_assignment_session(
    connection: &Connection,
    session_id: &str,
    project_id: Option<&str>,
    archive: bool,
) -> Result<(), String> {
    close_session_context(
        connection,
        session_id,
        SessionCloseInput {
            project_id,
            lifecycle_state: if archive {
                LIFECYCLE_ARCHIVED
            } else {
                LIFECYCLE_CLOSED
            },
            clear_assignment_binding: true,
            archive,
        },
    )
}

fn normalized_non_empty(value: &str) -> Option<String> {
    let trimmed = value.trim();
    (!trimmed.is_empty()).then(|| trimmed.to_string())
}

fn map_canonical_session_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<CanonicalSessionRow> {
    Ok(CanonicalSessionRow {
        id: row.get::<_, String>(0)?,
        project_id: row.get::<_, Option<String>>(1)?,
        project_slug: row.get::<_, Option<String>>(2)?,
        session_path: PathBuf::from(row.get::<_, String>(3)?),
        title: row.get::<_, String>(4)?,
        session_kind: row.get::<_, String>(5)?,
        session_status: row.get::<_, String>(6)?,
        list_visibility: row.get::<_, String>(7)?,
        hidden_reason: row.get::<_, Option<String>>(8)?,
        dismissed_at: row.get::<_, Option<String>>(9)?,
        task_id: row.get::<_, Option<String>>(10)?,
        workflow_id: row.get::<_, Option<String>>(11)?,
        lane_id: row.get::<_, Option<String>>(12)?,
        assignment_id: row.get::<_, Option<String>>(13)?,
        primary_task_id: row.get::<_, Option<String>>(14)?,
        primary_workflow_id: row.get::<_, Option<String>>(15)?,
        primary_lane_id: row.get::<_, Option<String>>(16)?,
        primary_assignment_id: row.get::<_, Option<String>>(17)?,
        worker_type: row.get::<_, Option<String>>(18)?,
        worker_id: row.get::<_, Option<String>>(19)?,
        owner_worker_type: row.get::<_, Option<String>>(20)?,
        owner_worker_id: row.get::<_, Option<String>>(21)?,
        agent_id: row.get::<_, Option<String>>(22)?,
        role_id: row.get::<_, Option<String>>(23)?,
        role_instance_id: row.get::<_, Option<String>>(24)?,
        runtime_cwd: row.get::<_, Option<String>>(25)?,
        transcript_cwd: row.get::<_, Option<String>>(26)?,
        transcript_exists: row.get::<_, i64>(27)? != 0,
        lifecycle_state: row.get::<_, String>(28)?,
        created_at: row.get::<_, String>(29)?,
        updated_at: row.get::<_, String>(30)?,
        catalog_created_at: row.get::<_, Option<String>>(31)?,
        catalog_updated_at: row.get::<_, Option<String>>(32)?,
        catalog_status: row.get::<_, Option<String>>(33)?,
        catalog_title: row.get::<_, Option<String>>(34)?,
    })
}

fn canonical_session_row_query() -> &'static str {
    r#"
    SELECT
        s.id,
        s.project_id,
        p.slug,
        COALESCE(NULLIF(s.session_path, ''), s.transcript_path),
        s.title,
        s.session_kind,
        s.session_status,
        s.list_visibility,
        s.hidden_reason,
        s.dismissed_at,
        s.task_id,
        s.workflow_id,
        s.lane_id,
        s.assignment_id,
        s.primary_task_id,
        s.primary_workflow_id,
        s.primary_lane_id,
        s.primary_assignment_id,
        s.worker_type,
        s.worker_id,
        s.owner_worker_type,
        s.owner_worker_id,
        s.agent_id,
        s.role_id,
        s.role_instance_id,
        COALESCE(s.runtime_cwd, s.transcript_cwd),
        s.transcript_cwd,
        s.transcript_exists,
        s.lifecycle_state,
        s.created_at,
        s.updated_at,
        sc.created_at,
        sc.updated_at,
        sc.status,
        sc.title
    FROM sessions s
    LEFT JOIN projects p ON p.id = s.project_id
    LEFT JOIN session_catalog sc ON sc.session_id = s.id
    "#
}

pub fn load_session_row(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<CanonicalSessionRow>, String> {
    let query = format!("{} WHERE s.id = ?1 LIMIT 1", canonical_session_row_query());
    connection
        .query_row(query.as_str(), [session_id], map_canonical_session_row)
        .optional()
        .map_err(|error| format!("Unable to load canonical session row {session_id}: {error}"))
}

pub fn list_session_rows(
    connection: &Connection,
    project_id: Option<&str>,
    session_dir: Option<&Path>,
) -> Result<Vec<CanonicalSessionRow>, String> {
    let query = format!(
        "{} ORDER BY COALESCE(sc.updated_at, s.updated_at) DESC, s.id DESC",
        canonical_session_row_query()
    );
    let mut statement = connection
        .prepare(query.as_str())
        .map_err(|error| format!("Unable to prepare canonical session list query: {error}"))?;
    let rows = statement
        .query_map([], map_canonical_session_row)
        .map_err(|error| format!("Unable to query canonical sessions: {error}"))?;
    let mut rows = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read canonical session rows: {error}"))?;

    if project_id.is_none() && session_dir.is_none() {
        return Ok(rows);
    }

    let session_dir = session_dir.map(Path::to_path_buf);
    rows.retain(|row| {
        let project_matches =
            project_id.is_none_or(|project_id| row.project_id.as_deref() == Some(project_id));
        let path_matches = session_dir
            .as_ref()
            .is_none_or(|session_dir| row.session_path.starts_with(session_dir));
        project_matches || path_matches
    });
    Ok(rows)
}

pub fn candidate_project_slugs_for_session(
    connection: &Connection,
    session_id: &str,
) -> Result<Vec<String>, String> {
    let mut slugs = Vec::<String>::new();
    let mut push_slug = |slug: Option<String>| {
        if let Some(slug) = slug.filter(|slug| !slug.trim().is_empty()) {
            if !slugs.contains(&slug) {
                slugs.push(slug);
            }
        }
    };

    if let Some(row) = load_session_row(connection, session_id)? {
        push_slug(row.project_slug);
    }

    let assignment_slug = connection
        .query_row(
            r#"
            SELECT p.slug
            FROM task_lane_assignments tla
            LEFT JOIN tasks t ON t.id = tla.task_id
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE tla.session_id = ?1
            ORDER BY
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
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query assignment project slug for {session_id}: {error}")
        })?
        .flatten();
    push_slug(assignment_slug);

    let lane_run_slug = connection
        .query_row(
            r#"
            SELECT p.slug
            FROM task_lane_runs lr
            LEFT JOIN tasks t ON t.id = lr.task_id
            LEFT JOIN projects p ON p.id = t.project_id
            WHERE lr.session_id = ?1
            ORDER BY COALESCE(lr.completed_at, lr.started_at) DESC, lr.id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query lane-run project slug for {session_id}: {error}")
        })?
        .flatten();
    push_slug(lane_run_slug);

    let runtime_slug = connection
        .query_row(
            r#"
            SELECT p.slug
            FROM agent_runtime_states ars
            LEFT JOIN projects p ON p.id = ars.project_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query agent runtime project slug for {session_id}: {error}")
        })?
        .flatten();
    push_slug(runtime_slug);

    let role_worktree = connection
        .query_row(
            "SELECT worktree_path FROM role_instances WHERE session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to query role instance worktree for {session_id}: {error}")
        })?
        .flatten();
    push_slug(
        role_worktree
            .as_deref()
            .map(Path::new)
            .map(infer_project_slug),
    );

    Ok(slugs)
}

struct SessionRowWrite<'a> {
    session_id: &'a str,
    project_id: Option<&'a str>,
    session_path: &'a Path,
    title: &'a str,
    session_kind: &'a str,
    agent_id: Option<&'a str>,
    role_instance_id: Option<&'a str>,
    task_id: Option<&'a str>,
    workflow_id: Option<&'a str>,
    lane_id: Option<&'a str>,
    assignment_id: Option<&'a str>,
    worker_type: Option<&'a str>,
    worker_id: Option<&'a str>,
    runtime_cwd: Option<&'a str>,
    lifecycle_state: &'a str,
    supersedes_session_id: Option<&'a str>,
    superseded_by_session_id: Option<&'a str>,
    closed_at: Option<&'a str>,
    archived_at: Option<&'a str>,
    created_at: &'a str,
    updated_at: &'a str,
}

fn upsert_session_row(connection: &Connection, row: SessionRowWrite<'_>) -> Result<(), String> {
    let transcript_path = row.session_path.display().to_string();
    let project_id = existing_project_id(connection, row.project_id)?;
    let task_id = existing_task_id(connection, row.task_id)?;
    let workflow_id = existing_workflow_id(connection, row.workflow_id)?;
    let lane_id = existing_lane_id(connection, workflow_id, row.lane_id)?;
    let assignment_id = existing_assignment_id(connection, row.assignment_id)?;
    let role_instance_id = existing_role_instance_id(connection, row.role_instance_id)?;
    let role_id = existing_role_id(connection, role_instance_id)?;
    let (transcript_exists, file_size, file_mtime_ms) = transcript_file_metadata(row.session_path);
    let last_indexed_at = transcript_exists.then_some(row.updated_at);

    connection
        .execute(
            r#"
            INSERT INTO sessions (
                id,
                project_id,
                session_path,
                transcript_path,
                title,
                session_kind,
                session_status,
                list_visibility,
                hidden_reason,
                dismissed_at,
                first_seen_at,
                last_seen_at,
                agent_id,
                role_id,
                role_instance_id,
                task_id,
                workflow_id,
                lane_id,
                assignment_id,
                primary_task_id,
                primary_workflow_id,
                primary_lane_id,
                primary_assignment_id,
                worker_type,
                worker_id,
                owner_worker_type,
                owner_worker_id,
                runtime_cwd,
                transcript_cwd,
                transcript_exists,
                file_size,
                file_mtime_ms,
                last_indexed_at,
                lifecycle_state,
                supersedes_session_id,
                superseded_by_session_id,
                closed_at,
                archived_at,
                created_at,
                updated_at
            )
            VALUES (
                ?1, ?2, ?3, ?3, ?4, ?5, ?6, ?7, NULL, NULL, ?8, ?9, ?10, ?11, ?12,
                ?13, ?14, ?15, ?16, ?13, ?14, ?15, ?16, ?17, ?18, ?17, ?18, ?19,
                ?19, ?20, ?21, ?22, ?23, ?24, ?25, ?26, ?27, ?28, ?8, ?9
            )
            ON CONFLICT(id) DO UPDATE SET
                project_id = COALESCE(excluded.project_id, sessions.project_id),
                session_path = excluded.session_path,
                transcript_path = excluded.transcript_path,
                title = excluded.title,
                session_kind = COALESCE(excluded.session_kind, sessions.session_kind),
                session_status = excluded.session_status,
                list_visibility = CASE
                    WHEN sessions.hidden_reason IS NOT NULL OR sessions.dismissed_at IS NOT NULL THEN 'hidden'
                    ELSE excluded.list_visibility
                END,
                agent_id = COALESCE(excluded.agent_id, sessions.agent_id),
                role_id = COALESCE(excluded.role_id, sessions.role_id),
                role_instance_id = COALESCE(excluded.role_instance_id, sessions.role_instance_id),
                task_id = excluded.task_id,
                workflow_id = excluded.workflow_id,
                lane_id = excluded.lane_id,
                assignment_id = excluded.assignment_id,
                primary_task_id = excluded.primary_task_id,
                primary_workflow_id = excluded.primary_workflow_id,
                primary_lane_id = excluded.primary_lane_id,
                primary_assignment_id = excluded.primary_assignment_id,
                worker_type = COALESCE(excluded.worker_type, sessions.worker_type),
                worker_id = COALESCE(excluded.worker_id, sessions.worker_id),
                owner_worker_type = COALESCE(excluded.owner_worker_type, sessions.owner_worker_type),
                owner_worker_id = COALESCE(excluded.owner_worker_id, sessions.owner_worker_id),
                runtime_cwd = COALESCE(excluded.runtime_cwd, sessions.runtime_cwd),
                transcript_cwd = COALESCE(excluded.transcript_cwd, sessions.transcript_cwd),
                transcript_exists = excluded.transcript_exists,
                file_size = excluded.file_size,
                file_mtime_ms = excluded.file_mtime_ms,
                last_indexed_at = excluded.last_indexed_at,
                lifecycle_state = excluded.lifecycle_state,
                supersedes_session_id = COALESCE(excluded.supersedes_session_id, sessions.supersedes_session_id),
                superseded_by_session_id = COALESCE(excluded.superseded_by_session_id, sessions.superseded_by_session_id),
                last_seen_at = excluded.last_seen_at,
                updated_at = excluded.updated_at,
                closed_at = excluded.closed_at,
                archived_at = excluded.archived_at
            "#,
            params![
                row.session_id,
                project_id,
                transcript_path,
                row.title,
                row.session_kind,
                session_status_for_lifecycle(row.lifecycle_state),
                list_visibility_for_lifecycle(row.lifecycle_state),
                row.created_at,
                row.updated_at,
                row.agent_id,
                role_id,
                role_instance_id,
                task_id,
                workflow_id,
                lane_id,
                assignment_id,
                row.worker_type,
                row.worker_id,
                row.runtime_cwd,
                if transcript_exists { 1 } else { 0 },
                file_size,
                file_mtime_ms,
                last_indexed_at,
                row.lifecycle_state,
                row.supersedes_session_id,
                row.superseded_by_session_id,
                row.closed_at,
                row.archived_at,
            ],
        )
        .map_err(|error| format!("Unable to upsert canonical session row {}: {error}", row.session_id))?;
    Ok(())
}

fn apply_legacy_bindings(
    connection: &Connection,
    session_id: &str,
    input: &CreateSessionRecordInput<'_>,
) -> Result<(), String> {
    if let Some(agent_runtime) = input.agent_runtime {
        let _ = crate::services::agent_runtime::update_agent_runtime_dispatch_state_for_project(
            connection,
            agent_runtime.project_id,
            agent_runtime.agent_id,
            Some(session_id),
            agent_runtime.runtime_cwd,
            agent_runtime.current_queue_entry_id,
            if agent_runtime.status.is_empty() {
                "idle"
            } else {
                agent_runtime.status
            },
            agent_runtime.last_error,
        )?;
    }

    if input.update_role_instance_session {
        if let Some(role_instance_id) = input.role_instance_id {
            connection
                .execute(
                    "UPDATE role_instances SET session_id = ?2, updated_at = ?3 WHERE id = ?1",
                    params![role_instance_id, session_id, now_iso()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to update role instance {} to session {}: {error}",
                        role_instance_id, session_id
                    )
                })?;
        }
    }

    Ok(())
}

fn existing_project_id<'a>(
    connection: &Connection,
    project_id: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let Some(project_id) = project_id else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM projects WHERE id = ?1 LIMIT 1",
            [project_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Unable to validate project binding {project_id}: {error}"))?
        .is_some();
    Ok(exists.then_some(project_id))
}

fn existing_task_id<'a>(
    connection: &Connection,
    task_id: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let Some(task_id) = task_id else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM tasks WHERE id = ?1 LIMIT 1",
            [task_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Unable to validate task binding {task_id}: {error}"))?
        .is_some();
    Ok(exists.then_some(task_id))
}

fn existing_workflow_id<'a>(
    connection: &Connection,
    workflow_id: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let Some(workflow_id) = workflow_id else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM workflows WHERE id = ?1 LIMIT 1",
            [workflow_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Unable to validate workflow binding {workflow_id}: {error}"))?
        .is_some();
    Ok(exists.then_some(workflow_id))
}

fn existing_lane_id<'a>(
    connection: &Connection,
    workflow_id: Option<&str>,
    lane_id: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let (Some(workflow_id), Some(lane_id)) = (workflow_id, lane_id) else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM workflow_lanes WHERE workflow_id = ?1 AND id = ?2 LIMIT 1",
            params![workflow_id, lane_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to validate workflow lane binding {workflow_id}/{lane_id}: {error}")
        })?
        .is_some();
    Ok(exists.then_some(lane_id))
}

fn existing_role_instance_id<'a>(
    connection: &Connection,
    role_instance_id: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let Some(role_instance_id) = role_instance_id else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM role_instances WHERE id = ?1 LIMIT 1",
            [role_instance_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to validate role instance binding {role_instance_id}: {error}")
        })?
        .is_some();
    Ok(exists.then_some(role_instance_id))
}

fn existing_assignment_id<'a>(
    connection: &Connection,
    assignment_id: Option<&'a str>,
) -> Result<Option<&'a str>, String> {
    let Some(assignment_id) = assignment_id else {
        return Ok(None);
    };
    let exists = connection
        .query_row(
            "SELECT 1 FROM task_lane_assignments WHERE id = ?1 LIMIT 1",
            [assignment_id],
            |_| Ok(()),
        )
        .optional()
        .map_err(|error| format!("Unable to validate assignment binding {assignment_id}: {error}"))?
        .is_some();
    Ok(exists.then_some(assignment_id))
}

fn existing_role_id(
    connection: &Connection,
    role_instance_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(role_instance_id) = role_instance_id else {
        return Ok(None);
    };
    connection
        .query_row(
            "SELECT role_id FROM role_instances WHERE id = ?1 LIMIT 1",
            [role_instance_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to resolve role binding for instance {role_instance_id}: {error}")
        })
}

fn session_status_for_lifecycle(lifecycle_state: &str) -> &'static str {
    if lifecycle_state == LIFECYCLE_ACTIVE {
        "active"
    } else {
        "closed"
    }
}

fn list_visibility_for_lifecycle(lifecycle_state: &str) -> &'static str {
    if lifecycle_state == LIFECYCLE_ACTIVE {
        "active"
    } else {
        "closed"
    }
}

fn transcript_file_metadata(session_path: &Path) -> (bool, Option<i64>, Option<i64>) {
    let Ok(metadata) = fs::metadata(session_path) else {
        return (false, None, None);
    };

    let file_mtime_ms = metadata
        .modified()
        .ok()
        .and_then(|modified| modified.duration_since(std::time::UNIX_EPOCH).ok())
        .map(|duration| duration.as_millis() as i64);

    (true, Some(metadata.len() as i64), file_mtime_ms)
}

fn project_id_for_slug(
    connection: &Connection,
    project_slug: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT id FROM projects WHERE slug = ?1 LIMIT 1",
            [project_slug],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve project id for slug {project_slug}: {error}"))
}

fn build_repair_binding_seed(
    connection: &Connection,
    session_id: &str,
    project_id_override: Option<&str>,
    session_kind_override: Option<&str>,
    existing: Option<&CanonicalSessionRow>,
) -> Result<RepairSessionBindingSeed, String> {
    let mut seed = RepairSessionBindingSeed {
        project_id: project_id_override
            .map(str::to_string)
            .or_else(|| existing.and_then(|row| row.project_id.clone())),
        session_kind: session_kind_override
            .map(str::to_string)
            .or_else(|| existing.map(|row| row.session_kind.clone())),
        agent_id: existing.and_then(|row| row.agent_id.clone()),
        role_instance_id: existing.and_then(|row| row.role_instance_id.clone()),
        task_id: existing.and_then(|row| row.task_id.clone().or(row.primary_task_id.clone())),
        workflow_id: existing
            .and_then(|row| row.workflow_id.clone().or(row.primary_workflow_id.clone())),
        lane_id: existing.and_then(|row| row.lane_id.clone().or(row.primary_lane_id.clone())),
        assignment_id: existing.and_then(|row| {
            row.assignment_id
                .clone()
                .or(row.primary_assignment_id.clone())
        }),
        worker_type: existing
            .and_then(|row| row.worker_type.clone().or(row.owner_worker_type.clone())),
        worker_id: existing.and_then(|row| row.worker_id.clone().or(row.owner_worker_id.clone())),
        runtime_cwd: existing
            .and_then(|row| row.runtime_cwd.clone().or(row.transcript_cwd.clone())),
    };

    if let Some((
        assignment_id,
        task_id,
        project_id,
        workflow_id,
        lane_id,
        worker_type,
        worker_id,
        role_instance_id,
        runtime_cwd,
    )) = connection
        .query_row(
            r#"
            SELECT tla.id, tla.task_id, t.project_id, tla.workflow_id, tla.lane_id,
                   tla.worker_type, tla.worker_id, tla.role_instance_id, tla.runtime_cwd
            FROM task_lane_assignments tla
            LEFT JOIN tasks t ON t.id = tla.task_id
            WHERE tla.session_id = ?1
            ORDER BY
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
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, Option<String>>(8)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to load assignment repair seed for {session_id}: {error}")
        })?
    {
        seed.project_id = seed.project_id.or(project_id);
        seed.session_kind = seed
            .session_kind
            .or_else(|| Some(SESSION_KIND_TASK_ASSIGNMENT.to_string()));
        seed.task_id = seed.task_id.or(task_id);
        seed.workflow_id = seed.workflow_id.or(workflow_id);
        seed.lane_id = seed.lane_id.or(lane_id);
        seed.assignment_id = seed.assignment_id.or(Some(assignment_id));
        seed.worker_type = seed.worker_type.or(worker_type);
        seed.worker_id = seed.worker_id.or(worker_id);
        seed.role_instance_id = seed.role_instance_id.or(role_instance_id);
        seed.runtime_cwd = seed.runtime_cwd.or(runtime_cwd);
    }

    if let Some((task_id, project_id, workflow_id, lane_id)) = connection
        .query_row(
            r#"
            SELECT lr.task_id, t.project_id, t.workflow_id, lr.lane_id
            FROM task_lane_runs lr
            LEFT JOIN tasks t ON t.id = lr.task_id
            WHERE lr.session_id = ?1
            ORDER BY COALESCE(lr.completed_at, lr.started_at) DESC, lr.id DESC
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                    row.get::<_, Option<String>>(3)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load lane-run repair seed for {session_id}: {error}"))?
    {
        seed.project_id = seed.project_id.or(project_id);
        seed.task_id = seed.task_id.or(task_id);
        seed.workflow_id = seed.workflow_id.or(workflow_id);
        seed.lane_id = seed.lane_id.or(lane_id);
    }

    if let Some((project_id, agent_id, runtime_cwd)) = connection
        .query_row(
            "SELECT project_id, agent_id, runtime_cwd FROM agent_runtime_states WHERE main_session_id = ?1 LIMIT 1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, Option<String>>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load agent runtime repair seed for {session_id}: {error}"))?
    {
        seed.project_id = seed.project_id.or(project_id);
        seed.agent_id = seed.agent_id.or(agent_id.clone());
        if seed.assignment_id.is_none() {
            seed.session_kind = seed
                .session_kind
                .or_else(|| Some(SESSION_KIND_AGENT_MAIN.to_string()));
        }
        seed.worker_type = seed.worker_type.or_else(|| agent_id.as_ref().map(|_| "agent".to_string()));
        seed.worker_id = seed.worker_id.or(agent_id);
        seed.runtime_cwd = seed.runtime_cwd.or(runtime_cwd);
    }

    if let Some((role_instance_id, role_id, worktree_path)) = connection
        .query_row(
            "SELECT id, role_id, worktree_path FROM role_instances WHERE session_id = ?1 LIMIT 1",
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to load role-instance repair seed for {session_id}: {error}")
        })?
    {
        seed.role_instance_id = seed.role_instance_id.or(Some(role_instance_id));
        if seed.assignment_id.is_none() {
            seed.session_kind = seed
                .session_kind
                .or_else(|| Some(SESSION_KIND_ROLE_INSTANCE.to_string()));
        }
        seed.worker_type = seed
            .worker_type
            .or_else(|| role_id.as_ref().map(|_| "role".to_string()));
        seed.worker_id = seed.worker_id.or(role_id.clone());
        seed.runtime_cwd = seed.runtime_cwd.or(worktree_path.clone());
        if seed.project_id.is_none() {
            if let Some(slug) = worktree_path
                .as_deref()
                .map(Path::new)
                .map(infer_project_slug)
            {
                seed.project_id = project_id_for_slug(connection, &slug)?;
            }
        }
    }

    if seed.session_kind.is_none() {
        seed.session_kind = Some(SESSION_KIND_STANDALONE.to_string());
    }

    Ok(seed)
}

fn refresh_existing_session_row_from_transcript(
    connection: &Connection,
    existing: &CanonicalSessionRow,
    project_id_override: Option<&str>,
    session_path: &Path,
    stored: &pi_sessions::StoredSession,
) -> Result<(), String> {
    let transcript_cwd = pi_sessions::session_file_header_cwd(session_path)?
        .map(|path| path.display().to_string())
        .or_else(|| existing.runtime_cwd.clone())
        .or_else(|| existing.transcript_cwd.clone());
    let (transcript_exists, file_size, file_mtime_ms) = transcript_file_metadata(session_path);
    let effective_title = normalized_non_empty(stored.record.title.as_str())
        .unwrap_or_else(|| existing.effective_title());
    let effective_status = if existing.lifecycle_state == LIFECYCLE_ACTIVE {
        stored.record.status.as_str()
    } else {
        session_status_for_lifecycle(existing.lifecycle_state.as_str())
    };

    connection
        .execute(
            r#"
            UPDATE sessions
            SET project_id = COALESCE(?2, project_id),
                session_path = ?3,
                transcript_path = ?3,
                title = ?4,
                session_status = ?5,
                transcript_cwd = COALESCE(?6, transcript_cwd),
                transcript_exists = ?7,
                file_size = ?8,
                file_mtime_ms = ?9,
                last_indexed_at = ?10,
                updated_at = CASE WHEN updated_at > ?11 THEN updated_at ELSE ?11 END
            WHERE id = ?1
            "#,
            params![
                existing.id,
                project_id_override.or(existing.project_id.as_deref()),
                session_path.display().to_string(),
                effective_title,
                effective_status,
                transcript_cwd,
                if transcript_exists { 1 } else { 0 },
                file_size,
                file_mtime_ms,
                stored.record.updated_at.as_str(),
                stored.record.updated_at.as_str(),
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to refresh canonical session row {} from transcript: {error}",
                existing.id
            )
        })?;
    Ok(())
}

pub fn repair_session_row_from_transcript_path(
    connection: &Connection,
    session_id: &str,
    project_id_override: Option<&str>,
    session_kind_override: Option<&str>,
    session_path: &Path,
) -> Result<CanonicalSessionRow, String> {
    let stored = pi_sessions::summarize_session_for_catalog(session_path)?;
    if stored.record.id != session_id {
        return Err(format!(
            "Transcript {} belongs to {} instead of {session_id}",
            session_path.display(),
            stored.record.id
        ));
    }

    if let Some(existing) = load_session_row(connection, session_id)? {
        refresh_existing_session_row_from_transcript(
            connection,
            &existing,
            project_id_override,
            session_path,
            &stored,
        )?;
        return load_session_row(connection, session_id)?.ok_or_else(|| {
            format!("Canonical session row {session_id} disappeared after refresh")
        });
    }

    let seed = build_repair_binding_seed(
        connection,
        session_id,
        project_id_override,
        session_kind_override,
        None,
    )?;
    let transcript_cwd = pi_sessions::session_file_header_cwd(session_path)?
        .map(|path| path.display().to_string())
        .or(seed.runtime_cwd.clone());

    upsert_session_row(
        connection,
        SessionRowWrite {
            session_id,
            project_id: seed.project_id.as_deref(),
            session_path,
            title: stored.record.title.as_str(),
            session_kind: seed
                .session_kind
                .as_deref()
                .unwrap_or(SESSION_KIND_STANDALONE),
            agent_id: seed.agent_id.as_deref(),
            role_instance_id: seed.role_instance_id.as_deref(),
            task_id: seed.task_id.as_deref(),
            workflow_id: seed.workflow_id.as_deref(),
            lane_id: seed.lane_id.as_deref(),
            assignment_id: existing_assignment_id(connection, seed.assignment_id.as_deref())?,
            worker_type: seed.worker_type.as_deref(),
            worker_id: seed.worker_id.as_deref(),
            runtime_cwd: transcript_cwd.as_deref(),
            lifecycle_state: LIFECYCLE_ACTIVE,
            supersedes_session_id: None,
            superseded_by_session_id: None,
            closed_at: None,
            archived_at: None,
            created_at: stored.record.created_at.as_str(),
            updated_at: stored.record.updated_at.as_str(),
        },
    )?;

    connection
        .execute(
            "UPDATE sessions SET session_status = ?2, transcript_cwd = COALESCE(?3, transcript_cwd) WHERE id = ?1",
            params![session_id, stored.record.status.as_str(), transcript_cwd],
        )
        .map_err(|error| format!("Unable to finalize repaired session row {session_id}: {error}"))?;

    load_session_row(connection, session_id)?
        .ok_or_else(|| format!("Unable to reload repaired canonical session row {session_id}"))
}

fn current_session_binding(
    connection: &Connection,
    session_id: &str,
) -> Result<
    (
        Option<String>,
        Option<String>,
        Option<String>,
        Option<String>,
    ),
    String,
> {
    connection
        .query_row(
            "SELECT COALESCE(task_id, primary_task_id), COALESCE(workflow_id, primary_workflow_id), COALESCE(lane_id, primary_lane_id), COALESCE(assignment_id, primary_assignment_id) FROM sessions WHERE id = ?1",
            [session_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map(|row| row.unwrap_or((None, None, None, None)))
        .map_err(|error| format!("Unable to load canonical binding for {session_id}: {error}"))
}

fn load_session_seed(
    connection: &Connection,
    session_id: &str,
    project_id_override: Option<&str>,
    session_kind_override: Option<&str>,
) -> Result<SessionSeed, String> {
    if let Some(seed) = connection
        .query_row(
            "SELECT COALESCE(NULLIF(session_path, ''), transcript_path), title, created_at, project_id, COALESCE(runtime_cwd, transcript_cwd) FROM sessions WHERE id = ?1 LIMIT 1",
            [session_id],
            |row| {
                Ok(SessionSeed {
                    session_id: session_id.to_string(),
                    session_path: PathBuf::from(row.get::<_, String>(0)?),
                    title: row.get::<_, String>(1)?,
                    created_at: row.get::<_, String>(2)?,
                    project_id: project_id_override
                        .map(str::to_string)
                        .or(row.get::<_, Option<String>>(3)?),
                    runtime_cwd: row.get::<_, Option<String>>(4)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load canonical session seed for {session_id}: {error}"))?
    {
        return Ok(seed);
    }

    let context = pi_sessions::find_session_context_for_session(session_id)?;
    let record = pi_sessions::get_session(&context.session_dir, session_id, false)?;
    let session_path = pi_sessions::get_session_path(&context.session_dir, session_id)?;
    let runtime_cwd = seed_runtime_cwd(&record, &context.session_dir);

    upsert_session_row(
        connection,
        SessionRowWrite {
            session_id: record.id.as_str(),
            project_id: project_id_override,
            session_path: session_path.as_path(),
            title: record.title.as_str(),
            session_kind: session_kind_override.unwrap_or(SESSION_KIND_STANDALONE),
            agent_id: None,
            role_instance_id: None,
            task_id: None,
            workflow_id: None,
            lane_id: None,
            assignment_id: None,
            worker_type: None,
            worker_id: None,
            runtime_cwd: runtime_cwd.as_deref(),
            lifecycle_state: LIFECYCLE_ACTIVE,
            supersedes_session_id: None,
            superseded_by_session_id: None,
            closed_at: None,
            archived_at: None,
            created_at: record.created_at.as_str(),
            updated_at: record.updated_at.as_str(),
        },
    )?;

    Ok(SessionSeed {
        session_id: record.id,
        session_path,
        title: record.title,
        created_at: record.created_at,
        project_id: project_id_override.map(str::to_string),
        runtime_cwd,
    })
}

fn seed_runtime_cwd(record: &SessionRecord, session_dir: &Path) -> Option<String> {
    pi_sessions::get_session_header_cwd(session_dir, &record.id)
        .ok()
        .flatten()
        .map(|path| path.display().to_string())
}

fn project_slug_for_session_dir(session_dir: &Path) -> Result<String, String> {
    session_dir
        .parent()
        .and_then(|path| path.file_name())
        .and_then(|value| value.to_str())
        .map(str::to_string)
        .ok_or_else(|| {
            format!(
                "Unable to derive project slug from session directory {}",
                session_dir.display()
            )
        })
}

#[cfg(test)]
mod tests {
    use super::*;
    use rusqlite::Connection;
    use std::{
        env, fs,
        path::PathBuf,
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

    fn minimal_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory db should open");
        connection
            .execute_batch(
                r#"
            CREATE TABLE projects (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL UNIQUE,
                name TEXT NOT NULL,
                description TEXT,
                task_prefix TEXT NOT NULL,
                default_repository_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE tasks (
                id TEXT PRIMARY KEY,
                project_id TEXT NOT NULL,
                sequence_number INTEGER NOT NULL,
                number TEXT NOT NULL,
                title TEXT NOT NULL,
                description TEXT,
                task_type TEXT NOT NULL,
                status TEXT NOT NULL,
                priority TEXT NOT NULL,
                workflow_id TEXT,
                current_lane_id TEXT,
                assignee_type TEXT NOT NULL,
                assignee_id TEXT,
                repository_id TEXT,
                parent_task_id TEXT,
                whip_max_attempts INTEGER NOT NULL DEFAULT 10,
                auto_blocked_by_dependencies INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                source_schedule_id TEXT,
                source_schedule_occurrence_id TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE task_lane_assignments (
                id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                workflow_id TEXT NOT NULL,
                lane_id TEXT NOT NULL,
                worker_type TEXT NOT NULL,
                worker_id TEXT,
                status TEXT NOT NULL,
                session_id TEXT,
                runtime_cwd TEXT,
                role_queue_entry_id TEXT,
                role_instance_id TEXT,
                prompt TEXT,
                pending_outcome TEXT,
                completion_notes TEXT,
                whip_count INTEGER NOT NULL DEFAULT 0,
                last_whip_at TEXT,
                started_at TEXT NOT NULL,
                completed_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE role_instances (
                id TEXT PRIMARY KEY,
                role_id TEXT NOT NULL,
                display_name TEXT NOT NULL,
                status TEXT NOT NULL,
                current_queue_entry_id TEXT,
                session_id TEXT,
                worktree_path TEXT,
                last_heartbeat_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE agents (
                id TEXT PRIMARY KEY,
                slug TEXT NOT NULL,
                name TEXT NOT NULL,
                description TEXT,
                system_prompt TEXT,
                provider TEXT,
                model TEXT,
                role_id TEXT,
                scope TEXT NOT NULL DEFAULT 'global',
                project_id TEXT,
                thinking_level TEXT NOT NULL DEFAULT 'off',
                compaction_window TEXT,
                direct_permissions TEXT NOT NULL DEFAULT '[]',
                system INTEGER NOT NULL DEFAULT 0,
                immutable INTEGER NOT NULL DEFAULT 0,
                archived INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
            CREATE TABLE agent_runtime_states (
                project_id TEXT NOT NULL,
                agent_id TEXT NOT NULL,
                status TEXT NOT NULL,
                main_session_id TEXT,
                runtime_cwd TEXT,
                current_queue_entry_id TEXT,
                last_dispatch_at TEXT,
                last_error TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (project_id, agent_id)
            );
            CREATE TABLE session_catalog (
                session_id TEXT PRIMARY KEY,
                project_slug TEXT NOT NULL,
                session_path TEXT NOT NULL,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL,
                title TEXT NOT NULL,
                status TEXT NOT NULL,
                file_size INTEGER NOT NULL,
                file_mtime_ms INTEGER NOT NULL,
                last_indexed_at TEXT NOT NULL
            );
            CREATE TABLE sessions (
                id TEXT PRIMARY KEY,
                project_id TEXT,
                session_path TEXT NOT NULL UNIQUE,
                transcript_path TEXT,
                title TEXT NOT NULL,
                session_kind TEXT NOT NULL,
                session_status TEXT NOT NULL DEFAULT 'active',
                list_visibility TEXT NOT NULL DEFAULT 'active',
                hidden_reason TEXT,
                dismissed_at TEXT,
                first_seen_at TEXT NOT NULL DEFAULT '',
                last_seen_at TEXT NOT NULL DEFAULT '',
                owner_worker_type TEXT,
                owner_worker_id TEXT,
                agent_id TEXT,
                role_id TEXT,
                role_instance_id TEXT,
                task_id TEXT,
                workflow_id TEXT,
                lane_id TEXT,
                assignment_id TEXT,
                primary_task_id TEXT,
                primary_workflow_id TEXT,
                primary_lane_id TEXT,
                primary_assignment_id TEXT,
                worker_type TEXT,
                worker_id TEXT,
                runtime_cwd TEXT,
                transcript_cwd TEXT,
                transcript_exists INTEGER NOT NULL DEFAULT 1,
                file_size INTEGER,
                file_mtime_ms INTEGER,
                last_indexed_at TEXT,
                lifecycle_state TEXT NOT NULL DEFAULT 'active',
                supersedes_session_id TEXT,
                superseded_by_session_id TEXT,
                closed_at TEXT,
                archived_at TEXT,
                created_at TEXT NOT NULL,
                updated_at TEXT NOT NULL
            );
        "#,
            )
            .expect("minimal schema should create");
        connection
    }

    #[test]
    fn create_and_rotate_session_records_write_canonical_rows() {
        let root = unique_temp_dir("session-records-create-rotate");
        let project_root = root.join("project");
        let session_dir = root.join("project-1").join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");
        let connection = minimal_connection();
        connection.execute("INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'P', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        let runtime_cwd = project_root.to_string_lossy().into_owned();
        let created = create_session_record(
            &connection,
            &project_root,
            &session_dir,
            CreateSessionRecordInput {
                project_id: Some("project-1"),
                title: Some("Primary"),
                session_kind: SESSION_KIND_STANDALONE,
                agent_id: None,
                role_instance_id: None,
                task_id: None,
                workflow_id: None,
                lane_id: None,
                assignment: None,
                worker_type: None,
                worker_id: None,
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: None,
                update_role_instance_session: false,
            },
        )
        .unwrap();
        let rotated = rotate_session_record(
            &connection,
            &project_root,
            &session_dir,
            &created.record.id,
            RotateSessionRecordInput {
                project_id: Some("project-1"),
                title: Some("Primary"),
                session_kind: SESSION_KIND_STANDALONE,
                agent_id: None,
                role_instance_id: None,
                task_id: None,
                workflow_id: None,
                lane_id: None,
                assignment: None,
                worker_type: None,
                worker_id: None,
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: None,
                update_role_instance_session: false,
            },
        )
        .unwrap();
        let predecessor: (String, String, Option<String>) = connection.query_row(
            "SELECT lifecycle_state, superseded_by_session_id, closed_at FROM sessions WHERE id = ?1",
            [&created.record.id], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        ).unwrap();
        assert_eq!(predecessor.0, LIFECYCLE_SUPERSEDED);
        assert_eq!(predecessor.1, rotated.record.id);
        assert!(predecessor.2.is_some());
        let successor: (Option<String>, String) = connection
            .query_row(
                "SELECT supersedes_session_id, lifecycle_state FROM sessions WHERE id = ?1",
                [&rotated.record.id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(successor.0.as_deref(), Some(created.record.id.as_str()));
        assert_eq!(successor.1, LIFECYCLE_ACTIVE);
    }

    #[test]
    fn bind_and_close_session_context_updates_assignment_binding() {
        let root = unique_temp_dir("session-records-bind-close");
        let project_root = root.join("project");
        let session_dir = root.join("project-1").join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");
        let connection = minimal_connection();
        connection.execute("INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'P', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, auto_blocked_by_dependencies, archived, source_schedule_id, source_schedule_occurrence_id, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'P-1', 'Task 1', NULL, 'task', 'in_progress', 'P1', 'workflow-1', 'lane-1', 'agent', 'agent-1', NULL, NULL, 10, 0, 0, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        connection.execute("INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-1', 'workflow-1', 'lane-1', 'agent', 'agent-1', 'active', NULL, '/tmp/runtime', NULL, NULL, 'Prompt', NULL, NULL, 0, NULL, '2026-01-01T00:00:00Z', NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')", []).unwrap();
        let runtime_cwd = project_root.to_string_lossy().into_owned();
        let created = create_session_record(
            &connection,
            &project_root,
            &session_dir,
            CreateSessionRecordInput {
                project_id: Some("project-1"),
                title: Some("Worker"),
                session_kind: SESSION_KIND_STANDALONE,
                agent_id: None,
                role_instance_id: None,
                task_id: None,
                workflow_id: None,
                lane_id: None,
                assignment: None,
                worker_type: None,
                worker_id: None,
                runtime_cwd: Some(runtime_cwd.as_str()),
                subscribed: false,
                agent_runtime: None,
                update_role_instance_session: false,
            },
        )
        .unwrap();
        bind_session_context(
            &connection,
            &created.record.id,
            SessionContextBinding {
                project_id: Some("project-1"),
                session_kind: Some(SESSION_KIND_TASK_ASSIGNMENT),
                worker_type: Some("agent"),
                worker_id: Some("agent-1"),
                agent_id: None,
                role_instance_id: None,
                task_id: Some("task-1"),
                workflow_id: Some("workflow-1"),
                lane_id: Some("lane-1"),
                assignment_id: Some("assignment-1"),
                runtime_cwd: Some(&project_root),
            },
        )
        .unwrap();
        let bound: (Option<String>, Option<String>, Option<String>) = connection
            .query_row(
                "SELECT task_id, lane_id, assignment_id FROM sessions WHERE id = ?1",
                [&created.record.id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .unwrap();
        assert_eq!(bound.0.as_deref(), Some("task-1"));
        assert_eq!(bound.1.as_deref(), Some("lane-1"));
        assert_eq!(bound.2.as_deref(), Some("assignment-1"));
        close_active_assignment_session(&connection, &created.record.id, Some("project-1"), true)
            .unwrap();
        let closed: (
            String,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
            Option<String>,
        ) = connection.query_row(
            "SELECT lifecycle_state, task_id, assignment_id, primary_task_id, primary_assignment_id, archived_at FROM sessions WHERE id = ?1",
            [&created.record.id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        ).unwrap();
        assert_eq!(closed.0, LIFECYCLE_ARCHIVED);
        assert!(closed.1.is_none());
        assert!(closed.2.is_none());
        assert_eq!(closed.3.as_deref(), Some("task-1"));
        assert_eq!(closed.4.as_deref(), Some("assignment-1"));
        assert!(closed.5.is_some());
    }
}
