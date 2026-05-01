use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    thread,
    time::UNIX_EPOCH,
};

use chrono::{DateTime, TimeZone, Utc};
use rusqlite::{params, OptionalExtension};
use serde_json::{json, Value};
use uuid::Uuid;

use crate::{
    models::{
        SessionContextUsage, SessionEvent, SessionModel, SessionModelState, SessionRecord,
        SessionStats, SessionStreamEvent, SessionTokenUsage,
    },
    services::{
        database,
        orchestra_paths::{
            configured_project_root, default_orchestra_root, discover_dev_checkout_root,
            infer_project_slug, pi_agent_dir, project_session_dir, sanitize_slug,
        },
        projects, session_list, session_records,
    },
};

const DEFAULT_EMPTY_SESSION_MESSAGE: &str = "Real pi session ready. Send a message to begin.";
const PROMPT_REQUEST_ID: &str = "prompt-1";
const GET_STATE_REQUEST_ID: &str = "get-state-1";
const GET_MODELS_REQUEST_ID: &str = "get-models-1";
const GET_SESSION_STATS_REQUEST_ID: &str = "get-session-stats-1";
const SET_MODEL_REQUEST_ID: &str = "set-model-1";
const MISSING_BUN_MODEL_DISCOVERY_MESSAGE: &str = "Harness could not load package-based model sources because Bun is not available on PATH used for Orchestra subprocesses. Install Bun or remove those package sources in Settings → Harness.";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum ModelDiscoveryErrorKind {
    MissingBun,
}

#[derive(Debug, Clone)]
pub struct SessionContext {
    pub project_root: PathBuf,
    pub project_slug: String,
    pub orchestra_root: PathBuf,
    pub session_dir: PathBuf,
}

#[derive(Debug, Clone)]
pub struct StoredSession {
    pub path: PathBuf,
    pub record: SessionRecord,
}

#[derive(Debug, Clone)]
struct SessionCatalogEntry {
    session_id: String,
    project_slug: String,
    session_path: PathBuf,
    created_at: String,
    updated_at: String,
    title: String,
    status: String,
    file_size: u64,
    file_mtime_ms: i64,
}

#[derive(Debug, Default, Clone, Copy, PartialEq, Eq)]
struct SessionCatalogRefreshStats {
    parsed_files: usize,
    skipped_dismissed_files: usize,
    repaired_rows: usize,
    evicted_rows: usize,
}
fn resolve_context_project_root(project_slug: &str) -> Result<PathBuf, String> {
    if let Some(project_root) = configured_project_root() {
        return Ok(project_root);
    }

    let connection = database::open_connection()?;
    projects::resolve_project_runtime_root(&connection, project_slug)
}

pub fn detect_session_context(
    project_slug_override: Option<&str>,
) -> Result<SessionContext, String> {
    let project_slug = if let Some(project_slug) = project_slug_override {
        sanitize_slug(project_slug)
    } else if let Some(project_root) = configured_project_root() {
        infer_project_slug(&project_root)
    } else if let Some(project_root) = discover_dev_checkout_root() {
        infer_project_slug(&project_root)
    } else {
        let connection = database::open_connection()?;
        projects::resolve_default_project_slug(&connection)?
            .map(|slug| sanitize_slug(&slug))
            .unwrap_or_else(|| "orchestra".into())
    };

    let project_root = resolve_context_project_root(&project_slug)?;
    let orchestra_root = default_orchestra_root()?;
    let session_dir = project_session_dir(&orchestra_root, &project_slug);

    fs::create_dir_all(&session_dir).map_err(|error| {
        format!(
            "Unable to create session directory {}: {error}",
            session_dir.display()
        )
    })?;

    Ok(SessionContext {
        project_root,
        project_slug,
        orchestra_root,
        session_dir,
    })
}

pub fn session_context_for_project_id(project_id: &str) -> Result<SessionContext, String> {
    let connection = database::open_connection()?;
    let project = projects::get_project(&connection, project_id)?;
    detect_session_context(Some(&project.slug))
}

pub fn all_session_contexts() -> Result<Vec<SessionContext>, String> {
    let connection = database::open_connection()?;
    let projects = projects::list_projects(&connection)?;
    let mut contexts = Vec::new();
    let mut seen = HashSet::new();
    for project in projects {
        let context = detect_session_context(Some(&project.slug))?;
        let key = context.session_dir.display().to_string();
        if seen.insert(key) {
            contexts.push(context);
        }
    }
    Ok(contexts)
}

fn session_context_for_session_dir(session_dir: &Path) -> Option<SessionContext> {
    if session_dir.file_name().and_then(|value| value.to_str()) != Some("sessions") {
        return None;
    }
    let project_slug = session_dir.parent()?.file_name()?.to_str()?;
    let context = detect_session_context(Some(project_slug)).ok()?;
    if context.session_dir == session_dir {
        Some(context)
    } else {
        None
    }
}

fn canonical_session_context(
    row: &session_records::CanonicalSessionRow,
) -> Result<Option<SessionContext>, String> {
    if let Some(project_slug) = row.project_slug.as_deref() {
        if let Ok(context) = detect_session_context(Some(project_slug)) {
            return Ok(Some(context));
        }
    }
    if let Some(context) = row
        .session_path
        .parent()
        .and_then(session_context_for_session_dir)
    {
        return Ok(Some(context));
    }
    if let Some(project_id) = row.project_id.as_deref() {
        return session_context_for_project_id(project_id).map(Some);
    }
    Ok(None)
}

fn project_id_for_context(
    connection: &rusqlite::Connection,
    context: &SessionContext,
) -> Option<String> {
    projects::get_project_by_slug(connection, &context.project_slug)
        .ok()
        .flatten()
        .map(|project| project.id)
}

fn try_repair_session_from_path(
    connection: &rusqlite::Connection,
    session_id: &str,
    context: &SessionContext,
    path: &Path,
) -> Result<bool, String> {
    if !validate_catalog_session_path(path, session_id) {
        return Ok(false);
    }
    let project_id = project_id_for_context(connection, context);
    match session_records::repair_session_row_from_transcript_path(
        connection,
        session_id,
        project_id.as_deref(),
        None,
        path,
    ) {
        Ok(_) => match maybe_repair_session_catalog_entry(connection, context, path) {
            Ok(()) => Ok(true),
            Err(error)
                if error.contains("Unable to read session file")
                    || error.contains("Unable to inspect session file") =>
            {
                Ok(true)
            }
            Err(error) => Err(error),
        },
        Err(error)
            if error.contains("Unable to read session file")
                || error.contains("Unable to inspect session file") =>
        {
            Ok(false)
        }
        Err(error) => Err(error),
    }
}

fn repair_session_context_for_session(
    connection: &rusqlite::Connection,
    session_id: &str,
    existing_row: Option<&session_records::CanonicalSessionRow>,
) -> Result<Option<SessionContext>, String> {
    let mut candidate_contexts = Vec::<SessionContext>::new();
    let mut push_context = |context: Option<SessionContext>| {
        if let Some(context) = context {
            if !candidate_contexts
                .iter()
                .any(|existing| existing.session_dir == context.session_dir)
            {
                candidate_contexts.push(context);
            }
        }
    };

    if let Some(row) = existing_row {
        let context = canonical_session_context(row)?;
        push_context(context.clone());
        if let Some(context) = context {
            if try_repair_session_from_path(connection, session_id, &context, &row.session_path)? {
                return Ok(Some(context));
            }
        }
    }

    if let Some(entry) = load_session_catalog_entry(connection, session_id)? {
        if let Ok(context) = detect_session_context(Some(&entry.project_slug)) {
            if try_repair_session_from_path(connection, session_id, &context, &entry.session_path)?
            {
                return Ok(Some(context));
            }
            push_context(Some(context));
        }
    }

    for project_slug in
        session_records::candidate_project_slugs_for_session(connection, session_id)?
    {
        push_context(detect_session_context(Some(&project_slug)).ok());
    }

    for context in all_session_contexts()? {
        push_context(Some(context));
    }

    for context in candidate_contexts {
        if let Some(path) = discover_session_path_in_dir(&context.session_dir, session_id)? {
            if try_repair_session_from_path(connection, session_id, &context, &path)? {
                return Ok(Some(context));
            }
        }
    }

    Ok(None)
}

fn derive_session_id_from_path(path: &Path) -> Option<String> {
    let stem = path.file_stem()?.to_str()?;
    if Uuid::parse_str(stem).is_ok() {
        return Some(stem.to_string());
    }
    let (_, maybe_uuid) = stem.rsplit_once('_')?;
    if Uuid::parse_str(maybe_uuid).is_ok() {
        Some(maybe_uuid.to_string())
    } else {
        None
    }
}

pub(crate) fn session_file_fingerprint(path: &Path) -> Result<(u64, i64), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to inspect session file {}: {error}", path.display()))?;
    let file_size = metadata.len();
    let modified = metadata.modified().map_err(|error| {
        format!(
            "Unable to inspect session file modified time {}: {error}",
            path.display()
        )
    })?;
    let file_mtime_ms = modified
        .duration_since(UNIX_EPOCH)
        .map_err(|error| {
            format!(
                "Unable to normalize session file modified time {}: {error}",
                path.display()
            )
        })?
        .as_millis() as i64;
    Ok((file_size, file_mtime_ms))
}

fn load_session_catalog_entry(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<SessionCatalogEntry>, String> {
    connection
        .query_row(
            r#"
            SELECT project_slug, session_path, created_at, updated_at, title, status, file_size, file_mtime_ms
            FROM session_catalog
            WHERE session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok(SessionCatalogEntry {
                    session_id: session_id.to_string(),
                    project_slug: row.get::<_, String>(0)?,
                    session_path: PathBuf::from(row.get::<_, String>(1)?),
                    created_at: row.get::<_, String>(2)?,
                    updated_at: row.get::<_, String>(3)?,
                    title: row.get::<_, String>(4)?,
                    status: row.get::<_, String>(5)?,
                    file_size: row.get::<_, i64>(6)? as u64,
                    file_mtime_ms: row.get::<_, i64>(7)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load session catalog entry {session_id}: {error}"))
}

fn load_session_catalog_entries_for_project(
    connection: &rusqlite::Connection,
    project_slug: &str,
) -> Result<Vec<SessionCatalogEntry>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT session_id, project_slug, session_path, created_at, updated_at, title, status, file_size, file_mtime_ms
            FROM session_catalog
            WHERE project_slug = ?1
            "#,
        )
        .map_err(|error| format!("Unable to prepare session catalog query for {project_slug}: {error}"))?;
    let rows = statement
        .query_map([project_slug], |row| {
            Ok(SessionCatalogEntry {
                session_id: row.get::<_, String>(0)?,
                project_slug: row.get::<_, String>(1)?,
                session_path: PathBuf::from(row.get::<_, String>(2)?),
                created_at: row.get::<_, String>(3)?,
                updated_at: row.get::<_, String>(4)?,
                title: row.get::<_, String>(5)?,
                status: row.get::<_, String>(6)?,
                file_size: row.get::<_, i64>(7)? as u64,
                file_mtime_ms: row.get::<_, i64>(8)?,
            })
        })
        .map_err(|error| format!("Unable to query session catalog for {project_slug}: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read session catalog for {project_slug}: {error}"))
}

fn upsert_session_catalog_entry(
    connection: &rusqlite::Connection,
    project_slug: &str,
    stored: &StoredSession,
) -> Result<(), String> {
    let (file_size, file_mtime_ms) = session_file_fingerprint(&stored.path)?;
    connection
        .execute(
            r#"
            INSERT INTO session_catalog (
                session_id, project_slug, session_path, created_at, updated_at,
                title, status, file_size, file_mtime_ms, last_indexed_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            ON CONFLICT(session_id) DO UPDATE SET
                project_slug = excluded.project_slug,
                session_path = excluded.session_path,
                created_at = excluded.created_at,
                updated_at = excluded.updated_at,
                title = excluded.title,
                status = excluded.status,
                file_size = excluded.file_size,
                file_mtime_ms = excluded.file_mtime_ms,
                last_indexed_at = excluded.last_indexed_at
            "#,
            params![
                stored.record.id,
                project_slug,
                stored.path.display().to_string(),
                stored.record.created_at,
                stored.record.updated_at,
                stored.record.title,
                stored.record.status,
                file_size as i64,
                file_mtime_ms,
                now_iso(),
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to upsert session catalog entry {}: {error}",
                stored.record.id
            )
        })?;
    Ok(())
}

fn remove_session_catalog_entry(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM session_catalog WHERE session_id = ?1",
            [session_id],
        )
        .map_err(|error| format!("Unable to delete session catalog entry {session_id}: {error}"))?;
    Ok(())
}

fn remove_session_catalog_entry_by_path(
    connection: &rusqlite::Connection,
    path: &Path,
) -> Result<(), String> {
    connection
        .execute(
            "DELETE FROM session_catalog WHERE session_path = ?1",
            [path.display().to_string()],
        )
        .map_err(|error| {
            format!(
                "Unable to delete session catalog entry for {}: {error}",
                path.display()
            )
        })?;
    Ok(())
}

fn session_record_from_catalog_entry(
    entry: &SessionCatalogEntry,
    subscribed_ids: &HashSet<String>,
) -> SessionRecord {
    SessionRecord {
        id: entry.session_id.clone(),
        title: entry.title.clone(),
        status: entry.status.clone(),
        created_at: entry.created_at.clone(),
        updated_at: entry.updated_at.clone(),
        subscribed: subscribed_ids.contains(&entry.session_id),
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

fn load_session_catalog_records(
    connection: &rusqlite::Connection,
    project_slug: &str,
    subscribed_ids: &HashSet<String>,
    dismissed_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    let mut entries = load_session_catalog_entries_for_project(connection, project_slug)?;
    entries.retain(|entry| !dismissed_ids.contains(&entry.session_id));
    entries.sort_by(|left, right| right.updated_at.cmp(&left.updated_at));
    Ok(entries
        .into_iter()
        .map(|entry| session_record_from_catalog_entry(&entry, subscribed_ids))
        .collect())
}

fn validate_catalog_session_path(path: &Path, session_id: &str) -> bool {
    path.exists() && parse_session_header_id(path).ok().as_deref() == Some(session_id)
}

pub(crate) fn summarize_session_for_catalog(path: &Path) -> Result<StoredSession, String> {
    match parse_session_file_summary(path, false) {
        Ok(session) => Ok(session),
        Err(_) => {
            let session_id = parse_session_header_id(path)?;
            fallback_session_file_summary(path, &session_id, false)
        }
    }
}

fn maybe_repair_session_catalog_entry(
    connection: &rusqlite::Connection,
    context: &SessionContext,
    path: &Path,
) -> Result<(), String> {
    let stored = summarize_session_for_catalog(path)?;
    upsert_session_catalog_entry(connection, &context.project_slug, &stored)
}

fn discover_session_path_in_dir(
    session_dir: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    if !session_dir.exists() {
        return Ok(None);
    }

    let mut fallback_candidates = Vec::new();
    let entries = fs::read_dir(session_dir).map_err(|error| {
        format!(
            "Unable to read session directory {}: {error}",
            session_dir.display()
        )
    })?;

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Unable to inspect session directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }
        if derive_session_id_from_path(&path).as_deref() == Some(session_id)
            && validate_catalog_session_path(&path, session_id)
        {
            return Ok(Some(path));
        }
        fallback_candidates.push(path);
    }

    for path in fallback_candidates {
        if parse_session_header_id(&path).ok().as_deref() == Some(session_id) {
            return Ok(Some(path));
        }
    }

    Ok(None)
}

fn resolve_session_path_with_catalog(
    connection: &rusqlite::Connection,
    context: &SessionContext,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    if let Some(entry) = load_session_catalog_entry(connection, session_id)? {
        if entry.project_slug == context.project_slug {
            if validate_catalog_session_path(&entry.session_path, session_id) {
                return Ok(Some(entry.session_path));
            }
            remove_session_catalog_entry(connection, session_id)?;
        }
    }

    let discovered = discover_session_path_in_dir(&context.session_dir, session_id)?;
    if let Some(path) = discovered.as_ref() {
        maybe_repair_session_catalog_entry(connection, context, path)?;
    }
    Ok(discovered)
}

fn canonical_session_path(row: &session_records::CanonicalSessionRow) -> Option<&Path> {
    (!row.session_path.as_os_str().is_empty()).then_some(row.session_path.as_path())
}

fn canonical_row_matches_context(
    row: &session_records::CanonicalSessionRow,
    context: &SessionContext,
) -> bool {
    row.project_slug.as_deref() == Some(context.project_slug.as_str())
        || canonical_session_path(row).is_some_and(|path| path.starts_with(&context.session_dir))
}

fn resolve_context_from_canonical_row(
    row: &session_records::CanonicalSessionRow,
) -> Option<SessionContext> {
    if let Some(project_slug) = row.project_slug.as_deref() {
        return detect_session_context(Some(project_slug)).ok();
    }
    if let Some(project_id) = row.project_id.as_deref() {
        return session_context_for_project_id(project_id).ok();
    }
    canonical_session_path(row)
        .and_then(Path::parent)
        .and_then(session_context_for_session_dir)
}

fn repair_canonical_session_row_from_path(
    connection: &rusqlite::Connection,
    context: &SessionContext,
    session_id: &str,
    path: &Path,
) -> Result<Option<session_records::CanonicalSessionRow>, String> {
    if !validate_catalog_session_path(path, session_id) {
        return Ok(None);
    }

    let project_id =
        projects::get_project_by_slug(connection, &context.project_slug)?.map(|project| project.id);
    let repaired = session_records::repair_session_row_from_transcript_path(
        connection,
        session_id,
        project_id.as_deref(),
        None,
        path,
    )?;
    maybe_repair_session_catalog_entry(connection, context, path)?;
    Ok(Some(repaired))
}

fn repair_canonical_session_row(
    connection: &rusqlite::Connection,
    session_id: &str,
) -> Result<Option<session_records::CanonicalSessionRow>, String> {
    let mut candidate_contexts = Vec::<SessionContext>::new();
    let mut seen_project_slugs = HashSet::<String>::new();

    if let Some(entry) = load_session_catalog_entry(connection, session_id)? {
        if let Ok(context) = detect_session_context(Some(&entry.project_slug)) {
            if seen_project_slugs.insert(context.project_slug.clone()) {
                if let Some(repaired) = repair_canonical_session_row_from_path(
                    connection,
                    &context,
                    session_id,
                    &entry.session_path,
                )? {
                    return Ok(Some(repaired));
                }
                candidate_contexts.push(context);
            }
        }
    }

    for project_slug in
        session_records::candidate_project_slugs_for_session(connection, session_id)?
    {
        if let Ok(context) = detect_session_context(Some(&project_slug)) {
            if seen_project_slugs.insert(context.project_slug.clone()) {
                candidate_contexts.push(context);
            }
        }
    }

    for context in all_session_contexts()? {
        if seen_project_slugs.insert(context.project_slug.clone()) {
            candidate_contexts.push(context);
        }
    }

    for context in candidate_contexts {
        if let Some(path) = discover_session_path_in_dir(&context.session_dir, session_id)? {
            if let Some(repaired) =
                repair_canonical_session_row_from_path(connection, &context, session_id, &path)?
            {
                return Ok(Some(repaired));
            }
        }
    }

    Ok(session_records::load_session_row(connection, session_id)?)
}

fn resolve_session_path_with_canonical(
    connection: &rusqlite::Connection,
    context: &SessionContext,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    if let Some(row) = session_records::load_session_row(connection, session_id)? {
        if canonical_row_matches_context(&row, context) {
            if let Some(path) = canonical_session_path(&row) {
                if validate_catalog_session_path(path, session_id) {
                    return Ok(Some(path.to_path_buf()));
                }
            }
        }
    }

    if let Some(repaired) = repair_canonical_session_row(connection, session_id)? {
        if canonical_row_matches_context(&repaired, context) {
            if let Some(path) = canonical_session_path(&repaired) {
                if validate_catalog_session_path(path, session_id) {
                    return Ok(Some(path.to_path_buf()));
                }
            }
        }
    }

    Ok(None)
}

fn refresh_session_catalog(
    connection: &rusqlite::Connection,
    context: &SessionContext,
    dismissed_ids: &HashSet<String>,
) -> Result<SessionCatalogRefreshStats, String> {
    fs::create_dir_all(&context.session_dir).map_err(|error| {
        format!(
            "Unable to create session directory {}: {error}",
            context.session_dir.display()
        )
    })?;

    let existing_entries =
        load_session_catalog_entries_for_project(connection, &context.project_slug)?;
    let existing_by_session_id = existing_entries
        .iter()
        .map(|entry| (entry.session_id.clone(), entry))
        .collect::<HashMap<_, _>>();
    let existing_by_path = existing_entries
        .iter()
        .map(|entry| (entry.session_path.clone(), entry))
        .collect::<HashMap<_, _>>();

    let mut stats = SessionCatalogRefreshStats::default();
    let mut seen_session_ids = HashSet::new();
    let mut seen_paths = HashSet::new();

    let entries = fs::read_dir(&context.session_dir).map_err(|error| {
        format!(
            "Unable to read session directory {}: {error}",
            context.session_dir.display()
        )
    })?;

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Unable to inspect session directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let derived_session_id = derive_session_id_from_path(&path);
        let existing_entry = derived_session_id
            .as_ref()
            .and_then(|session_id| existing_by_session_id.get(session_id).copied())
            .or_else(|| existing_by_path.get(&path).copied());

        if derived_session_id
            .as_ref()
            .is_some_and(|session_id| dismissed_ids.contains(session_id))
        {
            if let Some(session_id) = derived_session_id.as_ref() {
                if remove_session_catalog_entry(connection, session_id).is_ok() {
                    stats.evicted_rows += 1;
                }
            }
            if remove_session_catalog_entry_by_path(connection, &path).is_ok() {
                stats.evicted_rows += 1;
            }
            stats.skipped_dismissed_files += 1;
            continue;
        }

        let (file_size, file_mtime_ms) = session_file_fingerprint(&path)?;
        if let Some(existing) = existing_entry {
            let same_file = existing.session_path == path;
            let same_identity = derived_session_id
                .as_ref()
                .is_some_and(|session_id| session_id == &existing.session_id)
                || derived_session_id.is_none();
            let unchanged = same_file
                && same_identity
                && existing.file_size == file_size
                && existing.file_mtime_ms == file_mtime_ms;
            if unchanged {
                seen_session_ids.insert(existing.session_id.clone());
                seen_paths.insert(path.clone());
                continue;
            }
        }

        let stored = summarize_session_for_catalog(&path)?;
        if dismissed_ids.contains(&stored.record.id) {
            remove_session_catalog_entry(connection, &stored.record.id)?;
            remove_session_catalog_entry_by_path(connection, &path)?;
            stats.skipped_dismissed_files += 1;
            continue;
        }

        if let Some(existing) = existing_entry {
            if existing.session_id != stored.record.id || existing.session_path != path {
                stats.repaired_rows += 1;
            }
        } else {
            stats.repaired_rows += 1;
        }

        if let Some(derived_session_id) = derived_session_id.as_ref() {
            if derived_session_id != &stored.record.id {
                remove_session_catalog_entry(connection, derived_session_id)?;
                stats.evicted_rows += 1;
            }
        }

        upsert_session_catalog_entry(connection, &context.project_slug, &stored)?;
        stats.parsed_files += 1;
        seen_session_ids.insert(stored.record.id.clone());
        seen_paths.insert(path.clone());
    }

    for existing in existing_entries {
        if seen_session_ids.contains(&existing.session_id)
            || seen_paths.contains(&existing.session_path)
        {
            continue;
        }
        if !existing.session_path.exists() || dismissed_ids.contains(&existing.session_id) {
            remove_session_catalog_entry(connection, &existing.session_id)?;
            stats.evicted_rows += 1;
        }
    }

    Ok(stats)
}

pub fn list_sessions_with_connection(
    connection: &rusqlite::Connection,
    context: &SessionContext,
    subscribed_ids: &HashSet<String>,
    dismissed_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    let project_id = project_id_for_context(connection, context);
    let rows = session_records::list_session_rows(
        connection,
        project_id.as_deref(),
        Some(&context.session_dir),
    )?;

    Ok(rows
        .into_iter()
        .filter(|row| {
            !dismissed_ids.contains(&row.id)
                && row.hidden_reason.is_none()
                && row.dismissed_at.is_none()
                && row.list_visibility != "hidden"
        })
        .map(|row| row.to_record(subscribed_ids.contains(&row.id)))
        .collect())
}

pub fn find_session_context_for_session(session_id: &str) -> Result<SessionContext, String> {
    let connection = database::open_connection()?;
    if let Some(row) = session_records::load_session_row(&connection, session_id)? {
        if validate_catalog_session_path(&row.session_path, session_id) {
            if let Some(context) = canonical_session_context(&row)? {
                return Ok(context);
            }
        }
        if let Some(context) =
            repair_session_context_for_session(&connection, session_id, Some(&row))?
        {
            return Ok(context);
        }
    }

    if let Some(context) = repair_session_context_for_session(&connection, session_id, None)? {
        return Ok(context);
    }

    Err(format!(
        "Session {session_id} was not found in canonical session rows or targeted legacy repair hints"
    ))
}

pub(crate) fn session_file_header_cwd(path: &Path) -> Result<Option<PathBuf>, String> {
    let header = parse_session_header(path)?;
    Ok(header.get("cwd").and_then(Value::as_str).map(PathBuf::from))
}

pub fn get_session_header_cwd(
    session_dir: &Path,
    session_id: &str,
) -> Result<Option<PathBuf>, String> {
    let path = get_session_path(session_dir, session_id)?;
    session_file_header_cwd(&path)
}

fn create_session_file_internal(
    project_root: &Path,
    session_dir: &Path,
    title: Option<&str>,
    subscribed: bool,
    update_catalog: bool,
) -> Result<StoredSession, String> {
    fs::create_dir_all(session_dir).map_err(|error| {
        format!(
            "Unable to create session directory {}: {error}",
            session_dir.display()
        )
    })?;

    let session_id = Uuid::new_v4().to_string();
    let timestamp = now_iso();
    let file_timestamp = timestamp.replace(':', "-").replace('.', "-");
    let session_path = session_dir.join(format!("{file_timestamp}_{session_id}.jsonl"));

    let mut file = File::create(&session_path).map_err(|error| {
        format!(
            "Unable to create session file {}: {error}",
            session_path.display()
        )
    })?;

    writeln!(
        file,
        "{}",
        json!({
            "type": "session",
            "version": 3,
            "id": session_id,
            "timestamp": timestamp,
            "cwd": project_root.display().to_string(),
        })
    )
    .map_err(|error| {
        format!(
            "Unable to write session header {}: {error}",
            session_path.display()
        )
    })?;

    if let Some(title) = normalized_title(title) {
        writeln!(
            file,
            "{}",
            json!({
                "type": "session_info",
                "id": random_entry_id(),
                "parentId": Value::Null,
                "timestamp": now_iso(),
                "name": title,
            })
        )
        .map_err(|error| {
            format!(
                "Unable to write session title {}: {error}",
                session_path.display()
            )
        })?;
    }

    file.sync_all().map_err(|error| {
        format!(
            "Unable to flush session file {}: {error}",
            session_path.display()
        )
    })?;

    let stored = parse_session_file(&session_path, subscribed)?;
    if update_catalog {
        if let Some(context) = session_context_for_session_dir(session_dir) {
            if let Ok(connection) = database::open_connection() {
                let _ = upsert_session_catalog_entry(&connection, &context.project_slug, &stored);
            }
        }
    }
    Ok(stored)
}

pub(crate) fn create_session_file_unindexed(
    project_root: &Path,
    session_dir: &Path,
    title: Option<&str>,
    subscribed: bool,
) -> Result<StoredSession, String> {
    create_session_file_internal(project_root, session_dir, title, subscribed, false)
}

pub(crate) fn index_stored_session(
    connection: &rusqlite::Connection,
    project_slug: &str,
    stored: &StoredSession,
) -> Result<(), String> {
    upsert_session_catalog_entry(connection, project_slug, stored)
}

pub fn create_session_file(
    project_root: &Path,
    session_dir: &Path,
    title: Option<&str>,
    subscribed: bool,
) -> Result<StoredSession, String> {
    create_session_file_internal(project_root, session_dir, title, subscribed, true)
}

pub fn list_sessions(
    session_dir: &Path,
    subscribed_ids: &HashSet<String>,
) -> Result<Vec<SessionRecord>, String> {
    if let Some(context) = session_context_for_session_dir(session_dir) {
        let connection = database::open_connection()?;
        let hidden_ids = session_list::load_hidden_session_ids(&connection)?;
        return list_sessions_with_connection(&connection, &context, subscribed_ids, &hidden_ids);
    }

    let mut sessions = list_stored_session_summaries(session_dir, subscribed_ids)?;
    sessions.sort_by(|left, right| right.record.updated_at.cmp(&left.record.updated_at));
    Ok(sessions.into_iter().map(|session| session.record).collect())
}

pub fn get_session(
    session_dir: &Path,
    session_id: &str,
    subscribed: bool,
) -> Result<SessionRecord, String> {
    resolve_session(session_dir, session_id, subscribed).map(|session| session.record)
}

pub fn get_session_path(session_dir: &Path, session_id: &str) -> Result<PathBuf, String> {
    if let Some(context) = session_context_for_session_dir(session_dir) {
        let connection = database::open_connection()?;
        if let Some(path) = resolve_session_path_with_canonical(&connection, &context, session_id)?
        {
            return Ok(path);
        }
        return Err(format!("Unable to find session {session_id}"));
    }

    resolve_session(session_dir, session_id, true).map(|session| session.path)
}

pub fn delete_session_file(session_dir: &Path, session_id: &str) -> Result<(), String> {
    let path = get_session_path(session_dir, session_id)?;
    fs::remove_file(&path)
        .map_err(|error| format!("Unable to delete session file {}: {error}", path.display()))?;
    if session_context_for_session_dir(session_dir).is_some() {
        if let Ok(connection) = database::open_connection() {
            let _ = remove_session_catalog_entry(&connection, session_id);
        }
    }
    Ok(())
}

pub fn append_session_system_message(
    session_dir: &Path,
    session_id: &str,
    text: &str,
) -> Result<(), String> {
    let path = get_session_path(session_dir, session_id)?;
    let timestamp = now_iso();
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|error| {
            format!(
                "Unable to open session file {} for append: {error}",
                path.display()
            )
        })?;

    writeln!(
        file,
        "{}",
        json!({
            "type": "message",
            "id": random_entry_id(),
            "timestamp": timestamp,
            "message": {
                "role": "system",
                "content": [{ "type": "text", "text": text }],
                "timestamp": DateTime::parse_from_rfc3339(&timestamp)
                    .map(|value| value.timestamp_millis())
                    .unwrap_or_else(|_| Utc::now().timestamp_millis()),
            }
        })
    )
    .map_err(|error| {
        format!(
            "Unable to append system message to {}: {error}",
            path.display()
        )
    })?;

    file.sync_all()
        .map_err(|error| format!("Unable to flush session file {}: {error}", path.display()))?;

    Ok(())
}

pub fn append_session_assistant_message(
    session_dir: &Path,
    session_id: &str,
    text: &str,
) -> Result<(), String> {
    let path = get_session_path(session_dir, session_id)?;
    let timestamp = now_iso();
    let mut file = OpenOptions::new()
        .append(true)
        .open(&path)
        .map_err(|error| {
            format!(
                "Unable to open session file {} for append: {error}",
                path.display()
            )
        })?;

    writeln!(
        file,
        "{}",
        json!({
            "type": "message",
            "id": random_entry_id(),
            "timestamp": timestamp,
            "message": {
                "role": "assistant",
                "content": [{ "type": "text", "text": text }],
                "usage": {
                    "input": 0,
                    "output": 0,
                    "cacheRead": 0,
                    "cacheWrite": 0,
                    "totalTokens": 0,
                    "cost": {
                        "input": 0,
                        "output": 0,
                        "cacheRead": 0,
                        "cacheWrite": 0,
                        "total": 0,
                    }
                },
                "timestamp": DateTime::parse_from_rfc3339(&timestamp)
                    .map(|value| value.timestamp_millis())
                    .unwrap_or_else(|_| Utc::now().timestamp_millis()),
            }
        })
    )
    .map_err(|error| {
        format!(
            "Unable to append assistant message to {}: {error}",
            path.display()
        )
    })?;

    file.sync_all()
        .map_err(|error| format!("Unable to flush session file {}: {error}", path.display()))?;

    Ok(())
}

pub fn stream_prompt_session<F>(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    run_id: &str,
    message: &str,
    subscribed: bool,
    on_stream_event: F,
) -> Result<SessionRecord, String>
where
    F: FnMut(SessionStreamEvent),
{
    stream_prompt_session_with_executable(
        project_root,
        session_dir,
        session_id,
        message,
        subscribed,
        Path::new("pi"),
        attach_run_id(run_id, on_stream_event),
    )
}

pub fn get_session_model_state(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
) -> Result<SessionModelState, String> {
    get_session_model_state_with_executable(project_root, session_dir, session_id, Path::new("pi"))
}

pub fn get_session_stats(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
) -> Result<SessionStats, String> {
    get_session_stats_with_executable(project_root, session_dir, session_id, Path::new("pi"))
}

pub fn set_session_model(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    provider: &str,
    model_id: &str,
) -> Result<SessionModelState, String> {
    set_session_model_with_executable(
        project_root,
        session_dir,
        session_id,
        provider,
        model_id,
        Path::new("pi"),
    )
}

pub fn set_session_thinking_level(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    level: &str,
) -> Result<SessionModelState, String> {
    set_session_thinking_level_with_executable(
        project_root,
        session_dir,
        session_id,
        level,
        Path::new("pi"),
    )
}

pub fn list_available_models() -> Result<Vec<SessionModel>, String> {
    list_available_models_with_executable_and_agent_dir(Path::new("pi"), None)
}

pub fn list_available_models_for_agent_dir(agent_dir: &Path) -> Result<Vec<SessionModel>, String> {
    list_available_models_with_executable_and_agent_dir(Path::new("pi"), Some(agent_dir))
}

pub fn resolve_pi_executable(preferred: Option<&Path>) -> Result<PathBuf, String> {
    crate::services::pi_runtime::resolve_pi_runtime(preferred)
        .map(|runtime| runtime.executable_path)
}

pub fn user_shell() -> Result<PathBuf, String> {
    crate::services::pi_runtime::user_shell()
}

pub fn resolve_user_shell_environment() -> Option<HashMap<String, String>> {
    crate::services::pi_runtime::resolve_user_shell_environment()
}

pub fn resolve_user_shell_path() -> Option<String> {
    crate::services::pi_runtime::resolve_user_shell_path()
}

pub fn apply_user_shell_environment(command: &mut Command) {
    crate::services::pi_runtime::apply_user_shell_environment(command)
}

pub fn orchestra_pi_agent_dir() -> Result<PathBuf, String> {
    Ok(pi_agent_dir(&default_orchestra_root()?))
}

pub fn orchestra_pi_agent_dir_display() -> Result<String, String> {
    Ok(orchestra_pi_agent_dir()?.display().to_string())
}

pub fn apply_orchestra_pi_environment(command: &mut Command) -> Result<(), String> {
    let agent_dir = orchestra_pi_agent_dir()?;
    apply_pi_agent_environment(command, &agent_dir)
}

fn apply_pi_agent_environment(command: &mut Command, agent_dir: &Path) -> Result<(), String> {
    fs::create_dir_all(agent_dir).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi agent directory {}: {error}",
            agent_dir.display()
        )
    })?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let _ = fs::set_permissions(agent_dir, fs::Permissions::from_mode(0o700));
    }
    command.env("PI_CODING_AGENT_DIR", agent_dir.display().to_string());
    Ok(())
}

pub(crate) fn classify_model_discovery_error(error: &str) -> Option<ModelDiscoveryErrorKind> {
    let normalized = error.to_ascii_lowercase();
    if normalized.contains("bun pm bin -g")
        || normalized.contains("executable not found in $path: \"bun\"")
        || normalized.contains("failed to run bun")
        || normalized.contains("resolvepackagesources")
        || normalized.contains("package-based model sources because bun is not available on path")
    {
        return Some(ModelDiscoveryErrorKind::MissingBun);
    }

    None
}

fn summarize_model_discovery_error(error: &str) -> String {
    match classify_model_discovery_error(error) {
        Some(ModelDiscoveryErrorKind::MissingBun) => MISSING_BUN_MODEL_DISCOVERY_MESSAGE.into(),
        None => error.trim().to_string(),
    }
}

fn attach_run_id<F>(run_id: &str, mut on_stream_event: F) -> impl FnMut(PartialStreamEvent)
where
    F: FnMut(SessionStreamEvent),
{
    let run_id = run_id.to_string();
    move |event| {
        on_stream_event(SessionStreamEvent {
            session_id: event.session_id,
            run_id: run_id.clone(),
            event: event.event,
            timestamp: event.timestamp,
            delta: event.delta,
            message: event.message,
            record: event.record,
        });
    }
}

fn list_stored_session_summaries(
    session_dir: &Path,
    subscribed_ids: &HashSet<String>,
) -> Result<Vec<StoredSession>, String> {
    if !session_dir.exists() {
        return Ok(Vec::new());
    }

    let mut sessions = Vec::new();
    let entries = fs::read_dir(session_dir).map_err(|error| {
        format!(
            "Unable to read session directory {}: {error}",
            session_dir.display()
        )
    })?;

    for entry in entries {
        let entry =
            entry.map_err(|error| format!("Unable to inspect session directory entry: {error}"))?;
        let path = entry.path();
        if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
            continue;
        }

        let session_id = match parse_session_header_id(&path) {
            Ok(session_id) => session_id,
            Err(_) => continue,
        };
        let subscribed = subscribed_ids.contains(&session_id);

        match parse_session_file_summary(&path, subscribed) {
            Ok(session) => sessions.push(session),
            Err(_) => {
                if let Ok(session) = fallback_session_file_summary(&path, &session_id, subscribed) {
                    sessions.push(session);
                }
            }
        }
    }

    Ok(sessions)
}

fn resolve_session(
    session_dir: &Path,
    session_id: &str,
    subscribed: bool,
) -> Result<StoredSession, String> {
    if let Some(context) = session_context_for_session_dir(session_dir) {
        let connection = database::open_connection()?;
        let path = resolve_session_path_with_canonical(&connection, &context, session_id)?
            .ok_or_else(|| format!("Unable to find session {session_id}"))?;

        let Some(row) = session_records::load_session_row(&connection, session_id)? else {
            return parse_session_file(&path, subscribed);
        };

        let mut record = row.to_record(subscribed);
        match parse_session_file(&path, subscribed) {
            Ok(parsed) => {
                if row.catalog_title.is_none() && row.title.trim().is_empty() {
                    record.title = parsed.record.title;
                }
                if row.catalog_status.is_none() {
                    record.status = parsed.record.status;
                }
                if record.created_at.trim().is_empty() {
                    record.created_at = parsed.record.created_at;
                }
                if record.updated_at.trim().is_empty() {
                    record.updated_at = parsed.record.updated_at;
                }
                record.events = parsed.record.events;
                Ok(StoredSession { path, record })
            }
            Err(_) => Ok(StoredSession { path, record }),
        }
    } else {
        if !session_dir.exists() {
            return Err(format!(
                "Session directory {} does not exist yet",
                session_dir.display()
            ));
        }

        let entries = fs::read_dir(session_dir).map_err(|error| {
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

            if parse_session_header_id(&path).ok().as_deref() == Some(session_id) {
                return parse_session_file(&path, subscribed);
            }
        }

        Err(format!("Unable to find session {session_id}"))
    }
}

fn parse_session_header(path: &Path) -> Result<Value, String> {
    let file = File::open(path)
        .map_err(|error| format!("Unable to read session file {}: {error}", path.display()))?;
    let mut reader = BufReader::new(file);
    let mut line = String::new();
    loop {
        line.clear();
        let bytes_read = reader.read_line(&mut line).map_err(|error| {
            format!("Unable to read session header {}: {error}", path.display())
        })?;
        if bytes_read == 0 {
            return Err(format!("Session file {} is empty", path.display()));
        }
        if !line.trim().is_empty() {
            break;
        }
    }
    serde_json::from_str::<Value>(line.trim()).map_err(|error| {
        format!(
            "Unable to parse session header {} as JSON: {error}",
            path.display()
        )
    })
}

fn parse_session_header_id(path: &Path) -> Result<String, String> {
    let header = parse_session_header(path)?;
    header
        .get("id")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .ok_or_else(|| format!("Session file {} is missing a header id", path.display()))
}

fn fallback_session_file_summary(
    path: &Path,
    session_id: &str,
    subscribed: bool,
) -> Result<StoredSession, String> {
    let header = parse_session_header(path)?;
    let (parsed_session_id, created_at, _title, updated_at, _updated_sort_key) =
        parse_session_header_metadata(path, &header)?;
    let resolved_session_id = if parsed_session_id.is_empty() {
        session_id.to_string()
    } else {
        parsed_session_id
    };
    Ok(StoredSession {
        path: path.to_path_buf(),
        record: SessionRecord {
            id: resolved_session_id.clone(),
            title: format!(
                "Session {}",
                &resolved_session_id[..resolved_session_id.len().min(8)]
            ),
            status: "idle".into(),
            created_at,
            updated_at,
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
        },
    })
}

fn parse_session_file(path: &Path, subscribed: bool) -> Result<StoredSession, String> {
    let lines = read_jsonl(path)?;
    let header = lines
        .first()
        .ok_or_else(|| format!("Session file {} is empty", path.display()))?;

    let (session_id, created_at, mut title, mut updated_at, mut updated_sort_key) =
        parse_session_header_metadata(path, header)?;
    let mut first_user_message = None;
    let mut last_visible_role = None;
    let mut events = Vec::new();

    for line in lines.iter().skip(1) {
        let entry_type = line.get("type").and_then(Value::as_str).unwrap_or_default();
        let entry_timestamp = normalize_timestamp(
            line.get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or(&created_at),
        );
        maybe_update_timestamp(&entry_timestamp, &mut updated_at, &mut updated_sort_key);

        match entry_type {
            "session_info" => {
                if let Some(name) = line
                    .get("name")
                    .and_then(Value::as_str)
                    .and_then(non_empty_trimmed)
                {
                    title = Some(name.to_string());
                }
            }
            "compaction" => {
                let summary = line
                    .get("summary")
                    .and_then(Value::as_str)
                    .and_then(non_empty_trimmed)
                    .map(ToOwned::to_owned)
                    .unwrap_or_else(|| "Session context compacted.".to_string());
                let tokens_before = line
                    .get("tokensBefore")
                    .and_then(Value::as_i64)
                    .map(|value| format!(" ({value} tokens before)"))
                    .unwrap_or_default();
                events.push(SessionEvent {
                    id: line
                        .get("id")
                        .and_then(Value::as_str)
                        .unwrap_or("compaction")
                        .to_string(),
                    kind: "system".into(),
                    message: format!("Session compacted{tokens_before}.\n{summary}"),
                    timestamp: entry_timestamp.clone(),
                    thinking_text: None,
                });
            }
            "message" => {
                let Some(message) = line.get("message") else {
                    continue;
                };
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let message_text = extract_message_text(message);
                let message_thinking = extract_message_thinking(message);
                let message_timestamp = message_timestamp(message, &entry_timestamp);
                maybe_update_timestamp(&message_timestamp, &mut updated_at, &mut updated_sort_key);

                match role {
                    "user" => {
                        if let Some(text) = non_empty_trimmed(&message_text) {
                            if first_user_message.is_none() {
                                first_user_message = Some(text.to_string());
                            }
                            last_visible_role = Some("user");
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("user-message")
                                    .to_string(),
                                kind: "user".into(),
                                message: text.to_string(),
                                timestamp: message_timestamp,
                                thinking_text: None,
                            });
                        }
                    }
                    "assistant" => {
                        let message_id = line
                            .get("id")
                            .and_then(Value::as_str)
                            .unwrap_or("assistant-message")
                            .to_string();

                        for tool_event in
                            extract_tool_use_events(message, &message_id, &message_timestamp)
                        {
                            events.push(tool_event);
                        }

                        if non_empty_trimmed(&message_text).is_some()
                            || non_empty_trimmed(&message_thinking).is_some()
                        {
                            last_visible_role = Some("assistant");
                            events.push(SessionEvent {
                                id: message_id,
                                kind: "assistant".into(),
                                message: non_empty_trimmed(&message_text)
                                    .map(ToOwned::to_owned)
                                    .unwrap_or_default(),
                                timestamp: message_timestamp,
                                thinking_text: non_empty_trimmed(&message_thinking)
                                    .map(ToOwned::to_owned),
                            });
                        }
                    }
                    "toolResult" => {
                        if let Some(text) = non_empty_trimmed(&message_text) {
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("tool-result")
                                    .to_string(),
                                kind: "system".into(),
                                message: format!(
                                    "{} tool result:\n{}",
                                    message
                                        .get("toolName")
                                        .and_then(Value::as_str)
                                        .unwrap_or("Tool"),
                                    text
                                ),
                                timestamp: message_timestamp,
                                thinking_text: None,
                            });
                        }
                    }
                    "bashExecution" => {
                        if let Some(command) = message.get("command").and_then(Value::as_str) {
                            events.push(SessionEvent {
                                id: line
                                    .get("id")
                                    .and_then(Value::as_str)
                                    .unwrap_or("bash-execution")
                                    .to_string(),
                                kind: "system".into(),
                                message: format!("Executed bash command: {command}"),
                                timestamp: message_timestamp,
                                thinking_text: None,
                            });
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    if events.is_empty() {
        events.push(SessionEvent {
            id: format!("system-{session_id}"),
            kind: "system".into(),
            message: DEFAULT_EMPTY_SESSION_MESSAGE.into(),
            timestamp: created_at.clone(),
            thinking_text: None,
        });
    }

    let title = title
        .or_else(|| first_user_message.map(|message| truncate_for_title(&message)))
        .unwrap_or_else(|| format!("Session {}", &session_id[..session_id.len().min(8)]));
    let status = match last_visible_role {
        Some("user") => "active",
        _ => "idle",
    }
    .to_string();

    Ok(StoredSession {
        path: path.to_path_buf(),
        record: SessionRecord {
            id: session_id,
            title,
            status,
            created_at,
            updated_at,
            subscribed,
            events,
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
        },
    })
}

fn parse_session_file_summary(path: &Path, subscribed: bool) -> Result<StoredSession, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read session file {}: {error}", path.display()))?;

    let non_empty_lines = content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some((index, trimmed))
            }
        })
        .collect::<Vec<_>>();
    let last_non_empty_index = non_empty_lines.last().map(|(index, _)| *index);
    let content_ends_with_newline = content.ends_with('\n');

    let Some((_, header_line)) = non_empty_lines.first() else {
        return Err(format!("Session file {} is empty", path.display()));
    };
    let header = serde_json::from_str::<Value>(header_line).map_err(|error| {
        format!(
            "Unable to parse session header {} as JSON: {error}",
            path.display()
        )
    })?;
    let (session_id, created_at, mut title, mut updated_at, mut updated_sort_key) =
        parse_session_header_metadata(path, &header)?;
    let mut first_user_message = None;
    let mut last_visible_role = None;

    for (index, line) in non_empty_lines.into_iter().skip(1) {
        let value = match serde_json::from_str::<Value>(line) {
            Ok(value) => value,
            Err(error)
                if Some(index) == last_non_empty_index
                    && error.classify() == serde_json::error::Category::Eof
                    && !content_ends_with_newline =>
            {
                break;
            }
            Err(_error) if Some(index) == last_non_empty_index => {
                // Session summaries are best-effort for the tail of the file. If a live
                // session body is temporarily unreadable while pi is writing the latest line,
                // keep the session visible in list views using whatever metadata we already
                // parsed instead of dropping it entirely.
                break;
            }
            Err(error) => {
                return Err(format!(
                    "Unable to parse session file {} as JSONL: {error}",
                    path.display()
                ));
            }
        };

        let entry_type = value
            .get("type")
            .and_then(Value::as_str)
            .unwrap_or_default();
        let entry_timestamp = normalize_timestamp(
            value
                .get("timestamp")
                .and_then(Value::as_str)
                .unwrap_or(&created_at),
        );
        maybe_update_timestamp(&entry_timestamp, &mut updated_at, &mut updated_sort_key);

        match entry_type {
            "session_info" => {
                if let Some(name) = value
                    .get("name")
                    .and_then(Value::as_str)
                    .and_then(non_empty_trimmed)
                {
                    title = Some(name.to_string());
                }
            }
            "message" => {
                let Some(message) = value.get("message") else {
                    continue;
                };
                let role = message
                    .get("role")
                    .and_then(Value::as_str)
                    .unwrap_or_default();
                let message_text = extract_message_text(message);
                let message_timestamp = message_timestamp(message, &entry_timestamp);
                maybe_update_timestamp(&message_timestamp, &mut updated_at, &mut updated_sort_key);

                match role {
                    "user" => {
                        if let Some(text) = non_empty_trimmed(&message_text) {
                            if first_user_message.is_none() {
                                first_user_message = Some(text.to_string());
                            }
                            last_visible_role = Some("user");
                        }
                    }
                    "assistant" => {
                        if non_empty_trimmed(&message_text).is_some() {
                            last_visible_role = Some("assistant");
                        }
                    }
                    _ => {}
                }
            }
            _ => {}
        }
    }

    let title = title
        .or_else(|| first_user_message.map(|message| truncate_for_title(&message)))
        .unwrap_or_else(|| format!("Session {}", &session_id[..session_id.len().min(8)]));
    let status = match last_visible_role {
        Some("user") => "active",
        _ => "idle",
    }
    .to_string();

    Ok(StoredSession {
        path: path.to_path_buf(),
        record: SessionRecord {
            id: session_id,
            title,
            status,
            created_at,
            updated_at,
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
        },
    })
}

fn parse_session_header_metadata(
    path: &Path,
    header: &Value,
) -> Result<(String, String, Option<String>, String, i64), String> {
    if header.get("type").and_then(Value::as_str) != Some("session") {
        return Err(format!(
            "Session file {} does not start with a session header",
            path.display()
        ));
    }

    let session_id = header
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| format!("Session file {} is missing a session id", path.display()))?
        .to_string();
    let created_timestamp = header
        .get("timestamp")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .unwrap_or_else(now_iso);
    let created_at = normalize_timestamp(&created_timestamp);
    let updated_sort_key = timestamp_sort_key(&created_at);

    Ok((
        session_id,
        created_at.clone(),
        None,
        created_at,
        updated_sort_key,
    ))
}

fn read_jsonl(path: &Path) -> Result<Vec<Value>, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read session file {}: {error}", path.display()))?;

    let non_empty_lines = content
        .lines()
        .enumerate()
        .filter_map(|(index, line)| {
            let trimmed = line.trim();
            if trimmed.is_empty() {
                None
            } else {
                Some((index, trimmed))
            }
        })
        .collect::<Vec<_>>();
    let last_non_empty_index = non_empty_lines.last().map(|(index, _)| *index);
    let content_ends_with_newline = content.ends_with('\n');

    let mut parsed = Vec::with_capacity(non_empty_lines.len());
    for (index, line) in non_empty_lines {
        match serde_json::from_str::<Value>(line) {
            Ok(value) => parsed.push(value),
            Err(error)
                if Some(index) == last_non_empty_index
                    && error.classify() == serde_json::error::Category::Eof
                    && !content_ends_with_newline =>
            {
                break;
            }
            Err(error) => {
                return Err(format!(
                    "Unable to parse session file {} as JSONL: {error}",
                    path.display()
                ));
            }
        }
    }

    Ok(parsed)
}

fn stream_prompt_session_with_executable<F>(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    message: &str,
    subscribed: bool,
    executable: &Path,
    mut on_stream_event: F,
) -> Result<SessionRecord, String>
where
    F: FnMut(PartialStreamEvent),
{
    let trimmed = message.trim();
    if trimmed.is_empty() {
        return Err("Message cannot be empty".into());
    }

    let stored = resolve_session(session_dir, session_id, subscribed)?;
    let mut saw_prompt_response = false;
    let mut saw_agent_end = false;
    let mut rpc_error = None;

    let payloads = run_rpc_process(
        executable,
        project_root,
        session_dir,
        &stored.path,
        &[json!({
            "id": PROMPT_REQUEST_ID,
            "type": "prompt",
            "message": trimmed,
        })],
        |payload| match payload.get("type").and_then(Value::as_str) {
            Some("response") => {
                if payload.get("id").and_then(Value::as_str) == Some(PROMPT_REQUEST_ID) {
                    saw_prompt_response = true;
                    if payload.get("success").and_then(Value::as_bool) != Some(true) {
                        rpc_error = Some(extract_rpc_error(payload));
                    }
                }
            }
            Some("message_update") => {
                let event_type = payload
                    .pointer("/assistantMessageEvent/type")
                    .and_then(Value::as_str)
                    .unwrap_or_default();

                if event_type == "error" {
                    rpc_error = Some(extract_rpc_error(payload));
                }

                if event_type == "thinking_start" {
                    on_stream_event(PartialStreamEvent {
                        session_id: session_id.to_string(),
                        event: "thinking_start".into(),
                        timestamp: Some(now_iso()),
                        delta: None,
                        message: None,
                        record: None,
                    });
                }

                if event_type == "text_start" {
                    on_stream_event(PartialStreamEvent {
                        session_id: session_id.to_string(),
                        event: "text_start".into(),
                        timestamp: Some(now_iso()),
                        delta: None,
                        message: None,
                        record: None,
                    });
                }

                if event_type == "text_delta" {
                    on_stream_event(PartialStreamEvent {
                        session_id: session_id.to_string(),
                        event: "text_delta".into(),
                        timestamp: None,
                        delta: payload
                            .pointer("/assistantMessageEvent/delta")
                            .and_then(Value::as_str)
                            .map(ToOwned::to_owned),
                        message: None,
                        record: None,
                    });
                }
            }
            Some("agent_end") => {
                saw_agent_end = true;
            }
            _ => {}
        },
        None,
    )?;

    if let Some(error) = rpc_error {
        return Err(error);
    }

    require_successful_response(&payloads, PROMPT_REQUEST_ID, "prompt")?;

    if !saw_prompt_response {
        return Err("pi RPC process did not acknowledge the prompt command".into());
    }

    if !saw_agent_end {
        return Err("pi RPC process ended before the agent finished the turn".into());
    }

    parse_session_file(&stored.path, subscribed).map(|session| session.record)
}

fn get_session_model_state_with_executable(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    executable: &Path,
) -> Result<SessionModelState, String> {
    let stored = resolve_session(session_dir, session_id, true)?;
    let payloads = run_rpc_query_process(
        executable,
        project_root,
        session_dir,
        &stored.path,
        &[
            json!({ "id": GET_STATE_REQUEST_ID, "type": "get_state" }),
            json!({ "id": GET_MODELS_REQUEST_ID, "type": "get_available_models" }),
        ],
        |_| {},
        None,
    )?;

    let state_payload = require_successful_response(&payloads, GET_STATE_REQUEST_ID, "get_state")?;
    let models_payload =
        require_successful_response(&payloads, GET_MODELS_REQUEST_ID, "get_available_models")?;

    let current_model = state_payload
        .pointer("/data/model")
        .and_then(parse_model_summary);
    let current_thinking_level = state_payload
        .pointer("/data/thinkingLevel")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    let available_models = models_payload
        .pointer("/data/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_model_summary)
        .collect();

    Ok(SessionModelState {
        session_id: session_id.to_string(),
        current_model,
        current_thinking_level,
        available_models,
    })
}

pub(crate) fn parse_session_stats_payload(
    payload: &Value,
    session_id: &str,
) -> Result<SessionStats, String> {
    let data = payload
        .get("data")
        .ok_or_else(|| format!("Session stats response for {session_id} is missing data"))?;

    let session_file = data
        .get("sessionFile")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned);

    let tokens_payload = data.get("tokens").ok_or_else(|| {
        format!("Session stats response for {session_id} is missing token totals")
    })?;

    let token_total = tokens_payload
        .get("total")
        .or_else(|| tokens_payload.get("totalTokens"));

    let tokens = SessionTokenUsage {
        input: tokens_payload
            .get("input")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        output: tokens_payload
            .get("output")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        cache_read: tokens_payload
            .get("cacheRead")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        cache_write: tokens_payload
            .get("cacheWrite")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        total: token_total.and_then(Value::as_i64).unwrap_or_default(),
    };

    let context_usage = data.get("contextUsage").and_then(|usage| {
        let context_window = usage.get("contextWindow").and_then(Value::as_i64)?;
        Some(SessionContextUsage {
            tokens: usage.get("tokens").and_then(Value::as_i64),
            context_window,
            percent: usage.get("percent").and_then(Value::as_f64).or_else(|| {
                usage
                    .get("percent")
                    .and_then(Value::as_i64)
                    .map(|value| value as f64)
            }),
        })
    });

    Ok(SessionStats {
        session_id: data
            .get("sessionId")
            .and_then(Value::as_str)
            .unwrap_or(session_id)
            .to_string(),
        session_file,
        user_messages: data
            .get("userMessages")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        assistant_messages: data
            .get("assistantMessages")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        tool_calls: data
            .get("toolCalls")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        tool_results: data
            .get("toolResults")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        total_messages: data
            .get("totalMessages")
            .and_then(Value::as_i64)
            .unwrap_or_default(),
        tokens,
        cost: data.get("cost").and_then(Value::as_f64).unwrap_or_default(),
        context_usage,
    })
}

fn get_session_stats_with_executable(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    executable: &Path,
) -> Result<SessionStats, String> {
    let stored = resolve_session(session_dir, session_id, true)?;
    let payloads = run_rpc_query_process(
        executable,
        project_root,
        session_dir,
        &stored.path,
        &[json!({ "id": GET_SESSION_STATS_REQUEST_ID, "type": "get_session_stats" })],
        |_| {},
        None,
    )?;

    let stats_payload =
        require_successful_response(&payloads, GET_SESSION_STATS_REQUEST_ID, "get_session_stats")?;

    parse_session_stats_payload(stats_payload, session_id)
}

fn set_session_model_with_executable(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    provider: &str,
    model_id: &str,
    executable: &Path,
) -> Result<SessionModelState, String> {
    let stored = resolve_session(session_dir, session_id, true)?;
    let payloads = run_rpc_query_process(
        executable,
        project_root,
        session_dir,
        &stored.path,
        &[
            json!({
                "id": SET_MODEL_REQUEST_ID,
                "type": "set_model",
                "provider": provider,
                "modelId": model_id,
            }),
            json!({ "id": GET_STATE_REQUEST_ID, "type": "get_state" }),
            json!({ "id": GET_MODELS_REQUEST_ID, "type": "get_available_models" }),
        ],
        |_| {},
        None,
    )?;

    require_successful_response(&payloads, SET_MODEL_REQUEST_ID, "set_model")?;
    let state_payload = require_successful_response(&payloads, GET_STATE_REQUEST_ID, "get_state")?;
    let models_payload =
        require_successful_response(&payloads, GET_MODELS_REQUEST_ID, "get_available_models")?;

    let current_model = state_payload
        .pointer("/data/model")
        .and_then(parse_model_summary);
    let current_thinking_level = state_payload
        .pointer("/data/thinkingLevel")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    let available_models = models_payload
        .pointer("/data/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_model_summary)
        .collect();

    Ok(SessionModelState {
        session_id: session_id.to_string(),
        current_model,
        current_thinking_level,
        available_models,
    })
}

fn set_session_thinking_level_with_executable(
    project_root: &Path,
    session_dir: &Path,
    session_id: &str,
    level: &str,
    executable: &Path,
) -> Result<SessionModelState, String> {
    let stored = resolve_session(session_dir, session_id, true)?;
    let payloads = run_rpc_query_process(
        executable,
        project_root,
        session_dir,
        &stored.path,
        &[
            json!({
                "id": "set-thinking-1",
                "type": "set_thinking_level",
                "level": level,
            }),
            json!({ "id": GET_STATE_REQUEST_ID, "type": "get_state" }),
            json!({ "id": GET_MODELS_REQUEST_ID, "type": "get_available_models" }),
        ],
        |_| {},
        None,
    )?;

    require_successful_response(&payloads, "set-thinking-1", "set_thinking_level")?;
    let state_payload = require_successful_response(&payloads, GET_STATE_REQUEST_ID, "get_state")?;
    let models_payload =
        require_successful_response(&payloads, GET_MODELS_REQUEST_ID, "get_available_models")?;

    let current_model = state_payload
        .pointer("/data/model")
        .and_then(parse_model_summary);
    let current_thinking_level = state_payload
        .pointer("/data/thinkingLevel")
        .and_then(Value::as_str)
        .unwrap_or("off")
        .to_string();
    let available_models = models_payload
        .pointer("/data/models")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .filter_map(parse_model_summary)
        .collect();

    Ok(SessionModelState {
        session_id: session_id.to_string(),
        current_model,
        current_thinking_level,
        available_models,
    })
}

fn list_available_models_with_executable(executable: &Path) -> Result<Vec<SessionModel>, String> {
    list_available_models_with_executable_and_agent_dir(executable, None)
}

fn list_available_models_with_executable_and_agent_dir(
    executable: &Path,
    agent_dir_override: Option<&Path>,
) -> Result<Vec<SessionModel>, String> {
    let runtime = crate::services::pi_runtime::resolve_pi_runtime(Some(executable))?;
    let resolved_executable = runtime.executable_path.clone();
    let temp_root = std::env::temp_dir().join(format!("orchestra-models-{}", Uuid::new_v4()));
    fs::create_dir_all(&temp_root)
        .map_err(|error| format!("Unable to create temporary model query directory: {error}"))?;
    let result = (|| {
        let project_root = temp_root.join("project");
        let session_dir = temp_root.join("sessions");
        fs::create_dir_all(&project_root).map_err(|error| {
            format!("Unable to create temporary model query project directory: {error}")
        })?;
        fs::create_dir_all(&session_dir).map_err(|error| {
            format!("Unable to create temporary model query session directory: {error}")
        })?;

        let created = create_session_file(&project_root, &session_dir, Some("Model query"), false)?;
        let payloads = run_rpc_query_process(
            &resolved_executable,
            &project_root,
            &session_dir,
            &created.path,
            &[json!({ "id": GET_MODELS_REQUEST_ID, "type": "get_available_models" })],
            |_| {},
            agent_dir_override,
        )
        .map_err(|error| summarize_model_discovery_error(&error))?;

        let models_payload =
            require_successful_response(&payloads, GET_MODELS_REQUEST_ID, "get_available_models")
                .map_err(|error| summarize_model_discovery_error(&error))?;
        let models = models_payload
            .pointer("/data/models")
            .and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(parse_model_summary)
            .collect();

        Ok(models)
    })();

    let _ = fs::remove_dir_all(&temp_root);
    result
}

fn spawn_rpc_process(
    executable: &Path,
    project_root: &Path,
    session_dir: &Path,
    session_path: &Path,
    agent_dir_override: Option<&Path>,
) -> Result<
    (
        std::process::Child,
        std::process::ChildStdin,
        std::process::ChildStdout,
        std::process::ChildStderr,
    ),
    String,
> {
    let runtime = crate::services::pi_runtime::resolve_pi_runtime(Some(executable))?;
    let args = vec![
        "--offline".to_string(),
        "--mode".to_string(),
        "rpc".to_string(),
        "--session".to_string(),
        session_path.display().to_string(),
        "--session-dir".to_string(),
        session_dir.display().to_string(),
        "--no-extensions".to_string(),
    ];
    let mut command = Command::new(&runtime.executable_path);
    apply_user_shell_environment(&mut command);
    crate::services::pi_runtime::apply_runtime_environment(
        &mut command,
        &runtime,
        agent_dir_override,
    );
    if let Some(agent_dir) = agent_dir_override {
        apply_pi_agent_environment(&mut command, agent_dir)?;
    } else {
        apply_orchestra_pi_environment(&mut command)?;
    }
    let mut child = command
        .args(&args)
        .current_dir(project_root)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|error| format!("Unable to start pi RPC process: {error}"))?;

    let stdin = child
        .stdin
        .take()
        .ok_or_else(|| "Unable to open stdin for pi RPC process".to_string())?;
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| "Unable to open stdout for pi RPC process".to_string())?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| "Unable to open stderr for pi RPC process".to_string())?;

    Ok((child, stdin, stdout, stderr))
}

fn run_rpc_process<F>(
    executable: &Path,
    project_root: &Path,
    session_dir: &Path,
    session_path: &Path,
    commands: &[Value],
    mut on_payload: F,
    agent_dir_override: Option<&Path>,
) -> Result<Vec<Value>, String>
where
    F: FnMut(&Value),
{
    let (mut child, mut stdin, stdout, stderr) = spawn_rpc_process(
        executable,
        project_root,
        session_dir,
        session_path,
        agent_dir_override,
    )?;

    let stderr_handle = thread::spawn(move || -> String {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer);
        buffer
    });

    for command in commands {
        writeln!(stdin, "{command}")
            .map_err(|error| format!("Unable to send command to pi RPC process: {error}"))?;
    }

    stdin
        .flush()
        .map_err(|error| format!("Unable to flush pi RPC stdin: {error}"))?;
    drop(stdin);

    let mut payloads = Vec::new();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Unable to read pi RPC output: {error}"))?;
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }

        let payload: Value = serde_json::from_str(trimmed).map_err(|error| {
            format!("Unable to parse pi RPC output as JSON: {error}. Raw line: {trimmed}")
        })?;
        on_payload(&payload);
        payloads.push(payload);
    }

    let status = child
        .wait()
        .map_err(|error| format!("Unable to wait for pi RPC process: {error}"))?;
    let stderr_output = stderr_handle
        .join()
        .unwrap_or_else(|_| "Unable to join pi RPC stderr reader".to_string());

    if !status.success() {
        let stderr_suffix = non_empty_trimmed(&stderr_output)
            .map(|output| format!(": {output}"))
            .unwrap_or_default();
        return Err(format!(
            "pi RPC process exited unsuccessfully{stderr_suffix}"
        ));
    }

    Ok(payloads)
}

fn run_rpc_query_process<F>(
    executable: &Path,
    project_root: &Path,
    session_dir: &Path,
    session_path: &Path,
    commands: &[Value],
    mut on_payload: F,
    agent_dir_override: Option<&Path>,
) -> Result<Vec<Value>, String>
where
    F: FnMut(&Value),
{
    let expected_response_ids = commands
        .iter()
        .filter_map(|command| {
            command
                .get("id")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .collect::<HashSet<_>>();

    let (mut child, mut stdin, stdout, stderr) = spawn_rpc_process(
        executable,
        project_root,
        session_dir,
        session_path,
        agent_dir_override,
    )?;

    let stderr_handle = thread::spawn(move || -> String {
        let mut reader = BufReader::new(stderr);
        let mut buffer = String::new();
        let _ = reader.read_to_string(&mut buffer);
        buffer
    });

    for command in commands {
        writeln!(stdin, "{command}")
            .map_err(|error| format!("Unable to send command to pi RPC process: {error}"))?;
    }

    stdin
        .flush()
        .map_err(|error| format!("Unable to flush pi RPC stdin: {error}"))?;

    let mut payloads = Vec::new();
    let mut received_response_ids = HashSet::new();
    let mut reader = BufReader::new(stdout);
    let mut line = String::new();

    loop {
        line.clear();
        let bytes_read = reader
            .read_line(&mut line)
            .map_err(|error| format!("Unable to read pi RPC output: {error}"))?;
        if bytes_read == 0 {
            break;
        }

        let trimmed = line.trim_end_matches(['\r', '\n']);
        if trimmed.is_empty() {
            continue;
        }

        let payload: Value = serde_json::from_str(trimmed).map_err(|error| {
            format!("Unable to parse pi RPC output as JSON: {error}. Raw line: {trimmed}")
        })?;

        if payload.get("type").and_then(Value::as_str) == Some("response") {
            if let Some(id) = payload.get("id").and_then(Value::as_str) {
                if expected_response_ids.contains(id) {
                    received_response_ids.insert(id.to_string());
                }
            }
        }

        on_payload(&payload);
        payloads.push(payload);

        if !expected_response_ids.is_empty() && received_response_ids == expected_response_ids {
            break;
        }
    }

    drop(stdin);
    let _ = child.kill();
    let _ = child.wait();
    let stderr_output = stderr_handle
        .join()
        .unwrap_or_else(|_| "Unable to join pi RPC stderr reader".to_string());

    if received_response_ids != expected_response_ids {
        let stderr_suffix = non_empty_trimmed(&stderr_output)
            .map(|output| format!(": {output}"))
            .unwrap_or_default();
        return Err(format!(
            "pi RPC process ended before all expected responses were received{stderr_suffix}"
        ));
    }

    Ok(payloads)
}

fn require_successful_response<'a>(
    payloads: &'a [Value],
    request_id: &str,
    command: &str,
) -> Result<&'a Value, String> {
    let response = payloads
        .iter()
        .find(|payload| {
            payload.get("type").and_then(Value::as_str) == Some("response")
                && payload.get("id").and_then(Value::as_str) == Some(request_id)
        })
        .ok_or_else(|| format!("pi RPC process did not respond to {command}"))?;

    if response.get("success").and_then(Value::as_bool) != Some(true) {
        return Err(extract_rpc_error(response));
    }

    Ok(response)
}

fn parse_model_summary(value: &Value) -> Option<SessionModel> {
    Some(SessionModel {
        id: value.get("id")?.as_str()?.to_string(),
        name: value
            .get("name")
            .and_then(Value::as_str)
            .unwrap_or_else(|| value.get("id").and_then(Value::as_str).unwrap_or("Model"))
            .to_string(),
        provider: value.get("provider")?.as_str()?.to_string(),
        api: value
            .get("api")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_string(),
        reasoning: value
            .get("reasoning")
            .and_then(Value::as_bool)
            .unwrap_or(false),
    })
}

fn extract_rpc_error(payload: &Value) -> String {
    payload
        .get("error")
        .and_then(Value::as_str)
        .map(ToOwned::to_owned)
        .or_else(|| {
            payload
                .pointer("/assistantMessageEvent/error")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .or_else(|| {
            payload
                .pointer("/message/errorMessage")
                .and_then(Value::as_str)
                .map(ToOwned::to_owned)
        })
        .unwrap_or_else(|| "pi reported an RPC error".into())
}

fn message_timestamp(message: &Value, fallback: &str) -> String {
    if let Some(milliseconds) = message.get("timestamp").and_then(Value::as_i64) {
        return Utc
            .timestamp_millis_opt(milliseconds)
            .single()
            .map(|value| value.to_rfc3339())
            .unwrap_or_else(|| fallback.to_string());
    }

    normalize_timestamp(fallback)
}

fn extract_message_text(message: &Value) -> String {
    extract_message_blocks(message, "text", "text")
}

fn extract_message_thinking(message: &Value) -> String {
    extract_message_blocks(message, "thinking", "thinking")
}

fn extract_message_blocks(message: &Value, expected_type: &str, value_key: &str) -> String {
    let Some(content) = message.get("content") else {
        return String::new();
    };

    if expected_type == "text" {
        if let Some(text) = content.as_str() {
            return text.trim().to_string();
        }
    }

    content
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|block| {
            if block.get("type").and_then(Value::as_str) == Some(expected_type) {
                block.get(value_key).and_then(Value::as_str).map(str::trim)
            } else {
                None
            }
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn extract_tool_use_events(
    message: &Value,
    message_id: &str,
    message_timestamp: &str,
) -> Vec<SessionEvent> {
    message
        .get("content")
        .and_then(Value::as_array)
        .into_iter()
        .flatten()
        .enumerate()
        .filter_map(|(index, block)| {
            let block_type = block
                .get("type")
                .and_then(Value::as_str)
                .unwrap_or_default();
            let normalized_type = block_type.replace(['_', '-'], "").to_ascii_lowercase();
            if normalized_type != "tooluse" {
                return None;
            }

            let tool_name = block
                .get("toolName")
                .and_then(Value::as_str)
                .or_else(|| block.get("name").and_then(Value::as_str))
                .unwrap_or("tool");
            let args = block
                .get("input")
                .or_else(|| block.get("args"))
                .or_else(|| block.get("parameters"));
            let args_suffix = args
                .and_then(format_tool_payload)
                .map(|payload| format!("\n{}", payload))
                .unwrap_or_default();

            Some(SessionEvent {
                id: format!("{}-tool-use-{}", message_id, index),
                kind: "system".into(),
                message: format!("Tool call: {tool_name}{args_suffix}"),
                timestamp: message_timestamp.to_string(),
                thinking_text: None,
            })
        })
        .collect()
}

fn format_tool_payload(value: &Value) -> Option<String> {
    if value.is_null() {
        return None;
    }

    let serialized = serde_json::to_string_pretty(value).ok()?;
    non_empty_trimmed(&serialized).map(ToOwned::to_owned)
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn normalize_timestamp(input: &str) -> String {
    DateTime::parse_from_rfc3339(input)
        .map(|value| value.with_timezone(&Utc).to_rfc3339())
        .unwrap_or_else(|_| now_iso())
}

fn maybe_update_timestamp(candidate: &str, current: &mut String, current_sort_key: &mut i64) {
    let sort_key = timestamp_sort_key(candidate);
    if sort_key > *current_sort_key {
        *current = candidate.to_string();
        *current_sort_key = sort_key;
    }
}

fn timestamp_sort_key(timestamp: &str) -> i64 {
    DateTime::parse_from_rfc3339(timestamp)
        .map(|value| value.with_timezone(&Utc).timestamp_millis())
        .unwrap_or(0)
}

fn random_entry_id() -> String {
    Uuid::new_v4().simple().to_string()[..8].to_string()
}

fn truncate_for_title(input: &str) -> String {
    const MAX_CHARS: usize = 56;
    let trimmed = input.trim();
    let mut chars = trimmed.chars();
    let truncated: String = chars.by_ref().take(MAX_CHARS).collect();
    if chars.next().is_some() {
        format!("{truncated}…")
    } else {
        truncated
    }
}

fn normalized_title(title: Option<&str>) -> Option<String> {
    title.and_then(non_empty_trimmed).map(ToOwned::to_owned)
}

fn non_empty_trimmed(value: &str) -> Option<&str> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        None
    } else {
        Some(trimmed)
    }
}

#[derive(Debug, Clone)]
struct PartialStreamEvent {
    session_id: String,
    event: String,
    timestamp: Option<String>,
    delta: Option<String>,
    message: Option<String>,
    record: Option<SessionRecord>,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{
        env,
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
        let dir = env::temp_dir().join(suffix);
        fs::create_dir_all(&dir).expect("temp dir should be creatable");
        dir
    }

    fn make_catalog_test_context(label: &str) -> SessionContext {
        let root = unique_temp_dir(label);
        let orchestra_root = root.join("orchestra-root");
        let project_root = root.join("project-root");
        let session_dir = orchestra_root
            .join("projects")
            .join("catalog-test")
            .join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");
        SessionContext {
            project_root,
            project_slug: "catalog-test".to_string(),
            orchestra_root,
            session_dir,
        }
    }

    fn in_memory_session_catalog_connection() -> rusqlite::Connection {
        let connection = rusqlite::Connection::open_in_memory().expect("in-memory db should open");
        database::apply_migrations(&connection).expect("migrations should succeed");
        connection
    }

    fn seed_catalog_test_project(connection: &rusqlite::Connection, context: &SessionContext) {
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'ORC', NULL, ?4, ?4)",
                params![
                    format!("project-{}", context.project_slug),
                    context.project_slug.as_str(),
                    format!("{} project", context.project_slug),
                    "2026-03-20T10:00:00Z",
                ],
            )
            .expect("catalog test project should seed");
    }

    fn write_catalog_test_session(
        context: &SessionContext,
        file_name: &str,
        session_id: &str,
        title: &str,
        timestamp: &str,
    ) -> PathBuf {
        let session_path = context.session_dir.join(file_name);
        let content = format!(
            "{}\n{}\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": timestamp,
                "cwd": context.project_root.display().to_string(),
            }),
            json!({
                "type": "session_info",
                "id": format!("info-{session_id}"),
                "parentId": Value::Null,
                "timestamp": timestamp,
                "name": title,
            }),
            json!({
                "type": "message",
                "id": format!("msg-{session_id}"),
                "timestamp": timestamp,
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": format!("hello from {session_id}") }],
                    "timestamp": 1773835261000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");
        session_path
    }

    fn write_catalog_dismiss_entry(connection: &rusqlite::Connection, session_id: &str) {
        connection
            .execute(
                "INSERT INTO session_list_entries (session_id, dismissed_at, created_at, updated_at) VALUES (?1, ?2, ?2, ?2)",
                params![session_id, "2026-03-20T00:00:00Z"],
            )
            .expect("dismiss entry should insert");
    }

    fn write_fake_pi_executable(path: &Path) {
        let script = r#"#!/usr/bin/env node
import fs from 'node:fs';

const args = process.argv.slice(2);
const sessionIndex = args.indexOf('--session');
const sessionFile = sessionIndex >= 0 ? args[sessionIndex + 1] : null;
if (!sessionFile) {
  console.error('missing --session');
  process.exit(1);
}

const MODELS = [
  {
    id: 'claude-sonnet-4-20250514',
    name: 'Claude Sonnet 4',
    api: 'anthropic-messages',
    provider: 'anthropic',
    reasoning: true,
  },
  {
    id: 'gpt-5.4',
    name: 'GPT-5.4',
    api: 'openai-codex-responses',
    provider: 'openai-codex',
    reasoning: true,
  },
];

function readSessionEntries() {
  return fs
    .readFileSync(sessionFile, 'utf8')
    .split('\n')
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function getCurrentModel() {
  const entries = readSessionEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === 'model_change') {
      return MODELS.find((model) => model.provider === entry.provider && model.id === entry.modelId) ?? MODELS[0];
    }
  }
  return MODELS[0];
}

function getCurrentThinkingLevel() {
  const entries = readSessionEntries();
  for (let index = entries.length - 1; index >= 0; index -= 1) {
    const entry = entries[index];
    if (entry.type === 'thinking_level_change') {
      return entry.thinkingLevel;
    }
  }
  return 'off';
}

function appendEntry(entry) {
  fs.appendFileSync(sessionFile, JSON.stringify(entry) + '\n');
}

const usage = {
  input: 0,
  output: 0,
  cacheRead: 0,
  cacheWrite: 0,
  totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

function handleCommand(command) {
  if (command.type === 'get_state') {
    process.stdout.write(
      JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'get_state',
        success: true,
        data: { model: getCurrentModel(), thinkingLevel: getCurrentThinkingLevel() },
      }) + '\n'
    );
    return;
  }

  if (command.type === 'get_available_models') {
    process.stdout.write(
      JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: MODELS },
      }) + '\n'
    );
    return;
  }

  if (command.type === 'get_session_stats') {
    const entries = readSessionEntries();
    const userMessages = entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'user').length;
    const assistantMessages = entries.filter((entry) => entry.type === 'message' && entry.message?.role === 'assistant').length;
    const totalMessages = userMessages + assistantMessages;
    const contextWindow = 200000;
    const contextTokens = totalMessages === 0 ? null : 60000;
    process.stdout.write(
      JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'get_session_stats',
        success: true,
        data: {
          sessionFile: sessionFile,
          sessionId: 'session-test',
          userMessages,
          assistantMessages,
          toolCalls: 0,
          toolResults: 0,
          totalMessages,
          tokens: {
            input: usage.input,
            output: usage.output,
            cacheRead: usage.cacheRead,
            cacheWrite: usage.cacheWrite,
            total: usage.totalTokens,
          },
          cost: usage.cost.total,
          contextUsage: {
            tokens: contextTokens,
            contextWindow,
            percent: contextTokens == null ? null : (contextTokens / contextWindow) * 100,
          },
        },
      }) + '\n'
    );
    return;
  }

  if (command.type === 'set_model') {
    appendEntry({
      type: 'model_change',
      id: 'model0001',
      parentId: null,
      timestamp: new Date().toISOString(),
      provider: command.provider,
      modelId: command.modelId,
    });
    const model = MODELS.find((entry) => entry.provider === command.provider && entry.id === command.modelId);
    process.stdout.write(
      JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'set_model',
        success: Boolean(model),
        ...(model ? { data: model } : { error: 'Model not found' }),
      }) + '\n'
    );
    return;
  }

  if (command.type === 'set_thinking_level') {
    appendEntry({
      type: 'thinking_level_change',
      id: 'thinking0001',
      parentId: null,
      timestamp: new Date().toISOString(),
      thinkingLevel: command.level,
    });
    process.stdout.write(
      JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'set_thinking_level',
        success: true,
        data: { level: command.level },
      }) + '\n'
    );
    return;
  }

  if (command.type === 'prompt') {
    const now = new Date();
    const later = new Date(now.getTime() + 1);
    const model = getCurrentModel();
    appendEntry({
      type: 'message',
      id: '11111111',
      parentId: null,
      timestamp: now.toISOString(),
      message: {
        role: 'user',
        content: command.message,
        timestamp: now.getTime(),
        attachments: [],
      },
    });
    process.stdout.write(JSON.stringify({ id: command.id, type: 'response', command: 'prompt', success: true }) + '\n');
    process.stdout.write(
      JSON.stringify({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_start', contentIndex: 0, partial: {} },
      }) + '\n'
    );
    process.stdout.write(
      JSON.stringify({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: 'Echo: ', partial: {} },
      }) + '\n'
    );
    process.stdout.write(
      JSON.stringify({
        type: 'message_update',
        message: { role: 'assistant', content: [] },
        assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: command.message, partial: {} },
      }) + '\n'
    );
    appendEntry({
      type: 'message',
      id: '22222222',
      parentId: '11111111',
      timestamp: later.toISOString(),
      message: {
        role: 'assistant',
        content: [{ type: 'text', text: `Echo: ${command.message}` }],
        api: model.api,
        provider: model.provider,
        model: model.id,
        usage,
        stopReason: 'stop',
        timestamp: later.getTime(),
      },
    });
    process.stdout.write(JSON.stringify({ type: 'agent_end', messages: [] }) + '\n');
  }
}

let input = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  input += chunk;
  let newlineIndex;
  while ((newlineIndex = input.indexOf('\n')) >= 0) {
    const line = input.slice(0, newlineIndex).trim();
    input = input.slice(newlineIndex + 1);
    if (!line) continue;
    handleCommand(JSON.parse(line));
  }
});
process.stdin.on('end', () => {
  process.exit(0);
});
"#;

        fs::write(path, script).expect("fake pi script should be writable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path)
                .expect("fake pi script metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions).expect("fake pi script should be executable");
        }
    }

    fn write_fake_streaming_query_pi_executable(path: &Path) {
        let script = r#"#!/usr/bin/env node
const HUGE_MODELS = Array.from({ length: 500 }, (_, index) => ({
  id: `huge-model-${index}`,
  name: `Huge Model ${index}`,
  api: 'openai-completions',
  provider: 'openrouter',
  baseUrl: 'https://openrouter.ai/api/v1',
  reasoning: true,
  input: ['text', 'image'],
  cost: { input: 0.25, output: 1.0, cacheRead: 0.025, cacheWrite: 0 },
  contextWindow: 1048576,
  maxTokens: 131072,
}));

let buffer = '';
let sawEof = false;
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'get_available_models') {
      const response = JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: HUGE_MODELS },
      }) + '\n';
      let offset = 0;
      const writeChunk = () => {
        if (sawEof) {
          process.exit(0);
          return;
        }
        const nextOffset = Math.min(offset + 1024, response.length);
        process.stdout.write(response.slice(offset, nextOffset));
        offset = nextOffset;
        if (offset >= response.length) {
          return;
        }
        setTimeout(writeChunk, 1);
      };
      writeChunk();
    }
  }
});
process.stdin.on('end', () => {
  sawEof = true;
  setTimeout(() => process.exit(0), 0);
});
"#;

        fs::write(path, script).expect("streaming fake pi script should be writable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path)
                .expect("streaming fake pi script metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions)
                .expect("streaming fake pi script should be executable");
        }
    }

    fn write_fake_missing_bun_query_pi_executable(path: &Path) {
        let script = r#"#!/usr/bin/env node
const rawError = [
  'throw new Error(`Failed to run ${command2} ${args.join(" ")}: ${result.error?.message || result.stderr || result.stdout}`);',
  '^',
  'error: Failed to run bun pm bin -g: Executable not found in $PATH: "bun"',
  'at runCommandSync (/$bunfs/root/pi:307493:13)',
  'at getGlobalNpmRoot (/$bunfs/root/pi:307086:41)',
  'at getNpmInstallPath (/$bunfs/root/pi:307101:40)',
  'at resolvePackageSources (/$bunfs/root/pi:306553:53)',
  'Bun v1.2.20 (macOS arm64)',
].join('\n');

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'get_available_models') {
      console.error(rawError);
      process.exit(1);
    }
  }
});
process.stdin.on('end', () => process.exit(0));
"#;

        fs::write(path, script).expect("missing bun fake pi script should be writable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path)
                .expect("missing bun fake pi script metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions)
                .expect("missing bun fake pi script should be executable");
        }
    }

    fn write_fake_npm_prefix_guarded_query_pi_executable(path: &Path) {
        let script = r#"#!/usr/bin/env node
const MODELS = [{
  id: 'claude-sonnet-4-20250514',
  name: 'Claude Sonnet 4',
  api: 'anthropic-messages',
  provider: 'anthropic',
  reasoning: true,
}];
const rawError = 'error: Failed to run bun pm bin -g: Executable not found in $PATH: "bun"';

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let newlineIndex;
  while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
    const line = buffer.slice(0, newlineIndex).trim();
    buffer = buffer.slice(newlineIndex + 1);
    if (!line) continue;
    const command = JSON.parse(line);
    if (command.type === 'get_available_models') {
      if (!process.env.NPM_CONFIG_PREFIX || !process.env.npm_config_prefix) {
        console.error(rawError);
        process.exit(1);
      }
      process.stdout.write(JSON.stringify({
        id: command.id,
        type: 'response',
        command: 'get_available_models',
        success: true,
        data: { models: MODELS },
      }) + '\n');
    }
  }
});
process.stdin.on('end', () => process.exit(0));
"#;

        fs::write(path, script).expect("npm prefix guarded fake pi script should be writable");
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let mut permissions = fs::metadata(path)
                .expect("npm prefix guarded fake pi script metadata should exist")
                .permissions();
            permissions.set_mode(0o755);
            fs::set_permissions(path, permissions)
                .expect("npm prefix guarded fake pi script should be executable");
        }
    }

    #[test]
    fn creates_header_only_session_and_preserves_title() {
        let root = unique_temp_dir("orchestra-real-session-create");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");

        let stored = create_session_file(&project_root, &session_dir, Some("Desk test"), true)
            .expect("session should be created");

        assert!(stored.path.exists());
        assert_eq!(stored.record.title, "Desk test");
        assert!(stored.record.subscribed);
        assert_eq!(stored.record.events.len(), 1);
        assert_eq!(stored.record.events[0].kind, "system");
    }

    #[test]
    fn refresh_session_catalog_skips_dismissed_files_before_summary_parsing() {
        let context = make_catalog_test_context("orchestra-session-catalog-dismissed-skip");
        let connection = in_memory_session_catalog_connection();
        seed_catalog_test_project(&connection, &context);
        let visible_session_id = Uuid::new_v4().to_string();
        let dismissed_session_id = Uuid::new_v4().to_string();

        write_catalog_test_session(
            &context,
            &format!("2026-03-20T10-00-00Z_{visible_session_id}.jsonl"),
            &visible_session_id,
            "Visible session",
            "2026-03-20T10:00:00Z",
        );
        write_catalog_test_session(
            &context,
            &format!("2026-03-20T10-00-01Z_{dismissed_session_id}.jsonl"),
            &dismissed_session_id,
            "Dismissed session",
            "2026-03-20T10:00:01Z",
        );
        write_catalog_dismiss_entry(&connection, &dismissed_session_id);

        let dismissed_ids =
            session_list::load_hidden_session_ids(&connection).expect("dismissed ids should load");
        let stats = refresh_session_catalog(&connection, &context, &dismissed_ids)
            .expect("catalog refresh should succeed");
        assert_eq!(stats.parsed_files, 1);
        assert_eq!(stats.skipped_dismissed_files, 1);

        crate::services::canonical_sessions::backfill_sessions_table(&connection)
            .expect("canonical session backfill should succeed");

        let listed =
            list_sessions_with_connection(&connection, &context, &HashSet::new(), &dismissed_ids)
                .expect("canonical-backed list should succeed");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, visible_session_id);

        let dismissed_catalog_entry =
            load_session_catalog_entry(&connection, &dismissed_session_id)
                .expect("dismissed catalog lookup should succeed");
        assert!(dismissed_catalog_entry.is_none());
    }

    #[test]
    fn refresh_session_catalog_only_reparses_changed_files() {
        let context = make_catalog_test_context("orchestra-session-catalog-incremental");
        let connection = in_memory_session_catalog_connection();
        seed_catalog_test_project(&connection, &context);
        let first_session_id = Uuid::new_v4().to_string();
        let second_session_id = Uuid::new_v4().to_string();

        let first_path = write_catalog_test_session(
            &context,
            &format!("2026-03-20T10-00-00Z_{first_session_id}.jsonl"),
            &first_session_id,
            "First session",
            "2026-03-20T10:00:00Z",
        );
        let second_path = write_catalog_test_session(
            &context,
            &format!("2026-03-20T10-00-01Z_{second_session_id}.jsonl"),
            &second_session_id,
            "Second session",
            "2026-03-20T10:00:01Z",
        );

        let first_refresh = refresh_session_catalog(&connection, &context, &HashSet::new())
            .expect("first refresh should succeed");
        assert_eq!(first_refresh.parsed_files, 2);

        let second_refresh = refresh_session_catalog(&connection, &context, &HashSet::new())
            .expect("second refresh should succeed");
        assert_eq!(second_refresh.parsed_files, 0);

        std::thread::sleep(std::time::Duration::from_millis(5));
        fs::write(
            &first_path,
            format!(
                "{}\n{}\n{}\n{}\n",
                json!({
                    "type": "session",
                    "version": 3,
                    "id": first_session_id.clone(),
                    "timestamp": "2026-03-20T10:00:00Z",
                    "cwd": context.project_root.display().to_string(),
                }),
                json!({
                    "type": "session_info",
                    "id": "info-updated",
                    "parentId": Value::Null,
                    "timestamp": "2026-03-20T10:00:00Z",
                    "name": "First session",
                }),
                json!({
                    "type": "message",
                    "id": "msg-1",
                    "timestamp": "2026-03-20T10:00:00Z",
                    "message": {
                        "role": "assistant",
                        "content": [{ "type": "text", "text": "before update" }],
                        "timestamp": 1773835261000i64,
                    }
                }),
                json!({
                    "type": "message",
                    "id": "msg-2",
                    "timestamp": "2026-03-20T10:05:00Z",
                    "message": {
                        "role": "user",
                        "content": "updated",
                        "timestamp": 1773835561000i64,
                    }
                })
            ),
        )
        .expect("updated session file should be writable");

        let third_refresh = refresh_session_catalog(&connection, &context, &HashSet::new())
            .expect("third refresh should succeed");
        assert_eq!(third_refresh.parsed_files, 1);

        let project_id = format!("project-{}", context.project_slug);
        session_records::repair_session_row_from_transcript_path(
            &connection,
            &first_session_id,
            Some(project_id.as_str()),
            None,
            &first_path,
        )
        .expect("first canonical session repair should succeed");
        session_records::repair_session_row_from_transcript_path(
            &connection,
            &second_session_id,
            Some(project_id.as_str()),
            None,
            &second_path,
        )
        .expect("second canonical session repair should succeed");

        let records =
            list_sessions_with_connection(&connection, &context, &HashSet::new(), &HashSet::new())
                .expect("canonical-backed list should succeed");
        let updated_record = records
            .iter()
            .find(|record| record.id == first_session_id)
            .expect("updated record should remain visible");
        assert_eq!(updated_record.status, "active");
    }

    #[test]
    fn resolve_session_path_with_catalog_repairs_stale_rows() {
        let context = make_catalog_test_context("orchestra-session-catalog-repair");
        let connection = in_memory_session_catalog_connection();
        let session_id = Uuid::new_v4().to_string();
        let session_path = write_catalog_test_session(
            &context,
            &format!("2026-03-20T10-00-00Z_{session_id}.jsonl"),
            &session_id,
            "Repair me",
            "2026-03-20T10:00:00Z",
        );

        connection
            .execute(
                r#"
                INSERT INTO session_catalog (
                    session_id, project_slug, session_path, created_at, updated_at,
                    title, status, file_size, file_mtime_ms, last_indexed_at
                )
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                "#,
                params![
                    session_id.clone(),
                    context.project_slug.clone(),
                    context
                        .session_dir
                        .join("missing.jsonl")
                        .display()
                        .to_string(),
                    "2026-03-20T10:00:00Z",
                    "2026-03-20T10:00:00Z",
                    "Stale entry",
                    "idle",
                    1i64,
                    1i64,
                    "2026-03-20T10:00:00Z",
                ],
            )
            .expect("stale catalog row should insert");

        let resolved = resolve_session_path_with_catalog(&connection, &context, &session_id)
            .expect("catalog lookup should succeed")
            .expect("session should be rediscovered from disk");
        assert_eq!(resolved, session_path);

        let repaired = load_session_catalog_entry(&connection, &session_id)
            .expect("catalog row should reload");
        assert_eq!(
            repaired.expect("catalog row should exist").session_path,
            session_path
        );
    }

    #[test]
    fn lists_real_session_messages_from_jsonl() {
        let root = unique_temp_dir("orchestra-real-session-list");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_id = Uuid::new_v4().to_string();
        let session_path = session_dir.join("sample.jsonl");
        let content = format!(
            "{}\n{}\n{}\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": "2026-03-18T12:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "session_info",
                "id": "abcdef12",
                "parentId": Value::Null,
                "timestamp": "2026-03-18T12:00:01Z",
                "name": "Named session",
            }),
            json!({
                "type": "message",
                "id": "11111111",
                "parentId": "abcdef12",
                "timestamp": "2026-03-18T12:01:00Z",
                "message": {
                    "role": "user",
                    "content": "Hello from Orchestra",
                    "timestamp": 1773835260000i64,
                    "attachments": [],
                }
            }),
            json!({
                "type": "message",
                "id": "22222222",
                "parentId": "11111111",
                "timestamp": "2026-03-18T12:01:01Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Real pi session reply" }],
                    "api": "test",
                    "provider": "test",
                    "model": "stub",
                    "usage": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "totalTokens": 0, "cost": {"input": 0, "output": 0, "cacheRead": 0, "cacheWrite": 0, "total": 0}},
                    "stopReason": "stop",
                    "timestamp": 1773835261000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let mut subscribed = HashSet::new();
        subscribed.insert(session_id.clone());
        let sessions = list_sessions(&session_dir, &subscribed).expect("sessions should list");

        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, session_id);
        assert_eq!(sessions[0].title, "Named session");
        assert!(sessions[0].events.is_empty());
        assert!(sessions[0].subscribed);

        let full_session =
            get_session(&session_dir, &session_id, true).expect("full session should load");
        assert_eq!(full_session.events.len(), 2);
        assert_eq!(full_session.events[0].kind, "user");
        assert_eq!(full_session.events[1].kind, "assistant");
        assert_eq!(full_session.events[1].message, "Real pi session reply");
    }

    #[test]
    fn surfaces_compaction_entries_as_system_events() {
        let root = unique_temp_dir("orchestra-real-session-compaction");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_id = Uuid::new_v4().to_string();
        let session_path = session_dir.join("compaction.jsonl");
        let content = format!(
            "{}\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": "2026-03-18T12:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "compaction",
                "id": "compact-1",
                "parentId": Value::Null,
                "timestamp": "2026-03-18T12:01:00Z",
                "summary": "Earlier discussion summarized to keep the active task in context.",
                "firstKeptEntryId": "msg-2",
                "tokensBefore": 50000,
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let full_session =
            get_session(&session_dir, &session_id, true).expect("full session should load");
        assert_eq!(full_session.events.len(), 1);
        assert_eq!(full_session.events[0].kind, "system");
        assert!(full_session.events[0].message.contains("Session compacted"));
        assert!(full_session.events[0]
            .message
            .contains("Earlier discussion summarized"));
    }

    #[test]
    fn preserves_assistant_thinking_text_from_session_jsonl() {
        let root = unique_temp_dir("orchestra-real-session-thinking");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_id = Uuid::new_v4().to_string();
        let session_path = session_dir.join("thinking.jsonl");
        let content = format!(
            "{}\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": "2026-03-18T12:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "message",
                "id": "assistant-1",
                "timestamp": "2026-03-18T12:01:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        { "type": "thinking", "thinking": "Line one\nLine two\nLine three\nLine four" },
                        { "type": "text", "text": "Visible answer" }
                    ],
                    "timestamp": 1773835261000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let full_session =
            get_session(&session_dir, &session_id, true).expect("full session should load");
        assert_eq!(full_session.events.len(), 1);
        assert_eq!(full_session.events[0].kind, "assistant");
        assert_eq!(full_session.events[0].message, "Visible answer");
        assert_eq!(
            full_session.events[0].thinking_text.as_deref(),
            Some("Line one\nLine two\nLine three\nLine four")
        );
    }

    #[test]
    fn parses_tool_calls_and_results_from_session_jsonl() {
        let root = unique_temp_dir("orchestra-real-session-tools");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_id = Uuid::new_v4().to_string();
        let session_path = session_dir.join("tools.jsonl");
        let content = format!(
            "{}\n{}\n{}\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": session_id,
                "timestamp": "2026-03-20T10:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "message",
                "id": "11111111",
                "timestamp": "2026-03-20T10:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [
                        {
                            "type": "toolUse",
                            "toolCallId": "call-1",
                            "toolName": "complete_lane_as_success",
                            "input": {"taskId": "task-1", "notes": "done"}
                        }
                    ],
                    "timestamp": 1774000801000i64,
                }
            }),
            json!({
                "type": "message",
                "id": "22222222",
                "timestamp": "2026-03-20T10:00:02Z",
                "message": {
                    "role": "toolResult",
                    "toolName": "complete_lane_as_success",
                    "content": [{ "type": "text", "text": "{\"id\":\"task-1\",\"status\":\"done\"}" }],
                    "timestamp": 1774000802000i64,
                }
            }),
            json!({
                "type": "message",
                "id": "33333333",
                "timestamp": "2026-03-20T10:00:03Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Task completed." }],
                    "timestamp": 1774000803000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let parsed = parse_session_file(&session_path, true).expect("session should parse");
        assert_eq!(parsed.record.events.len(), 3);
        assert_eq!(parsed.record.events[0].kind, "system");
        assert!(parsed.record.events[0]
            .message
            .contains("Tool call: complete_lane_as_success"));
        assert!(parsed.record.events[0].message.contains("task-1"));
        assert_eq!(parsed.record.events[1].kind, "system");
        assert!(parsed.record.events[1]
            .message
            .contains("complete_lane_as_success tool result"));
        assert_eq!(parsed.record.events[2].kind, "assistant");
        assert_eq!(parsed.record.events[2].message, "Task completed.");
    }

    #[test]
    fn tolerates_incomplete_trailing_json_while_session_is_being_written() {
        let root = unique_temp_dir("orchestra-real-session-partial-tail");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_path = session_dir.join("partial.jsonl");
        let content = format!(
            "{}\n{}\n{}\n{{\"type\":\"message\",\"id\":\"msg-2\"",
            json!({
                "type": "session",
                "version": 3,
                "id": "session-partial",
                "timestamp": "2026-03-20T10:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "session_info",
                "id": "info-1",
                "parentId": Value::Null,
                "timestamp": "2026-03-20T10:00:00Z",
                "name": "Partially written session",
            }),
            json!({
                "type": "message",
                "id": "msg-1",
                "timestamp": "2026-03-20T10:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Visible before tail write finishes" }],
                    "timestamp": 1774000801000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let parsed = parse_session_file(&session_path, true)
            .expect("session should parse despite partial tail");
        assert_eq!(parsed.record.id, "session-partial");
        assert_eq!(parsed.record.title, "Partially written session");
        assert_eq!(parsed.record.events.len(), 1);
        assert_eq!(
            parsed.record.events[0].message,
            "Visible before tail write finishes"
        );
    }

    #[test]
    fn lists_session_summaries_while_trailing_json_is_still_incomplete() {
        let root = unique_temp_dir("orchestra-real-session-partial-tail-summary");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_path = session_dir.join("partial-summary.jsonl");
        let content = format!(
            "{}\n{}\n{}\n{{\"type\":\"message\",\"id\":\"msg-2\"",
            json!({
                "type": "session",
                "version": 3,
                "id": "session-partial-summary",
                "timestamp": "2026-03-20T10:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "session_info",
                "id": "info-1",
                "parentId": Value::Null,
                "timestamp": "2026-03-20T10:00:00Z",
                "name": "Partially written summary session",
            }),
            json!({
                "type": "message",
                "id": "msg-1",
                "timestamp": "2026-03-20T10:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Still visible in the list" }],
                    "timestamp": 1774000801000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let sessions = list_sessions(&session_dir, &HashSet::new())
            .expect("session summaries should list despite partial tail");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "session-partial-summary");
        assert_eq!(sessions[0].title, "Partially written summary session");
    }

    #[test]
    fn lists_session_summaries_even_if_live_body_tail_is_temporarily_unparseable() {
        let root = unique_temp_dir("orchestra-real-session-malformed-summary");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_path = session_dir.join("malformed-summary.jsonl");
        let content = format!(
            "{}\n{}\n{{\"type\":\"message\",\"id\":\"bad\"\n",
            json!({
                "type": "session",
                "version": 3,
                "id": "session-malformed-summary",
                "timestamp": "2026-03-20T10:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "session_info",
                "id": "info-1",
                "parentId": Value::Null,
                "timestamp": "2026-03-20T10:00:00Z",
                "name": "Malformed summary session",
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let sessions = list_sessions(&session_dir, &HashSet::new())
            .expect("session summaries should still list despite temporary tail parse failure");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "session-malformed-summary");
        assert_eq!(sessions[0].title, "Malformed summary session");
    }

    #[test]
    fn falls_back_to_a_header_only_summary_when_a_non_tail_line_is_corrupted() {
        let root = unique_temp_dir("orchestra-real-session-bad-middle-summary");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        fs::create_dir_all(&project_root).expect("project root should exist");
        fs::create_dir_all(&session_dir).expect("session dir should exist");

        let session_path = session_dir.join("bad-middle-summary.jsonl");
        let content = format!(
            "{}\n{{\"type\":\"session_info\"\n{}\n",
            json!({
                "type": "session",
                "version": 3,
                "id": "session-bad-middle-summary",
                "timestamp": "2026-03-20T10:00:00Z",
                "cwd": project_root.display().to_string(),
            }),
            json!({
                "type": "message",
                "id": "msg-1",
                "timestamp": "2026-03-20T10:00:01Z",
                "message": {
                    "role": "assistant",
                    "content": [{ "type": "text", "text": "Visible after corrupted middle" }],
                    "timestamp": 1774000801000i64,
                }
            })
        );
        fs::write(&session_path, content).expect("session file should be writable");

        let sessions = list_sessions(&session_dir, &HashSet::new())
            .expect("list view should fall back to the header instead of dropping the session");
        assert_eq!(sessions.len(), 1);
        assert_eq!(sessions[0].id, "session-bad-middle-summary");
        assert_eq!(sessions[0].title, "Session session-");
    }

    #[test]
    fn prompts_real_session_through_rpc_process_and_emits_deltas() {
        let root = unique_temp_dir("orchestra-real-session-rpc");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        let fake_pi = root.join("fake-pi.mjs");
        fs::create_dir_all(&project_root).expect("project root should exist");
        write_fake_pi_executable(&fake_pi);

        let stored = create_session_file(&project_root, &session_dir, Some("RPC session"), true)
            .expect("session should be created");

        let mut events = Vec::new();
        let updated = stream_prompt_session_with_executable(
            &project_root,
            &session_dir,
            &stored.record.id,
            "Hello from the UI",
            true,
            &fake_pi,
            |event| events.push(event),
        )
        .expect("prompt should succeed");

        assert_eq!(updated.title, "RPC session");
        assert!(events.iter().any(|event| event.event == "text_start"));
        assert!(events
            .iter()
            .any(|event| event.delta.as_deref() == Some("Echo: ")));
        assert!(updated
            .events
            .iter()
            .any(|event| event.kind == "user" && event.message == "Hello from the UI"));
        assert!(updated
            .events
            .iter()
            .any(|event| event.kind == "assistant" && event.message == "Echo: Hello from the UI"));
    }

    #[test]
    fn queries_and_updates_session_model_via_rpc() {
        let root = unique_temp_dir("orchestra-real-session-models");
        let project_root = root.join("project");
        let session_dir = root.join("sessions");
        let fake_pi = root.join("fake-pi.mjs");
        fs::create_dir_all(&project_root).expect("project root should exist");
        write_fake_pi_executable(&fake_pi);

        let stored = create_session_file(&project_root, &session_dir, Some("Model session"), true)
            .expect("session should be created");

        let before = get_session_model_state_with_executable(
            &project_root,
            &session_dir,
            &stored.record.id,
            &fake_pi,
        )
        .expect("initial model state should load");
        assert_eq!(
            before
                .current_model
                .as_ref()
                .map(|model| model.provider.as_str()),
            Some("anthropic")
        );
        assert_eq!(before.available_models.len(), 2);
        assert_eq!(before.current_thinking_level, "off");

        let after = set_session_model_with_executable(
            &project_root,
            &session_dir,
            &stored.record.id,
            "openai-codex",
            "gpt-5.4",
            &fake_pi,
        )
        .expect("model should update");

        assert_eq!(
            after.current_model.as_ref().map(|model| model.id.as_str()),
            Some("gpt-5.4")
        );

        let after_thinking = set_session_thinking_level_with_executable(
            &project_root,
            &session_dir,
            &stored.record.id,
            "high",
            &fake_pi,
        )
        .expect("thinking level should update");

        assert_eq!(after_thinking.current_thinking_level, "high");
    }

    #[test]
    fn loads_large_model_catalog_without_stdin_eof_truncation() {
        let root = unique_temp_dir("orchestra-real-session-large-model-catalog");
        let project_root = root.join("project");
        let fake_pi = root.join("fake-streaming-pi.mjs");
        fs::create_dir_all(&project_root).expect("project root should exist");
        write_fake_streaming_query_pi_executable(&fake_pi);

        let models = list_available_models_with_executable(&fake_pi)
            .expect("large model catalog should load without truncation");

        assert_eq!(models.len(), 500);
        assert_eq!(
            models.first().map(|model| model.id.as_str()),
            Some("huge-model-0")
        );
        assert_eq!(
            models.last().map(|model| model.id.as_str()),
            Some("huge-model-499")
        );
    }

    #[test]
    fn classifies_missing_bun_model_discovery_failures() {
        let root = unique_temp_dir("orchestra-real-session-missing-bun-models");
        let project_root = root.join("project");
        let fake_pi = root.join("fake-missing-bun-pi.mjs");
        fs::create_dir_all(&project_root).expect("project root should exist");
        write_fake_missing_bun_query_pi_executable(&fake_pi);

        let error = list_available_models_with_executable(&fake_pi)
            .expect_err("missing bun model discovery should fail");

        assert_eq!(
            classify_model_discovery_error(&error),
            Some(ModelDiscoveryErrorKind::MissingBun)
        );
        assert!(error.contains("Bun is not available on PATH used for Orchestra subprocesses"));
        assert!(error.contains("Settings → Harness"));
        assert!(!error.contains("bun pm bin -g"));
        assert!(!error.contains("resolvePackageSources"));
    }

    #[test]
    fn list_available_models_sets_runtime_managed_npm_prefix() {
        let root = unique_temp_dir("orchestra-real-session-models-prefix");
        let project_root = root.join("project");
        let fake_pi = root.join("fake-prefix-guarded-pi.mjs");
        fs::create_dir_all(&project_root).expect("project root should exist");
        write_fake_npm_prefix_guarded_query_pi_executable(&fake_pi);

        let models = list_available_models_with_executable(&fake_pi)
            .expect("model discovery should succeed when Orchestra provides npm prefix env");

        assert_eq!(models.len(), 1);
        assert_eq!(models[0].id, "claude-sonnet-4-20250514");
    }
}
