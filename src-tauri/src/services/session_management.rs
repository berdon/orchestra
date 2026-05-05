use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
};

#[cfg(test)]
use rusqlite::params;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use tauri::AppHandle;
use uuid::Uuid;

use crate::{
    commands::sessions::{decorate_session_record_with_connection, SessionDecorationSurface},
    models::{SessionRecord, SessionRuntimeDetails},
    services::{
        app_events, domain_events, live_sessions, pi_sessions, projects, session_list,
        session_records,
    },
    state::AppState,
};

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionManagementQuery {
    #[serde(default)]
    pub project_id: Option<String>,
    #[serde(default)]
    pub project_slug: Option<String>,
    #[serde(default)]
    pub session_ids: Vec<String>,
    #[serde(default)]
    pub query: Option<String>,
    #[serde(default)]
    pub status: Option<String>,
    #[serde(default)]
    pub task_id: Option<String>,
    #[serde(default)]
    pub task_number: Option<String>,
    #[serde(default)]
    pub worker_type: Option<String>,
    #[serde(default)]
    pub worker_name: Option<String>,
    #[serde(default)]
    pub hidden: Option<bool>,
    #[serde(default)]
    pub dismissed: Option<bool>,
    #[serde(default)]
    pub catalog_present: Option<bool>,
    #[serde(default)]
    pub legacy_catalog_present: Option<bool>,
    #[serde(default)]
    pub legacy_list_entry_present: Option<bool>,
    #[serde(default)]
    pub file_exists: Option<bool>,
    #[serde(default)]
    pub limit: Option<usize>,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMutationInput {
    #[serde(flatten)]
    pub query: SessionManagementQuery,
    #[serde(default)]
    pub reason: Option<String>,
    #[serde(default = "default_true")]
    pub dry_run: bool,
    #[serde(default)]
    pub confirm: bool,
    #[serde(default)]
    pub stop_active_runtimes: bool,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionReconcileInput {
    #[serde(flatten)]
    pub query: SessionManagementQuery,
    #[serde(default = "default_true")]
    pub dry_run: bool,
    #[serde(default)]
    pub confirm: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSessionSummary {
    pub session_id: String,
    pub project_id: Option<String>,
    pub project_slug: Option<String>,
    pub title: String,
    pub status: String,
    pub task_id: Option<String>,
    pub task_number: Option<String>,
    pub task_title: Option<String>,
    pub active_task_id: Option<String>,
    pub active_task_number: Option<String>,
    pub active_task_title: Option<String>,
    pub worker_type: Option<String>,
    pub worker_name: Option<String>,
    pub hidden: bool,
    pub dismissed: bool,
    pub hidden_reason: Option<String>,
    pub dismissed_at: Option<String>,
    pub transcript_path: Option<String>,
    pub catalog_present: bool,
    pub legacy_catalog_present: bool,
    pub legacy_list_entry_present: bool,
    pub file_exists: bool,
    pub derived_session_id: Option<String>,
    pub header_session_id: Option<String>,
    pub runtime_active: bool,
    pub runtime_running: bool,
    pub runtime_run_id: Option<String>,
    pub subscribed: bool,
    pub terminal_attached: bool,
    pub run_origin_count: usize,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionCatalogDiagnostic {
    pub session_id: String,
    pub project_slug: String,
    pub session_path: String,
    pub created_at: String,
    pub updated_at: String,
    pub title: String,
    pub status: String,
    pub file_size: u64,
    pub file_mtime_ms: i64,
    pub last_indexed_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionListEntryDiagnostic {
    pub session_id: String,
    pub dismissed_at: Option<String>,
    pub hidden_reason: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionTranscriptDiagnostic {
    pub path: String,
    pub file_exists: bool,
    pub file_size: Option<u64>,
    pub file_mtime_ms: Option<i64>,
    pub derived_session_id: Option<String>,
    pub header_session_id: Option<String>,
    pub parse_error: Option<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRunOriginDiagnostic {
    pub run_id: String,
    pub source_type: String,
    pub channel_id: Option<String>,
    pub channel_activity_id: Option<String>,
    pub project_id: Option<String>,
    pub created_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionRuntimeDiagnostic {
    pub runtime_active: bool,
    pub runtime_running: bool,
    pub runtime_run_id: Option<String>,
    pub subscribed: bool,
    pub terminal_attached: bool,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDiagnostics {
    pub summary: ManagedSessionSummary,
    pub record: Option<SessionRecord>,
    pub catalog: Option<SessionCatalogDiagnostic>,
    pub list_entry: Option<SessionListEntryDiagnostic>,
    pub transcript: Option<SessionTranscriptDiagnostic>,
    pub run_origins: Vec<SessionRunOriginDiagnostic>,
    pub runtime: SessionRuntimeDiagnostic,
    pub runtime_details: Option<SessionRuntimeDetails>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMutationItem {
    pub session_id: String,
    pub title: String,
    pub transcript_path: Option<String>,
    pub hidden_reason: Option<String>,
    pub runtime_active: bool,
    pub runtime_running: bool,
    pub actions: Vec<String>,
    pub skipped_reasons: Vec<String>,
    pub issues: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionMutationResult {
    pub dry_run: bool,
    pub matched_count: usize,
    pub executed_count: usize,
    pub skipped_count: usize,
    pub changed_session_ids: Vec<String>,
    pub sessions: Vec<SessionMutationItem>,
    pub notes: Vec<String>,
}

#[derive(Debug, Clone)]
struct SessionCatalogRow {
    session_id: String,
    project_slug: String,
    session_path: PathBuf,
    created_at: String,
    updated_at: String,
    title: String,
    status: String,
    file_size: u64,
    file_mtime_ms: i64,
    last_indexed_at: String,
}

#[derive(Debug, Clone)]
struct SessionListRow {
    session_id: String,
    dismissed_at: Option<String>,
    hidden_reason: Option<String>,
    created_at: String,
    updated_at: String,
}

#[derive(Debug, Clone)]
struct SessionRunOriginRow {
    run_id: String,
    session_id: String,
    source_type: String,
    channel_id: Option<String>,
    channel_activity_id: Option<String>,
    project_id: Option<String>,
    created_at: String,
}

#[derive(Debug, Clone)]
struct TranscriptFileRecord {
    path: PathBuf,
    file_size: u64,
    file_mtime_ms: i64,
    derived_session_id: Option<String>,
    header_session_id: Option<String>,
    parse_error: Option<String>,
    title: Option<String>,
    status: Option<String>,
}

#[derive(Debug, Clone)]
struct RuntimeSnapshot {
    runtime_active: bool,
    runtime_running: bool,
    runtime_run_id: Option<String>,
    subscribed: bool,
    terminal_attached: bool,
}

#[derive(Debug, Clone)]
struct InventoryEntry {
    session_id: String,
    project_id: Option<String>,
    project_slug: Option<String>,
    context: Option<pi_sessions::SessionContext>,
    canonical: Option<session_records::CanonicalSessionRow>,
    catalog: Option<SessionCatalogRow>,
    list_entry: Option<SessionListRow>,
    transcript: Option<TranscriptFileRecord>,
    run_origins: Vec<SessionRunOriginRow>,
    record: Option<SessionRecord>,
    runtime: RuntimeSnapshot,
    issues: Vec<String>,
}

fn default_true() -> bool {
    true
}

fn normalize_optional_string(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_query(query: &mut SessionManagementQuery) {
    query.project_id = normalize_optional_string(query.project_id.take());
    query.project_slug = normalize_optional_string(query.project_slug.take());
    query.query = normalize_optional_string(query.query.take()).map(|value| value.to_lowercase());
    query.status = normalize_optional_string(query.status.take()).map(|value| value.to_lowercase());
    query.task_id = normalize_optional_string(query.task_id.take());
    query.task_number =
        normalize_optional_string(query.task_number.take()).map(|value| value.to_lowercase());
    query.worker_type =
        normalize_optional_string(query.worker_type.take()).map(|value| value.to_lowercase());
    query.worker_name =
        normalize_optional_string(query.worker_name.take()).map(|value| value.to_lowercase());
    query.session_ids = query
        .session_ids
        .drain(..)
        .filter_map(|value| {
            let trimmed = value.trim();
            (!trimmed.is_empty()).then(|| trimmed.to_string())
        })
        .collect();
}

fn query_has_explicit_target(query: &SessionManagementQuery) -> bool {
    query.project_id.is_some()
        || query.project_slug.is_some()
        || !query.session_ids.is_empty()
        || query.query.is_some()
        || query.status.is_some()
        || query.task_id.is_some()
        || query.task_number.is_some()
        || query.worker_type.is_some()
        || query.worker_name.is_some()
        || query.hidden.is_some()
        || query.dismissed.is_some()
        || query.catalog_present.is_some()
        || query.legacy_catalog_present.is_some()
        || query.legacy_list_entry_present.is_some()
        || query.file_exists.is_some()
}

fn lower(value: Option<&str>) -> Option<String> {
    value.map(|value| value.to_lowercase())
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

fn parse_session_header_id(path: &Path) -> Result<String, String> {
    let content = fs::read_to_string(path)
        .map_err(|error| format!("Unable to read session file {}: {error}", path.display()))?;
    let first_line = content
        .lines()
        .next()
        .ok_or_else(|| format!("Session file {} is empty", path.display()))?;
    let header: serde_json::Value = serde_json::from_str(first_line).map_err(|error| {
        format!(
            "Unable to parse session header {} as JSON: {error}",
            path.display()
        )
    })?;
    header
        .get("id")
        .and_then(serde_json::Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| format!("Session file {} is missing a header id", path.display()))
}

fn truncate_title(input: &str) -> String {
    let collapsed = input.split_whitespace().collect::<Vec<_>>().join(" ");
    let trimmed = collapsed.trim();
    if trimmed.chars().count() <= 80 {
        trimmed.to_string()
    } else {
        format!("{}…", trimmed.chars().take(79).collect::<String>())
    }
}

fn summarize_transcript(path: &Path) -> (Option<String>, Option<String>) {
    let content = match fs::read_to_string(path) {
        Ok(content) => content,
        Err(_) => return (None, None),
    };

    let mut first_user_message = None;
    let mut last_visible_role = None;
    for line in content.lines().skip(1) {
        let Ok(value) = serde_json::from_str::<serde_json::Value>(line) else {
            continue;
        };
        if value.get("type").and_then(serde_json::Value::as_str) != Some("message") {
            continue;
        }
        let Some(message) = value.get("message") else {
            continue;
        };
        let role = message
            .get("role")
            .and_then(serde_json::Value::as_str)
            .unwrap_or_default();
        let text = message
            .get("content")
            .and_then(serde_json::Value::as_array)
            .and_then(|items| {
                items.iter().find_map(|item| {
                    if item.get("type").and_then(serde_json::Value::as_str) == Some("text") {
                        item.get("text").and_then(serde_json::Value::as_str)
                    } else {
                        None
                    }
                })
            })
            .map(str::trim)
            .filter(|value| !value.is_empty());

        match role {
            "user" => {
                if first_user_message.is_none() {
                    first_user_message = text.map(truncate_title);
                }
                if text.is_some() {
                    last_visible_role = Some("user");
                }
            }
            "assistant" => {
                if text.is_some() {
                    last_visible_role = Some("assistant");
                }
            }
            _ => {}
        }
    }

    (
        first_user_message,
        Some(match last_visible_role {
            Some("user") => "active".to_string(),
            _ => "idle".to_string(),
        }),
    )
}

fn session_file_fingerprint(path: &Path) -> Result<(u64, i64), String> {
    let metadata = fs::metadata(path)
        .map_err(|error| format!("Unable to inspect session file {}: {error}", path.display()))?;
    let modified = metadata.modified().map_err(|error| {
        format!(
            "Unable to inspect session file modified time {}: {error}",
            path.display()
        )
    })?;
    let modified_ms = modified
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|error| {
            format!(
                "Unable to normalize session file modified time {}: {error}",
                path.display()
            )
        })?
        .as_millis() as i64;
    Ok((metadata.len(), modified_ms))
}

fn project_contexts(
    connection: &Connection,
    query: &SessionManagementQuery,
) -> Result<Vec<(Option<String>, pi_sessions::SessionContext)>, String> {
    if let Some(project_id) = query.project_id.as_deref() {
        let project = projects::get_project(connection, project_id)?;
        return Ok(vec![(
            Some(project.id),
            pi_sessions::detect_session_context(Some(&project.slug))?,
        )]);
    }

    if let Some(project_slug) = query.project_slug.as_deref() {
        let project_id =
            projects::get_project_by_slug(connection, project_slug)?.map(|project| project.id);
        return Ok(vec![(
            project_id,
            pi_sessions::detect_session_context(Some(project_slug))?,
        )]);
    }

    let project_ids_by_slug = load_project_ids_by_slug(connection)?;
    project_ids_by_slug
        .into_iter()
        .map(|(project_slug, project_id)| {
            Ok((
                Some(project_id),
                pi_sessions::detect_session_context(Some(&project_slug))?,
            ))
        })
        .collect()
}

fn project_id_for_slug(connection: &Connection, project_slug: &str) -> Option<String> {
    projects::get_project_by_slug(connection, project_slug)
        .ok()
        .flatten()
        .map(|project| project.id)
}

fn load_project_ids_by_slug(connection: &Connection) -> Result<HashMap<String, String>, String> {
    let mut statement = connection
        .prepare("SELECT id, slug FROM projects")
        .map_err(|error| format!("Unable to prepare project id query: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(1)?, row.get::<_, String>(0)?))
        })
        .map_err(|error| format!("Unable to query project ids: {error}"))?;
    rows.collect::<Result<HashMap<_, _>, _>>()
        .map_err(|error| format!("Unable to read project ids: {error}"))
}

fn load_session_catalog_rows(
    connection: &Connection,
    project_slugs: &HashSet<String>,
) -> Result<Vec<SessionCatalogRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT session_id, project_slug, session_path, created_at, updated_at, title, status,
                   file_size, file_mtime_ms, last_indexed_at
            FROM session_catalog
            ORDER BY updated_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare session catalog scan: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SessionCatalogRow {
                session_id: row.get(0)?,
                project_slug: row.get(1)?,
                session_path: PathBuf::from(row.get::<_, String>(2)?),
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
                title: row.get(5)?,
                status: row.get(6)?,
                file_size: row.get::<_, i64>(7)? as u64,
                file_mtime_ms: row.get(8)?,
                last_indexed_at: row.get(9)?,
            })
        })
        .map_err(|error| format!("Unable to query session catalog: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read session catalog: {error}"))
        .map(|rows| {
            rows.into_iter()
                .filter(|row| project_slugs.is_empty() || project_slugs.contains(&row.project_slug))
                .collect()
        })
}

fn load_session_list_rows(connection: &Connection) -> Result<Vec<SessionListRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT session_id, dismissed_at, hidden_reason, created_at, updated_at
            FROM session_list_entries
            "#,
        )
        .map_err(|error| format!("Unable to prepare session list scan: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SessionListRow {
                session_id: row.get(0)?,
                dismissed_at: row.get(1)?,
                hidden_reason: row.get(2)?,
                created_at: row.get(3)?,
                updated_at: row.get(4)?,
            })
        })
        .map_err(|error| format!("Unable to query session list entries: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read session list entries: {error}"))
}

fn load_session_run_origins(connection: &Connection) -> Result<Vec<SessionRunOriginRow>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT run_id, session_id, source_type, channel_id, channel_activity_id, project_id, created_at
            FROM session_run_origins
            ORDER BY created_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare session run origins scan: {error}"))?;
    let rows = statement
        .query_map([], |row| {
            Ok(SessionRunOriginRow {
                run_id: row.get(0)?,
                session_id: row.get(1)?,
                source_type: row.get(2)?,
                channel_id: row.get(3)?,
                channel_activity_id: row.get(4)?,
                project_id: row.get(5)?,
                created_at: row.get(6)?,
            })
        })
        .map_err(|error| format!("Unable to query session run origins: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read session run origins: {error}"))
}

fn scan_transcript_files(
    contexts: &[(Option<String>, pi_sessions::SessionContext)],
) -> Result<
    HashMap<
        String,
        (
            Option<String>,
            pi_sessions::SessionContext,
            TranscriptFileRecord,
        ),
    >,
    String,
> {
    let mut files: HashMap<
        String,
        (
            Option<String>,
            pi_sessions::SessionContext,
            TranscriptFileRecord,
        ),
    > = HashMap::new();

    for (project_id, context) in contexts {
        fs::create_dir_all(&context.session_dir).map_err(|error| {
            format!(
                "Unable to create session directory {}: {error}",
                context.session_dir.display()
            )
        })?;

        let entries = fs::read_dir(&context.session_dir).map_err(|error| {
            format!(
                "Unable to read session directory {}: {error}",
                context.session_dir.display()
            )
        })?;

        for entry in entries {
            let entry =
                entry.map_err(|error| format!("Unable to inspect session file entry: {error}"))?;
            let path = entry.path();
            if path.extension().and_then(|value| value.to_str()) != Some("jsonl") {
                continue;
            }

            let (file_size, file_mtime_ms) = session_file_fingerprint(&path)?;
            let derived_session_id = derive_session_id_from_path(&path);
            let header_result = parse_session_header_id(&path);
            let header_session_id = header_result.as_ref().ok().cloned();
            let parse_error = header_result.err();
            let session_id = header_session_id
                .clone()
                .or_else(|| derived_session_id.clone())
                .unwrap_or_else(|| {
                    path.file_stem()
                        .and_then(|value| value.to_str())
                        .unwrap_or("unknown")
                        .to_string()
                });

            let (title, status) = summarize_transcript(&path);
            let transcript = TranscriptFileRecord {
                path: path.clone(),
                file_size,
                file_mtime_ms,
                derived_session_id,
                header_session_id,
                parse_error,
                title,
                status,
            };

            let replace_existing = match files.get(&session_id) {
                Some(existing) => existing.2.file_mtime_ms <= transcript.file_mtime_ms,
                None => true,
            };
            if replace_existing {
                files.insert(
                    session_id,
                    (project_id.clone(), context.clone(), transcript),
                );
            }
        }
    }

    Ok(files)
}

fn runtime_snapshot(state: Option<&AppState>, session_id: &str) -> RuntimeSnapshot {
    let Some(state) = state else {
        return RuntimeSnapshot {
            runtime_active: false,
            runtime_running: false,
            runtime_run_id: None,
            subscribed: false,
            terminal_attached: false,
        };
    };

    RuntimeSnapshot {
        runtime_active: live_sessions::maybe_runtime(&state.session_runtimes, session_id).is_some(),
        runtime_running: state.is_session_running(session_id).unwrap_or(false),
        runtime_run_id: state.active_session_run_id(session_id).ok().flatten(),
        subscribed: state
            .subscribed_session_ids()
            .map(|sessions| sessions.contains(session_id))
            .unwrap_or(false),
        terminal_attached: state
            .terminal_attached_session_ids()
            .map(|sessions| sessions.contains(session_id))
            .unwrap_or(false),
    }
}

fn build_inventory(
    connection: &Connection,
    state: Option<&AppState>,
    query: &SessionManagementQuery,
) -> Result<Vec<InventoryEntry>, String> {
    let contexts = project_contexts(connection, query)?;
    let project_slugs = contexts
        .iter()
        .map(|(_, context)| context.project_slug.clone())
        .collect::<HashSet<_>>();
    let terminal_attached = state
        .map(|state| state.terminal_attached_session_ids())
        .transpose()?
        .unwrap_or_default();

    let canonical_rows =
        session_records::list_session_rows(connection, query.project_id.as_deref(), None)?;
    let catalog_rows = load_session_catalog_rows(connection, &project_slugs)?;
    let list_rows = load_session_list_rows(connection)?;
    let run_origin_rows = load_session_run_origins(connection)?;
    let files = scan_transcript_files(&contexts)?;

    let mut entries = HashMap::<String, InventoryEntry>::new();

    for canonical in canonical_rows {
        let session_id = canonical.id.clone();
        let project_slug = canonical.project_slug.clone();
        let context = project_slug
            .as_deref()
            .and_then(|project_slug| pi_sessions::detect_session_context(Some(project_slug)).ok());
        let base_record = canonical.to_record(runtime_snapshot(state, &session_id).subscribed);
        let record = decorate_session_record_with_connection(
            connection,
            &terminal_attached,
            base_record.clone(),
            true,
            SessionDecorationSurface::Detail,
        )
        .ok()
        .or(Some(base_record));
        entries.insert(
            session_id.clone(),
            InventoryEntry {
                session_id: session_id.clone(),
                project_id: canonical.project_id.clone(),
                project_slug,
                context,
                canonical: Some(canonical),
                catalog: None,
                list_entry: None,
                transcript: None,
                run_origins: Vec::new(),
                record,
                runtime: runtime_snapshot(state, &session_id),
                issues: Vec::new(),
            },
        );
    }

    for catalog in catalog_rows {
        let session_id = catalog.session_id.clone();
        let project_slug = catalog.project_slug.clone();
        let project_id = project_id_for_slug(connection, &project_slug);
        let context = pi_sessions::detect_session_context(Some(&project_slug)).ok();
        entries
            .entry(session_id.clone())
            .or_insert_with(|| InventoryEntry {
                session_id: session_id.clone(),
                project_id,
                project_slug: Some(project_slug),
                context,
                canonical: None,
                catalog: None,
                list_entry: None,
                transcript: None,
                run_origins: Vec::new(),
                record: None,
                runtime: runtime_snapshot(state, &session_id),
                issues: Vec::new(),
            })
            .catalog = Some(catalog);
    }

    for (session_id, (project_id, context, transcript)) in files {
        entries
            .entry(session_id.clone())
            .or_insert_with(|| InventoryEntry {
                session_id: session_id.clone(),
                project_id,
                project_slug: Some(context.project_slug.clone()),
                context: Some(context.clone()),
                canonical: None,
                catalog: None,
                list_entry: None,
                transcript: None,
                run_origins: Vec::new(),
                record: None,
                runtime: runtime_snapshot(state, &session_id),
                issues: Vec::new(),
            })
            .transcript = Some(transcript);
    }

    for list_entry in list_rows {
        let session_id = list_entry.session_id.clone();
        entries
            .entry(session_id.clone())
            .or_insert_with(|| InventoryEntry {
                session_id: session_id.clone(),
                project_id: None,
                project_slug: None,
                context: None,
                canonical: None,
                catalog: None,
                list_entry: None,
                transcript: None,
                run_origins: Vec::new(),
                record: None,
                runtime: runtime_snapshot(state, &session_id),
                issues: Vec::new(),
            })
            .list_entry = Some(list_entry);
    }

    for run_origin in run_origin_rows {
        let session_id = run_origin.session_id.clone();
        entries
            .entry(session_id.clone())
            .or_insert_with(|| InventoryEntry {
                session_id: session_id.clone(),
                project_id: None,
                project_slug: None,
                context: None,
                canonical: None,
                catalog: None,
                list_entry: None,
                transcript: None,
                run_origins: Vec::new(),
                record: None,
                runtime: runtime_snapshot(state, &session_id),
                issues: Vec::new(),
            })
            .run_origins
            .push(run_origin);
    }

    for entry in entries.values_mut() {
        if entry.project_slug.is_none() {
            entry.project_slug = entry
                .canonical
                .as_ref()
                .and_then(|canonical| canonical.project_slug.clone())
                .or_else(|| {
                    entry
                        .catalog
                        .as_ref()
                        .map(|catalog| catalog.project_slug.clone())
                })
                .or_else(|| {
                    entry
                        .context
                        .as_ref()
                        .map(|context| context.project_slug.clone())
                });
        }
        if entry.project_id.is_none() {
            entry.project_id = entry
                .canonical
                .as_ref()
                .and_then(|canonical| canonical.project_id.clone())
                .or_else(|| {
                    entry
                        .project_slug
                        .as_deref()
                        .and_then(|project_slug| project_id_for_slug(connection, project_slug))
                });
        }
        if entry.context.is_none() {
            entry.context = entry.project_slug.as_deref().and_then(|project_slug| {
                pi_sessions::detect_session_context(Some(project_slug)).ok()
            });
        }

        if entry.canonical.is_none() {
            entry.issues.push("canonical_missing".into());
        }
        if entry.catalog.is_none() {
            entry.issues.push("catalog_missing".into());
        }
        if entry.transcript.is_none() {
            entry.issues.push("file_missing".into());
        }
        if let Some(transcript) = entry.transcript.as_ref() {
            if let (Some(derived), Some(header)) = (
                transcript.derived_session_id.as_ref(),
                transcript.header_session_id.as_ref(),
            ) {
                if derived != header {
                    entry.issues.push("file_id_mismatch".into());
                }
            }
            if transcript.parse_error.is_some() {
                entry.issues.push("parse_failed".into());
            }
        }
        if let (Some(catalog), Some(transcript)) =
            (entry.catalog.as_ref(), entry.transcript.as_ref())
        {
            if catalog.session_path != transcript.path {
                entry.issues.push("catalog_path_mismatch".into());
            }
        }
        if entry.list_entry.is_some()
            && entry.canonical.is_none()
            && entry.catalog.is_none()
            && entry.transcript.is_none()
        {
            entry.issues.push("orphan_list_entry".into());
        }
        if !entry.run_origins.is_empty()
            && entry.canonical.is_none()
            && entry.catalog.is_none()
            && entry.transcript.is_none()
        {
            entry.issues.push("orphan_run_origin".into());
        }
    }

    let mut values = entries.into_values().collect::<Vec<_>>();
    values.sort_by(|left, right| {
        let right_updated = right
            .record
            .as_ref()
            .map(|record| record.updated_at.as_str())
            .or_else(|| {
                right
                    .catalog
                    .as_ref()
                    .map(|catalog| catalog.updated_at.as_str())
            })
            .or_else(|| {
                right
                    .canonical
                    .as_ref()
                    .map(|canonical| canonical.updated_at.as_str())
            })
            .unwrap_or("");
        let left_updated = left
            .record
            .as_ref()
            .map(|record| record.updated_at.as_str())
            .or_else(|| {
                left.catalog
                    .as_ref()
                    .map(|catalog| catalog.updated_at.as_str())
            })
            .or_else(|| {
                left.canonical
                    .as_ref()
                    .map(|canonical| canonical.updated_at.as_str())
            })
            .unwrap_or("");
        right_updated.cmp(left_updated)
    });
    Ok(values)
}

fn to_summary(entry: &InventoryEntry) -> ManagedSessionSummary {
    let record = entry.record.as_ref();
    let canonical = entry.canonical.as_ref();
    let catalog = entry.catalog.as_ref();
    let list_entry = entry.list_entry.as_ref();
    let hidden_reason = list_entry
        .and_then(|row| {
            row.hidden_reason.clone().or_else(|| {
                row.dismissed_at
                    .as_ref()
                    .map(|_| session_list::SESSION_HIDDEN_REASON_USER_DISMISSED.to_string())
            })
        })
        .or_else(|| canonical.and_then(|row| row.hidden_reason.clone()))
        .or_else(|| {
            canonical.and_then(|row| {
                row.dismissed_at
                    .as_ref()
                    .map(|_| session_list::SESSION_HIDDEN_REASON_USER_DISMISSED.to_string())
            })
        });
    let dismissed =
        hidden_reason.as_deref() == Some(session_list::SESSION_HIDDEN_REASON_USER_DISMISSED);
    let hidden = hidden_reason.is_some();
    ManagedSessionSummary {
        session_id: entry.session_id.clone(),
        project_id: entry.project_id.clone(),
        project_slug: entry.project_slug.clone(),
        title: record
            .map(|record| record.title.clone())
            .or_else(|| canonical.map(|canonical| canonical.effective_title()))
            .or_else(|| catalog.map(|catalog| catalog.title.clone()))
            .or_else(|| {
                entry
                    .transcript
                    .as_ref()
                    .and_then(|transcript| transcript.title.clone())
            })
            .unwrap_or_else(|| {
                format!(
                    "Session {}",
                    &entry.session_id[..entry.session_id.len().min(8)]
                )
            }),
        status: record
            .map(|record| record.status.clone())
            .or_else(|| canonical.map(|canonical| canonical.effective_status()))
            .or_else(|| catalog.map(|catalog| catalog.status.clone()))
            .or_else(|| {
                entry
                    .transcript
                    .as_ref()
                    .and_then(|transcript| transcript.status.clone())
            })
            .unwrap_or_else(|| {
                if hidden {
                    "closed".into()
                } else {
                    "unknown".into()
                }
            }),
        task_id: record
            .and_then(|record| record.task_id.clone())
            .or_else(|| {
                canonical.and_then(|canonical| canonical.effective_task_id().map(str::to_string))
            }),
        task_number: record.and_then(|record| record.task_number.clone()),
        task_title: record.and_then(|record| record.task_title.clone()),
        active_task_id: record.and_then(|record| record.active_task_id.clone()),
        active_task_number: record.and_then(|record| record.active_task_number.clone()),
        active_task_title: record.and_then(|record| record.active_task_title.clone()),
        worker_type: record
            .and_then(|record| record.worker_type.clone())
            .or_else(|| {
                canonical
                    .and_then(|canonical| canonical.effective_worker_type().map(str::to_string))
            }),
        worker_name: record.and_then(|record| record.worker_name.clone()),
        hidden,
        dismissed,
        hidden_reason,
        dismissed_at: list_entry
            .and_then(|row| row.dismissed_at.clone())
            .or_else(|| canonical.and_then(|row| row.dismissed_at.clone())),
        transcript_path: entry
            .transcript
            .as_ref()
            .map(|transcript| transcript.path.display().to_string())
            .or_else(|| canonical.map(|canonical| canonical.session_path.display().to_string()))
            .or_else(|| catalog.map(|catalog| catalog.session_path.display().to_string())),
        catalog_present: catalog.is_some(),
        legacy_catalog_present: catalog.is_some(),
        legacy_list_entry_present: list_entry.is_some(),
        file_exists: entry.transcript.is_some()
            || canonical.is_some_and(|canonical| canonical.transcript_exists),
        derived_session_id: entry
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.derived_session_id.clone()),
        header_session_id: entry
            .transcript
            .as_ref()
            .and_then(|transcript| transcript.header_session_id.clone()),
        runtime_active: entry.runtime.runtime_active,
        runtime_running: entry.runtime.runtime_running,
        runtime_run_id: entry.runtime.runtime_run_id.clone(),
        subscribed: entry.runtime.subscribed,
        terminal_attached: entry.runtime.terminal_attached,
        run_origin_count: entry.run_origins.len(),
        issues: entry.issues.clone(),
    }
}

fn entry_matches_query(entry: &InventoryEntry, query: &SessionManagementQuery) -> bool {
    let summary = to_summary(entry);
    if let Some(project_id) = query.project_id.as_deref() {
        if summary.project_id.as_deref() != Some(project_id) {
            return false;
        }
    }
    if let Some(project_slug) = query.project_slug.as_deref() {
        if summary.project_slug.as_deref() != Some(project_slug) {
            return false;
        }
    }
    if !query.session_ids.is_empty()
        && !query
            .session_ids
            .iter()
            .any(|value| value == &summary.session_id)
    {
        return false;
    }
    if let Some(status) = query.status.as_deref() {
        if summary.status.to_lowercase() != status {
            return false;
        }
    }
    if let Some(task_id) = query.task_id.as_deref() {
        if summary.task_id.as_deref() != Some(task_id)
            && summary.active_task_id.as_deref() != Some(task_id)
        {
            return false;
        }
    }
    if let Some(task_number) = query.task_number.as_deref() {
        let matches_task_number = lower(summary.task_number.as_deref()).as_deref()
            == Some(task_number)
            || lower(summary.active_task_number.as_deref()).as_deref() == Some(task_number);
        if !matches_task_number {
            return false;
        }
    }
    if let Some(worker_type) = query.worker_type.as_deref() {
        if lower(summary.worker_type.as_deref()).as_deref() != Some(worker_type) {
            return false;
        }
    }
    if let Some(worker_name) = query.worker_name.as_deref() {
        if lower(summary.worker_name.as_deref()).as_deref() != Some(worker_name) {
            return false;
        }
    }
    if let Some(hidden) = query.hidden {
        if summary.hidden != hidden {
            return false;
        }
    }
    if let Some(dismissed) = query.dismissed {
        if summary.dismissed != dismissed {
            return false;
        }
    }
    if let Some(catalog_present) = query.legacy_catalog_present.or(query.catalog_present) {
        if summary.legacy_catalog_present != catalog_present {
            return false;
        }
    }
    if let Some(list_entry_present) = query.legacy_list_entry_present {
        if summary.legacy_list_entry_present != list_entry_present {
            return false;
        }
    }
    if let Some(file_exists) = query.file_exists {
        if summary.file_exists != file_exists {
            return false;
        }
    }
    if let Some(filter) = query.query.as_deref() {
        let haystacks = [
            summary.session_id.to_lowercase(),
            summary.title.to_lowercase(),
            summary
                .task_number
                .clone()
                .unwrap_or_default()
                .to_lowercase(),
            summary
                .task_title
                .clone()
                .unwrap_or_default()
                .to_lowercase(),
            summary
                .worker_name
                .clone()
                .unwrap_or_default()
                .to_lowercase(),
        ];
        if !haystacks.iter().any(|value| value.contains(filter)) {
            return false;
        }
    }
    true
}

pub fn list_sessions(
    connection: &Connection,
    state: Option<&AppState>,
    mut query: SessionManagementQuery,
) -> Result<Vec<ManagedSessionSummary>, String> {
    normalize_query(&mut query);
    let mut sessions = build_inventory(connection, state, &query)?
        .into_iter()
        .filter(|entry| entry_matches_query(entry, &query))
        .map(|entry| to_summary(&entry))
        .collect::<Vec<_>>();
    if let Some(limit) = query.limit {
        sessions.truncate(limit);
    }
    Ok(sessions)
}

pub fn get_session_diagnostics(
    connection: &Connection,
    app: Option<&AppHandle>,
    state: Option<&AppState>,
    session_id: &str,
) -> Result<SessionDiagnostics, String> {
    let mut query = SessionManagementQuery::default();
    query.session_ids = vec![session_id.to_string()];
    let entry = build_inventory(connection, state, &query)?
        .into_iter()
        .find(|entry| entry.session_id == session_id)
        .ok_or_else(|| format!("Session {session_id} was not found"))?;

    let runtime_details = match (app, state) {
        (Some(app), Some(state)) => {
            live_sessions::get_session_runtime_details(app, state, session_id).ok()
        }
        _ => None,
    };

    Ok(SessionDiagnostics {
        summary: to_summary(&entry),
        record: entry.record,
        catalog: entry.catalog.map(|catalog| SessionCatalogDiagnostic {
            session_id: catalog.session_id,
            project_slug: catalog.project_slug,
            session_path: catalog.session_path.display().to_string(),
            created_at: catalog.created_at,
            updated_at: catalog.updated_at,
            title: catalog.title,
            status: catalog.status,
            file_size: catalog.file_size,
            file_mtime_ms: catalog.file_mtime_ms,
            last_indexed_at: catalog.last_indexed_at,
        }),
        list_entry: entry
            .list_entry
            .map(|list_entry| SessionListEntryDiagnostic {
                session_id: list_entry.session_id,
                dismissed_at: list_entry.dismissed_at,
                hidden_reason: list_entry.hidden_reason,
                created_at: list_entry.created_at,
                updated_at: list_entry.updated_at,
            }),
        transcript: entry
            .transcript
            .map(|transcript| SessionTranscriptDiagnostic {
                path: transcript.path.display().to_string(),
                file_exists: true,
                file_size: Some(transcript.file_size),
                file_mtime_ms: Some(transcript.file_mtime_ms),
                derived_session_id: transcript.derived_session_id,
                header_session_id: transcript.header_session_id,
                parse_error: transcript.parse_error,
            }),
        run_origins: entry
            .run_origins
            .into_iter()
            .map(|origin| SessionRunOriginDiagnostic {
                run_id: origin.run_id,
                source_type: origin.source_type,
                channel_id: origin.channel_id,
                channel_activity_id: origin.channel_activity_id,
                project_id: origin.project_id,
                created_at: origin.created_at,
            })
            .collect(),
        runtime: SessionRuntimeDiagnostic {
            runtime_active: entry.runtime.runtime_active,
            runtime_running: entry.runtime.runtime_running,
            runtime_run_id: entry.runtime.runtime_run_id,
            subscribed: entry.runtime.subscribed,
            terminal_attached: entry.runtime.terminal_attached,
        },
        runtime_details,
    })
}

fn record_session_event(
    connection: &Connection,
    session_id: &str,
    topic: &str,
    project_id: Option<String>,
    payload: serde_json::Value,
) {
    let _ = domain_events::record_event(
        connection,
        domain_events::DomainEventInput {
            project_id,
            topic: topic.to_string(),
            entity_type: "session".into(),
            entity_id: Some(session_id.to_string()),
            payload,
        },
    );
}

pub fn hide_sessions(
    connection: &Connection,
    mut input: SessionMutationInput,
) -> Result<SessionMutationResult, String> {
    normalize_query(&mut input.query);
    if !query_has_explicit_target(&input.query) {
        return Err("hide_sessions requires at least one explicit filter".into());
    }
    if !input.dry_run && !input.confirm {
        return Err("hide_sessions requires confirm=true when dryRun=false".into());
    }

    let reason = input
        .reason
        .as_deref()
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(session_list::SESSION_HIDDEN_REASON_USER_DISMISSED)
        .to_string();
    let matched = list_sessions(connection, None, input.query.clone())?;
    let mut sessions = Vec::new();
    let mut changed = Vec::new();

    for summary in matched.iter() {
        let mut actions = vec![format!("hide_session_list_entry:{reason}")];
        let mut skipped_reasons = Vec::new();
        if !input.dry_run {
            session_list::hide_session(connection, &summary.session_id, &reason)?;
            record_session_event(
                connection,
                &summary.session_id,
                "session.hidden",
                summary.project_id.clone(),
                serde_json::json!({ "sessionId": summary.session_id, "hiddenReason": reason }),
            );
            changed.push(summary.session_id.clone());
        }
        sessions.push(SessionMutationItem {
            session_id: summary.session_id.clone(),
            title: summary.title.clone(),
            transcript_path: summary.transcript_path.clone(),
            hidden_reason: Some(reason.clone()),
            runtime_active: summary.runtime_active,
            runtime_running: summary.runtime_running,
            actions: std::mem::take(&mut actions),
            skipped_reasons: std::mem::take(&mut skipped_reasons),
            issues: summary.issues.clone(),
        });
    }

    Ok(SessionMutationResult {
        dry_run: input.dry_run,
        matched_count: matched.len(),
        executed_count: sessions.len().saturating_sub(
            sessions
                .iter()
                .filter(|session| !session.skipped_reasons.is_empty())
                .count(),
        ),
        skipped_count: sessions
            .iter()
            .filter(|session| !session.skipped_reasons.is_empty())
            .count(),
        changed_session_ids: changed,
        sessions,
        notes: if input.dry_run {
            vec!["Dry run only. Re-run with dryRun=false and confirm=true to execute.".into()]
        } else {
            Vec::new()
        },
    })
}

pub fn restore_sessions(
    connection: &Connection,
    mut input: SessionMutationInput,
) -> Result<SessionMutationResult, String> {
    normalize_query(&mut input.query);
    if !query_has_explicit_target(&input.query) {
        return Err("restore_sessions requires at least one explicit filter".into());
    }
    if !input.dry_run && !input.confirm {
        return Err("restore_sessions requires confirm=true when dryRun=false".into());
    }

    let matched = build_inventory(connection, None, &input.query)?
        .into_iter()
        .filter(|entry| entry_matches_query(entry, &input.query))
        .collect::<Vec<_>>();
    let mut sessions = Vec::new();
    let mut changed = Vec::new();

    for entry in matched.iter() {
        let summary = to_summary(entry);
        let mut actions = vec!["restore_session_list_entry".into()];
        let mut skipped_reasons = Vec::new();
        if !summary.dismissed {
            skipped_reasons.push("session_not_user_dismissed".into());
        } else if !input.dry_run {
            session_list::restore_user_dismissed_session(connection, &summary.session_id)?;
            record_session_event(
                connection,
                &summary.session_id,
                "session.restored",
                summary.project_id.clone(),
                serde_json::json!({ "sessionId": summary.session_id }),
            );
            changed.push(summary.session_id.clone());
        }
        sessions.push(SessionMutationItem {
            session_id: summary.session_id.clone(),
            title: summary.title.clone(),
            transcript_path: summary.transcript_path.clone(),
            hidden_reason: summary.hidden_reason.clone(),
            runtime_active: summary.runtime_active,
            runtime_running: summary.runtime_running,
            actions: std::mem::take(&mut actions),
            skipped_reasons: std::mem::take(&mut skipped_reasons),
            issues: summary.issues.clone(),
        });
    }

    Ok(SessionMutationResult {
        dry_run: input.dry_run,
        matched_count: matched.len(),
        executed_count: sessions
            .iter()
            .filter(|session| session.skipped_reasons.is_empty())
            .count(),
        skipped_count: sessions
            .iter()
            .filter(|session| !session.skipped_reasons.is_empty())
            .count(),
        changed_session_ids: changed,
        sessions,
        notes: if input.dry_run {
            vec!["Dry run only. Re-run with dryRun=false and confirm=true to execute.".into()]
        } else {
            Vec::new()
        },
    })
}

pub fn delete_sessions(
    connection: &Connection,
    app: Option<&AppHandle>,
    state: Option<&AppState>,
    mut input: SessionMutationInput,
    current_request_session_id: Option<&str>,
) -> Result<SessionMutationResult, String> {
    normalize_query(&mut input.query);
    if !query_has_explicit_target(&input.query) {
        return Err("delete_sessions requires at least one explicit filter".into());
    }
    if !input.dry_run && !input.confirm {
        return Err("delete_sessions requires confirm=true when dryRun=false".into());
    }

    let matched = build_inventory(connection, state, &input.query)?
        .into_iter()
        .filter(|entry| entry_matches_query(entry, &input.query))
        .collect::<Vec<_>>();
    let mut sessions = Vec::new();
    let mut changed = Vec::new();

    for entry in matched.iter() {
        let summary = to_summary(entry);
        let mut actions = vec![
            "delete_canonical_session_row".into(),
            "delete_session_catalog_row".into(),
            "delete_session_list_entry".into(),
            "delete_session_run_origins".into(),
        ];
        if summary.file_exists {
            actions.push("delete_transcript_file".into());
        }
        let mut skipped_reasons = Vec::new();

        if current_request_session_id == Some(summary.session_id.as_str()) {
            skipped_reasons.push("current_request_session".into());
        }
        if (summary.runtime_active || summary.runtime_running) && !input.stop_active_runtimes {
            skipped_reasons.push("active_runtime_requires_stop_active_runtimes".into());
        }

        if skipped_reasons.is_empty() && !input.dry_run {
            if input.stop_active_runtimes {
                if let Some(state) = state {
                    if let Some(runtime) = state.remove_session_runtime(&summary.session_id)? {
                        runtime.shutdown();
                    }
                    state.clear_session_tracking(&summary.session_id)?;
                    if summary.runtime_active || summary.runtime_running {
                        actions.push("stop_active_runtime".into());
                    }
                }
            }

            connection
                .execute(
                    "DELETE FROM session_run_origins WHERE session_id = ?1",
                    [summary.session_id.as_str()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to delete session run origins for {}: {error}",
                        summary.session_id
                    )
                })?;
            connection
                .execute(
                    "DELETE FROM sessions WHERE id = ?1",
                    [summary.session_id.as_str()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to delete canonical session row for {}: {error}",
                        summary.session_id
                    )
                })?;
            connection
                .execute(
                    "DELETE FROM session_list_entries WHERE session_id = ?1",
                    [summary.session_id.as_str()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to delete session list entry for {}: {error}",
                        summary.session_id
                    )
                })?;
            connection
                .execute(
                    "DELETE FROM session_catalog WHERE session_id = ?1",
                    [summary.session_id.as_str()],
                )
                .map_err(|error| {
                    format!(
                        "Unable to delete session catalog row for {}: {error}",
                        summary.session_id
                    )
                })?;
            if let Some(path) = entry
                .transcript
                .as_ref()
                .map(|transcript| transcript.path.clone())
                .or_else(|| {
                    entry
                        .catalog
                        .as_ref()
                        .map(|catalog| catalog.session_path.clone())
                })
            {
                if path.exists() {
                    fs::remove_file(&path).map_err(|error| {
                        format!(
                            "Unable to delete session transcript {}: {error}",
                            path.display()
                        )
                    })?;
                }
            }
            record_session_event(
                connection,
                &summary.session_id,
                "session.deleted",
                summary.project_id.clone(),
                serde_json::json!({
                    "sessionId": summary.session_id,
                    "stopActiveRuntimes": input.stop_active_runtimes,
                }),
            );
            changed.push(summary.session_id.clone());
        }

        sessions.push(SessionMutationItem {
            session_id: summary.session_id.clone(),
            title: summary.title.clone(),
            transcript_path: summary.transcript_path.clone(),
            hidden_reason: summary.hidden_reason.clone(),
            runtime_active: summary.runtime_active,
            runtime_running: summary.runtime_running,
            actions,
            skipped_reasons,
            issues: summary.issues.clone(),
        });
    }

    if !input.dry_run {
        if let Some(app) = app {
            if !changed.is_empty() {
                let _ = app_events::emit_session_change(app, "sessions.delete", changed.clone());
            }
        }
    }

    Ok(SessionMutationResult {
        dry_run: input.dry_run,
        matched_count: matched.len(),
        executed_count: sessions
            .iter()
            .filter(|session| session.skipped_reasons.is_empty())
            .count(),
        skipped_count: sessions
            .iter()
            .filter(|session| !session.skipped_reasons.is_empty())
            .count(),
        changed_session_ids: changed,
        sessions,
        notes: {
            let mut notes = Vec::new();
            if input.dry_run {
                notes.push(
                    "Dry run only. Re-run with dryRun=false and confirm=true to execute.".into(),
                );
            }
            if current_request_session_id.is_some() {
                notes.push("The current calling session is never deleted by this command.".into());
            }
            notes
        },
    })
}

pub fn reconcile_sessions(
    connection: &Connection,
    mut input: SessionReconcileInput,
) -> Result<SessionMutationResult, String> {
    normalize_query(&mut input.query);
    if !input.dry_run && !input.confirm {
        return Err("reconcile_sessions requires confirm=true when dryRun=false".into());
    }

    let matched = build_inventory(connection, None, &input.query)?
        .into_iter()
        .filter(|entry| entry_matches_query(entry, &input.query))
        .collect::<Vec<_>>();
    let mut sessions = Vec::new();
    let mut changed = Vec::new();

    for entry in matched.iter() {
        let summary = to_summary(entry);
        let mut actions = Vec::new();
        let mut skipped_reasons = Vec::new();

        if entry.catalog.is_none() && entry.transcript.is_some() && entry.context.is_some() {
            actions.push("reindex_orphan_transcript_into_catalog".into());
        }
        if entry.catalog.is_some() && entry.transcript.is_none() {
            actions.push("delete_orphan_catalog_row".into());
        }
        if entry.list_entry.is_some() && entry.transcript.is_none() {
            actions.push("delete_stale_session_list_entry".into());
        }
        if !entry.run_origins.is_empty() && entry.transcript.is_none() {
            actions.push("delete_stale_session_run_origins".into());
        }
        if actions.is_empty() {
            skipped_reasons.push("no_reconcile_actions_needed".into());
        }

        if skipped_reasons.is_empty() && !input.dry_run {
            if entry.catalog.is_none() {
                if let (Some(context), Some(transcript)) =
                    (entry.context.as_ref(), entry.transcript.as_ref())
                {
                    let stored = pi_sessions::summarize_session_for_catalog(&transcript.path)?;
                    let (file_size, file_mtime_ms) = session_file_fingerprint(&transcript.path)?;
                    pi_sessions::upsert_session_catalog_row(
                        connection,
                        &summary.session_id,
                        &context.project_slug,
                        &transcript.path,
                        &stored.record.created_at,
                        &stored.record.updated_at,
                        &stored.record.title,
                        &stored.record.status,
                        file_size,
                        file_mtime_ms,
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to reindex transcript {}: {error}",
                            summary.session_id
                        )
                    })?;
                }
            }

            if entry.catalog.is_some() && entry.transcript.is_none() {
                connection
                    .execute(
                        "DELETE FROM session_catalog WHERE session_id = ?1",
                        [summary.session_id.as_str()],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to delete orphan catalog row for {}: {error}",
                            summary.session_id
                        )
                    })?;
            }
            if entry.list_entry.is_some() && entry.transcript.is_none() {
                connection
                    .execute(
                        "DELETE FROM session_list_entries WHERE session_id = ?1",
                        [summary.session_id.as_str()],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to delete stale session list entry for {}: {error}",
                            summary.session_id
                        )
                    })?;
            }
            if !entry.run_origins.is_empty() && entry.transcript.is_none() {
                connection
                    .execute(
                        "DELETE FROM session_run_origins WHERE session_id = ?1",
                        [summary.session_id.as_str()],
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to delete stale session run origins for {}: {error}",
                            summary.session_id
                        )
                    })?;
            }
            record_session_event(
                connection,
                &summary.session_id,
                "session.reconciled",
                summary.project_id.clone(),
                serde_json::json!({ "sessionId": summary.session_id, "actions": actions }),
            );
            changed.push(summary.session_id.clone());
        }

        sessions.push(SessionMutationItem {
            session_id: summary.session_id.clone(),
            title: summary.title.clone(),
            transcript_path: summary.transcript_path.clone(),
            hidden_reason: summary.hidden_reason.clone(),
            runtime_active: summary.runtime_active,
            runtime_running: summary.runtime_running,
            actions,
            skipped_reasons,
            issues: summary.issues.clone(),
        });
    }

    Ok(SessionMutationResult {
        dry_run: input.dry_run,
        matched_count: matched.len(),
        executed_count: sessions
            .iter()
            .filter(|session| session.skipped_reasons.is_empty())
            .count(),
        skipped_count: sessions
            .iter()
            .filter(|session| !session.skipped_reasons.is_empty())
            .count(),
        changed_session_ids: changed,
        sessions,
        notes: if input.dry_run {
            vec!["Dry run only. Re-run with dryRun=false and confirm=true to execute.".into()]
        } else {
            Vec::new()
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{env, sync::Arc};

    use rusqlite::Connection;
    use uuid::Uuid;

    use crate::services::database::initialize_database_at;

    fn unique_temp_db(label: &str) -> PathBuf {
        env::temp_dir().join(format!(
            "{}-{}-orchestra.db",
            label,
            Uuid::new_v4().simple()
        ))
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    fn with_temp_home<T>(label: &str, action: impl FnOnce() -> T) -> T {
        let _guard = crate::test_support::global_test_env_lock()
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let previous_home = env::var_os("HOME");
        let root = env::temp_dir().join(format!("{}-{}", label, Uuid::new_v4().simple()));
        fs::create_dir_all(&root).expect("temp home should create");
        unsafe {
            env::set_var("HOME", &root);
        }
        let result = action();
        match previous_home {
            Some(value) => unsafe { env::set_var("HOME", value) },
            None => unsafe { env::remove_var("HOME") },
        }
        result
    }

    fn seed_project(connection: &Connection) {
        let now = crate::state::now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now],
            )
            .expect("project should seed");
    }

    fn write_session_file(
        session_dir: &Path,
        file_name: &str,
        session_id: &str,
        title: &str,
    ) -> PathBuf {
        let path = session_dir.join(file_name);
        let content = format!(
            concat!(
                "{{\"type\":\"session\",\"id\":\"{session_id}\",\"timestamp\":\"2026-01-01T00:00:00Z\"}}\n",
                "{{\"type\":\"message\",\"timestamp\":\"2026-01-01T00:00:01Z\",\"message\":{{\"role\":\"user\",\"content\":[{{\"type\":\"text\",\"text\":\"{title}\"}}]}}}}\n"
            ),
            session_id = session_id,
            title = title,
        );
        fs::write(&path, content).expect("session file should write");
        path
    }

    fn upsert_catalog_row(
        connection: &Connection,
        session_id: &str,
        session_path: &Path,
        title: &str,
        status: &str,
    ) {
        let (file_size, file_mtime_ms) = session_file_fingerprint(session_path).unwrap_or((0, 0));
        let now = crate::state::now_iso();
        connection
            .execute(
                r#"
                INSERT INTO session_catalog (
                    session_id, project_slug, session_path, created_at, updated_at,
                    title, status, file_size, file_mtime_ms, last_indexed_at
                )
                VALUES (?1, 'orchestra', ?2, ?3, ?3, ?4, ?5, ?6, ?7, ?3)
                "#,
                params![
                    session_id,
                    session_path.display().to_string(),
                    now,
                    title,
                    status,
                    file_size as i64,
                    file_mtime_ms,
                ],
            )
            .expect("catalog row should insert");
    }

    #[test]
    fn list_sessions_reports_hidden_and_catalog_file_mismatches() {
        with_temp_home("session-management-list", || {
            let connection = open_test_connection("session-management-list");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let session_path = write_session_file(
                &context.session_dir,
                "20260101_visible.jsonl",
                "11111111-1111-1111-1111-111111111111",
                "Visible session",
            );
            let hidden_path = write_session_file(
                &context.session_dir,
                "20260101_hidden_22222222-2222-2222-2222-222222222222.jsonl",
                "22222222-2222-2222-2222-222222222222",
                "Hidden session",
            );
            upsert_catalog_row(
                &connection,
                "11111111-1111-1111-1111-111111111111",
                &session_path,
                "Visible session",
                "idle",
            );
            connection
                .execute(
                    "INSERT INTO session_list_entries (session_id, dismissed_at, hidden_reason, created_at, updated_at) VALUES (?1, ?2, ?3, ?2, ?2)",
                    params![
                        "22222222-2222-2222-2222-222222222222",
                        crate::state::now_iso(),
                        session_list::SESSION_HIDDEN_REASON_USER_DISMISSED,
                    ],
                )
                .expect("hidden entry should insert");

            let hidden_sessions = list_sessions(
                &connection,
                None,
                SessionManagementQuery {
                    hidden: Some(true),
                    ..SessionManagementQuery::default()
                },
            )
            .expect("hidden sessions should list");
            assert_eq!(hidden_sessions.len(), 1);
            assert_eq!(hidden_sessions[0].title, "Hidden session");
            assert!(!hidden_sessions[0].catalog_present);
            assert!(hidden_sessions[0].file_exists);
            assert!(hidden_sessions[0]
                .issues
                .iter()
                .any(|issue| issue == "catalog_missing"));
            assert_eq!(
                hidden_sessions[0].transcript_path.as_deref(),
                Some(hidden_path.display().to_string().as_str())
            );
        });
    }

    #[test]
    fn hide_restore_and_get_session_diagnostics_round_trip_session_list_state() {
        with_temp_home("session-management-hide-restore", || {
            let connection = open_test_connection("session-management-hide-restore");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let session_id = "77777777-7777-7777-7777-777777777777";
            let path = write_session_file(
                &context.session_dir,
                &format!("20260101_{session_id}.jsonl"),
                session_id,
                "Hide and restore session",
            );
            upsert_catalog_row(
                &connection,
                session_id,
                &path,
                "Hide and restore session",
                "idle",
            );
            session_records::repair_session_row_from_transcript_path(
                &connection,
                session_id,
                Some("project-1"),
                None,
                &path,
            )
            .expect("canonical session row should repair");

            let initial = get_session_diagnostics(&connection, None, None, session_id)
                .expect("initial diagnostics should load");
            let expected_path = path.display().to_string();
            assert_eq!(initial.summary.session_id, session_id);
            assert!(!initial.summary.hidden);
            assert!(!initial.summary.dismissed);
            assert!(initial.list_entry.is_none());
            assert_eq!(
                initial
                    .catalog
                    .as_ref()
                    .map(|catalog| catalog.session_id.as_str()),
                Some(session_id)
            );
            assert_eq!(
                initial
                    .transcript
                    .as_ref()
                    .map(|transcript| transcript.path.as_str()),
                Some(expected_path.as_str())
            );
            assert_eq!(
                initial
                    .transcript
                    .as_ref()
                    .and_then(|transcript| transcript.derived_session_id.as_deref()),
                Some(session_id)
            );
            assert_eq!(
                initial
                    .transcript
                    .as_ref()
                    .and_then(|transcript| transcript.header_session_id.as_deref()),
                Some(session_id)
            );

            let hidden = hide_sessions(
                &connection,
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    reason: None,
                    dry_run: false,
                    confirm: true,
                    stop_active_runtimes: false,
                },
            )
            .expect("hide should succeed");
            assert_eq!(hidden.executed_count, 1);
            assert_eq!(hidden.changed_session_ids, vec![session_id.to_string()]);

            let hidden_diagnostics = get_session_diagnostics(&connection, None, None, session_id)
                .expect("hidden diagnostics should load");
            assert!(hidden_diagnostics.summary.hidden);
            assert!(hidden_diagnostics.summary.dismissed);
            assert_eq!(
                hidden_diagnostics.summary.hidden_reason.as_deref(),
                Some(session_list::SESSION_HIDDEN_REASON_USER_DISMISSED)
            );
            assert!(hidden_diagnostics.list_entry.is_none());

            let restored = restore_sessions(
                &connection,
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    reason: None,
                    dry_run: false,
                    confirm: true,
                    stop_active_runtimes: false,
                },
            )
            .expect("restore should succeed");
            assert_eq!(restored.executed_count, 1);
            assert_eq!(restored.changed_session_ids, vec![session_id.to_string()]);

            let restored_diagnostics = get_session_diagnostics(&connection, None, None, session_id)
                .expect("restored diagnostics should load");
            assert!(!restored_diagnostics.summary.hidden);
            assert!(!restored_diagnostics.summary.dismissed);
            assert!(restored_diagnostics.list_entry.is_none());
        });
    }

    #[test]
    fn delete_sessions_refuses_current_request_session() {
        with_temp_home("session-management-current-session", || {
            let connection = open_test_connection("session-management-current-session");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let session_id = "88888888-8888-8888-8888-888888888888";
            let path = write_session_file(
                &context.session_dir,
                &format!("20260101_{session_id}.jsonl"),
                session_id,
                "Current request session",
            );
            upsert_catalog_row(
                &connection,
                session_id,
                &path,
                "Current request session",
                "idle",
            );
            let now = crate::state::now_iso();
            connection
                .execute(
                    "INSERT INTO session_list_entries (session_id, dismissed_at, hidden_reason, created_at, updated_at) VALUES (?1, ?2, ?3, ?2, ?2)",
                    params![session_id, now.clone(), session_list::SESSION_HIDDEN_REASON_USER_DISMISSED],
                )
                .expect("list entry should insert");
            connection
                .execute(
                    "INSERT INTO session_run_origins (run_id, session_id, source_type, channel_id, channel_activity_id, project_id, created_at) VALUES ('run-current', ?1, 'channel', NULL, NULL, 'project-1', ?2)",
                    params![session_id, now],
                )
                .expect("run origin should insert");

            let result = delete_sessions(
                &connection,
                None,
                None,
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    dry_run: false,
                    confirm: true,
                    stop_active_runtimes: false,
                    reason: None,
                },
                Some(session_id),
            )
            .expect("current-session deletion should be refused");

            assert_eq!(result.executed_count, 0);
            assert_eq!(result.skipped_count, 1);
            assert!(result
                .notes
                .iter()
                .any(|note| note.contains("never deleted")));
            assert!(result.sessions[0]
                .skipped_reasons
                .iter()
                .any(|reason| reason == "current_request_session"));
            assert!(path.exists());
            let catalog_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("catalog count should load");
            assert_eq!(catalog_count, 1);
            let list_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_list_entries WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("list count should load");
            assert_eq!(list_count, 1);
            let run_origin_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_run_origins WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("run origin count should load");
            assert_eq!(run_origin_count, 1);
        });
    }

    #[test]
    fn delete_sessions_requires_stop_active_runtimes_and_clears_running_state_when_allowed() {
        with_temp_home("session-management-active-runtime", || {
            let connection = open_test_connection("session-management-active-runtime");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let session_id = "99999999-9999-9999-9999-999999999999";
            let path = write_session_file(
                &context.session_dir,
                &format!("20260101_{session_id}.jsonl"),
                session_id,
                "Active runtime session",
            );
            upsert_catalog_row(
                &connection,
                session_id,
                &path,
                "Active runtime session",
                "running",
            );

            let state = crate::state::AppState::new(Arc::new(
                crate::services::tool_bridge::ToolBridgeConfig::test_config(),
            ));
            state
                .begin_session_run(session_id, "run-active")
                .expect("active session run should register");

            let blocked = delete_sessions(
                &connection,
                None,
                Some(&state),
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    dry_run: false,
                    confirm: true,
                    stop_active_runtimes: false,
                    reason: None,
                },
                None,
            )
            .expect("active runtime should be skipped without stop flag");
            assert_eq!(blocked.executed_count, 0);
            assert_eq!(blocked.skipped_count, 1);
            assert!(blocked.sessions[0]
                .skipped_reasons
                .iter()
                .any(|reason| reason == "active_runtime_requires_stop_active_runtimes"));
            assert!(state
                .is_session_running(session_id)
                .expect("run state should load"));
            assert!(path.exists());

            let deleted = delete_sessions(
                &connection,
                None,
                Some(&state),
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    dry_run: false,
                    confirm: true,
                    stop_active_runtimes: true,
                    reason: None,
                },
                None,
            )
            .expect("active runtime deletion should succeed with stop flag");
            assert_eq!(deleted.executed_count, 1);
            assert!(deleted.sessions[0]
                .actions
                .iter()
                .any(|action| action == "stop_active_runtime"));
            assert!(!state
                .is_session_running(session_id)
                .expect("run state should clear after deletion"));
            assert!(!path.exists());
            let catalog_count_after: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("catalog count should reload");
            assert_eq!(catalog_count_after, 0);
        });
    }

    #[test]
    fn delete_sessions_dry_run_and_confirmed_cleanup_handle_catalog_list_and_run_origins() {
        with_temp_home("session-management-delete", || {
            let connection = open_test_connection("session-management-delete");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let session_id = "33333333-3333-3333-3333-333333333333";
            let path = write_session_file(
                &context.session_dir,
                &format!("20260101_{session_id}.jsonl"),
                session_id,
                "Cleanup session",
            );
            upsert_catalog_row(&connection, session_id, &path, "Cleanup session", "idle");
            let now = crate::state::now_iso();
            connection
                .execute(
                    "INSERT INTO session_list_entries (session_id, dismissed_at, hidden_reason, created_at, updated_at) VALUES (?1, ?2, ?3, ?2, ?2)",
                    params![session_id, now.clone(), session_list::SESSION_HIDDEN_REASON_USER_DISMISSED],
                )
                .expect("list entry should insert");
            connection
                .execute(
                    "INSERT INTO session_run_origins (run_id, session_id, source_type, channel_id, channel_activity_id, project_id, created_at) VALUES ('run-1', ?1, 'channel', NULL, NULL, 'project-1', ?2)",
                    params![session_id, now],
                )
                .expect("run origin should insert");

            let dry_run = delete_sessions(
                &connection,
                None,
                None,
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    dry_run: true,
                    confirm: false,
                    stop_active_runtimes: false,
                    reason: None,
                },
                None,
            )
            .expect("delete dry run should succeed");
            assert_eq!(dry_run.executed_count, 1);
            assert!(path.exists());
            let catalog_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("catalog count should load");
            assert_eq!(catalog_count, 1);

            let deleted = delete_sessions(
                &connection,
                None,
                None,
                SessionMutationInput {
                    query: SessionManagementQuery {
                        session_ids: vec![session_id.into()],
                        ..SessionManagementQuery::default()
                    },
                    dry_run: false,
                    confirm: true,
                    stop_active_runtimes: false,
                    reason: None,
                },
                None,
            )
            .expect("delete execute should succeed");
            assert_eq!(deleted.executed_count, 1);
            assert!(!path.exists());
            let catalog_count_after: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("catalog count should reload");
            assert_eq!(catalog_count_after, 0);
            let list_count_after: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_list_entries WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("list count should reload");
            assert_eq!(list_count_after, 0);
            let run_origin_count_after: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_run_origins WHERE session_id = ?1",
                    [session_id],
                    |row| row.get(0),
                )
                .expect("run origin count should reload");
            assert_eq!(run_origin_count_after, 0);
        });
    }

    #[test]
    fn reconcile_sessions_reindexes_orphan_files_and_cleans_stale_rows() {
        with_temp_home("session-management-reconcile", || {
            let connection = open_test_connection("session-management-reconcile");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let orphan_session_id = "44444444-4444-4444-4444-444444444444";
            let orphan_path = write_session_file(
                &context.session_dir,
                &format!("20260101_{orphan_session_id}.jsonl"),
                orphan_session_id,
                "Orphan transcript",
            );
            let stale_session_id = "55555555-5555-5555-5555-555555555555";
            let missing_path = context
                .session_dir
                .join(format!("20260101_{stale_session_id}.jsonl"));
            connection
                .execute(
                    r#"
                    INSERT INTO session_catalog (
                        session_id, project_slug, session_path, created_at, updated_at,
                        title, status, file_size, file_mtime_ms, last_indexed_at
                    )
                    VALUES (?1, 'orchestra', ?2, ?3, ?3, 'Missing transcript', 'idle', 0, 0, ?3)
                    "#,
                    params![
                        stale_session_id,
                        missing_path.display().to_string(),
                        crate::state::now_iso()
                    ],
                )
                .expect("stale catalog row should insert");
            let now = crate::state::now_iso();
            connection
                .execute(
                    "INSERT INTO session_list_entries (session_id, dismissed_at, hidden_reason, created_at, updated_at) VALUES (?1, ?2, ?3, ?2, ?2)",
                    params![stale_session_id, now.clone(), session_list::SESSION_HIDDEN_REASON_USER_DISMISSED],
                )
                .expect("stale list entry should insert");
            connection
                .execute(
                    "INSERT INTO session_run_origins (run_id, session_id, source_type, channel_id, channel_activity_id, project_id, created_at) VALUES ('run-stale', ?1, 'channel', NULL, NULL, 'project-1', ?2)",
                    params![stale_session_id, now],
                )
                .expect("stale run origin should insert");

            let dry_run = reconcile_sessions(
                &connection,
                SessionReconcileInput {
                    dry_run: true,
                    confirm: false,
                    query: SessionManagementQuery::default(),
                },
            )
            .expect("reconcile dry run should succeed");
            assert!(dry_run
                .sessions
                .iter()
                .any(|session| session.session_id == orphan_session_id));
            assert!(dry_run
                .sessions
                .iter()
                .any(|session| session.session_id == stale_session_id));

            let reconciled = reconcile_sessions(
                &connection,
                SessionReconcileInput {
                    dry_run: false,
                    confirm: true,
                    query: SessionManagementQuery::default(),
                },
            )
            .expect("reconcile execute should succeed");
            assert!(reconciled.executed_count >= 2);
            let orphan_catalog_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [orphan_session_id],
                    |row| row.get(0),
                )
                .expect("orphan catalog should exist after reconcile");
            assert_eq!(orphan_catalog_count, 1);
            let stale_catalog_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [stale_session_id],
                    |row| row.get(0),
                )
                .expect("stale catalog should reload");
            assert_eq!(stale_catalog_count, 0);
            let stale_list_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_list_entries WHERE session_id = ?1",
                    [stale_session_id],
                    |row| row.get(0),
                )
                .expect("stale list entry should reload");
            assert_eq!(stale_list_count, 0);
            let stale_run_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_run_origins WHERE session_id = ?1",
                    [stale_session_id],
                    |row| row.get(0),
                )
                .expect("stale run origin should reload");
            assert_eq!(stale_run_count, 0);
            assert!(orphan_path.exists());
        });
    }

    #[test]
    fn reconcile_sessions_reindexes_orphan_transcript_when_stale_row_owns_path() {
        with_temp_home("session-management-reconcile-path-conflict", || {
            let connection = open_test_connection("session-management-reconcile-path-conflict");
            seed_project(&connection);
            let context = pi_sessions::detect_session_context(Some("orchestra"))
                .expect("context should resolve");
            let actual_session_id = "66666666-6666-6666-6666-666666666666";
            let stale_session_id = "77777777-7777-7777-7777-777777777777";
            let orphan_path = write_session_file(
                &context.session_dir,
                &format!("20260101_{actual_session_id}.jsonl"),
                actual_session_id,
                "Conflicting orphan transcript",
            );
            let now = crate::state::now_iso();
            connection
                .execute(
                    r#"
                    INSERT INTO session_catalog (
                        session_id, project_slug, session_path, created_at, updated_at,
                        title, status, file_size, file_mtime_ms, last_indexed_at
                    )
                    VALUES (?1, 'orchestra', ?2, ?3, ?3, 'Stale owner', 'idle', 0, 0, ?3)
                    "#,
                    params![stale_session_id, orphan_path.display().to_string(), now],
                )
                .expect("stale path owner should insert");

            let reconciled = reconcile_sessions(
                &connection,
                SessionReconcileInput {
                    dry_run: false,
                    confirm: true,
                    query: SessionManagementQuery::default(),
                },
            )
            .expect("reconcile should repair path ownership");
            assert!(reconciled
                .changed_session_ids
                .iter()
                .any(|session_id| session_id == actual_session_id));

            let actual_catalog_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [actual_session_id],
                    |row| row.get(0),
                )
                .expect("actual catalog row should reload");
            assert_eq!(actual_catalog_count, 1);
            let stale_catalog_count: i64 = connection
                .query_row(
                    "SELECT COUNT(*) FROM session_catalog WHERE session_id = ?1",
                    [stale_session_id],
                    |row| row.get(0),
                )
                .expect("stale catalog row should reload");
            assert_eq!(stale_catalog_count, 0);
        });
    }
}
