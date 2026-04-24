use std::{
    collections::{BTreeSet, HashSet},
    fs,
    path::{Path, PathBuf},
};

use chrono::Utc;
use rusqlite::{Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use uuid::Uuid;

use crate::services::{
    database,
    orchestra_paths::{
        default_orchestra_root, orchestra_pi_agent_skills_dir, orchestra_pi_skill_snapshots_dir,
        sanitize_slug,
    },
    pi_sessions, projects, task_runtime,
};

const SCOPE_GLOBAL: &str = "global";
const SCOPE_PROJECT: &str = "project";
const SCOPE_ROLE: &str = "role";
const SCOPE_AGENT: &str = "agent";
const SCOPE_WORKFLOW: &str = "workflow";
const SCOPE_WORKFLOW_LANE: &str = "workflow_lane";

const SOURCE_LOCAL: &str = "local";
const SOURCE_EXTERNAL: &str = "external";

const STATUS_SHADOWED: &str = "shadowed";
const STATUS_MISSING: &str = "missing";
const STATUS_INVALID: &str = "invalid";
const STATUS_UNLOADABLE: &str = "unloadable";

const SKILL_FILE_NAME: &str = "SKILL.md";
const MANIFEST_FILE_NAME: &str = "manifest.json";

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ManagedSkillRuntimeContext {
    pub session_id: Option<String>,
    pub project_id: String,
    pub role_id: Option<String>,
    pub agent_id: Option<String>,
    pub workflow_id: Option<String>,
    pub workflow_lane_id: Option<String>,
    pub context_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct MaterializedSkillSnapshot {
    pub snapshot_id: String,
    pub snapshot_dir: PathBuf,
    pub manifest_path: PathBuf,
    pub skill_paths: Vec<PathBuf>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ManagedPiSkillLaunchPlan {
    pub context: ManagedSkillRuntimeContext,
    pub context_hash: String,
    pub global_publication_manifest_path: PathBuf,
    pub snapshot: Option<MaterializedSkillSnapshot>,
    pub skill_paths: Vec<PathBuf>,
    pub global_skill_slugs: Vec<String>,
    pub scoped_skill_slugs: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct ResolvedRuntimeSkillCandidate {
    binding_id: String,
    skill_id: String,
    slug: String,
    name: String,
    scope_kind: String,
    source_kind: String,
    source_path: String,
    content_path: String,
    relative_source_path: Option<String>,
    archived: bool,
    status: String,
    binding_created_at: String,
    binding_updated_at: String,
    skill_created_at: String,
    skill_updated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct EffectiveRuntimeSkills {
    global_winners: Vec<ResolvedRuntimeSkillCandidate>,
    scoped_winners: Vec<ResolvedRuntimeSkillCandidate>,
    suppressed_same_record: Vec<ResolvedRuntimeSkillCandidate>,
    suppressed_same_slug: Vec<ResolvedRuntimeSkillCandidate>,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum RuntimeReuseDecision {
    Reuse,
    ReuseUntilIdle {
        cwd_changed: bool,
        skills_changed: bool,
    },
    Respawn {
        cwd_changed: bool,
        skills_changed: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct PublicationManifest {
    publication_hash: String,
    generated_at: String,
    skills: Vec<ManifestSkillEntry>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotManifest {
    snapshot_id: String,
    snapshot_hash: String,
    generated_at: String,
    context: ManagedSkillRuntimeContext,
    skills: Vec<ManifestSkillEntry>,
    skill_args: Vec<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ManifestSkillEntry {
    binding_id: String,
    skill_id: String,
    slug: String,
    name: String,
    scope_kind: String,
    source_kind: String,
    source_path: String,
    content_path: String,
    relative_source_path: Option<String>,
    materialized_dir: String,
    binding_created_at: String,
    binding_updated_at: String,
    skill_created_at: String,
    skill_updated_at: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct LaunchPlanHashInput {
    context: ManagedSkillRuntimeContext,
    global_skills: Vec<HashSkillEntry>,
    scoped_skills: Vec<HashSkillEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct SnapshotHashInput {
    context: ManagedSkillRuntimeContext,
    scoped_skills: Vec<HashSkillEntry>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PublicationHashInput {
    global_skills: Vec<HashSkillEntry>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
struct HashSkillEntry {
    binding_id: String,
    skill_id: String,
    slug: String,
    name: String,
    scope_kind: String,
    source_kind: String,
    source_path: String,
    content_path: String,
    relative_source_path: Option<String>,
    binding_created_at: String,
    binding_updated_at: String,
    skill_created_at: String,
    skill_updated_at: String,
}

pub fn resolve_managed_pi_skill_launch_plan(
    session_id: &str,
) -> Result<ManagedPiSkillLaunchPlan, String> {
    let connection = database::open_connection()?;
    let orchestra_root = default_orchestra_root()?;
    resolve_managed_pi_skill_launch_plan_for_connection(&connection, &orchestra_root, session_id)
}

pub fn append_managed_pi_extension_and_skill_args(
    args: &mut Vec<String>,
    orchestra_extension_path: &Path,
    extra_extensions: &[String],
    launch_plan: &ManagedPiSkillLaunchPlan,
) {
    args.push("--no-extensions".to_string());
    args.push("--extension".to_string());
    args.push(orchestra_extension_path.display().to_string());
    for extension in extra_extensions {
        args.push("--extension".to_string());
        args.push(extension.clone());
    }
    for skill_path in &launch_plan.skill_paths {
        args.push("--skill".to_string());
        args.push(skill_path.display().to_string());
    }
}

pub fn decide_runtime_reuse(
    current_project_root: &Path,
    requested_project_root: &Path,
    current_skill_context_hash: &str,
    desired_skill_context_hash: &str,
    has_active_prompt: bool,
) -> RuntimeReuseDecision {
    let cwd_changed = current_project_root != requested_project_root;
    let skills_changed = current_skill_context_hash != desired_skill_context_hash;

    if !cwd_changed && !skills_changed {
        RuntimeReuseDecision::Reuse
    } else if has_active_prompt {
        RuntimeReuseDecision::ReuseUntilIdle {
            cwd_changed,
            skills_changed,
        }
    } else {
        RuntimeReuseDecision::Respawn {
            cwd_changed,
            skills_changed,
        }
    }
}

pub(crate) fn resolve_managed_pi_skill_launch_plan_for_connection(
    connection: &Connection,
    orchestra_root: &Path,
    session_id: &str,
) -> Result<ManagedPiSkillLaunchPlan, String> {
    let session_project_id = load_session_project_id(connection, session_id)?;
    let context = resolve_managed_runtime_context_for_connection(
        connection,
        session_id,
        session_project_id.as_deref(),
    )?;
    build_managed_pi_skill_launch_plan(connection, orchestra_root, context)
}

fn build_managed_pi_skill_launch_plan(
    connection: &Connection,
    orchestra_root: &Path,
    context: ManagedSkillRuntimeContext,
) -> Result<ManagedPiSkillLaunchPlan, String> {
    let candidates = load_runtime_skill_candidates(connection, &context)?;
    let effective = resolve_effective_runtime_skills(candidates)?;
    let default_ambient_external_slugs = load_default_ambient_external_slugs(connection)?;

    if let Some(conflicts) = find_slug_collisions(
        effective
            .global_winners
            .iter()
            .map(|candidate| candidate.slug.as_str()),
        &default_ambient_external_slugs,
    ) {
        return Err(format!(
            "Global managed skills conflict with default ambient ~/.agents/skills slugs: {}",
            conflicts.join(", ")
        ));
    }

    let global_publication_manifest_path =
        publish_global_winners(orchestra_root, &effective.global_winners)?;

    let mut ambient_slugs = default_ambient_external_slugs;
    for candidate in &effective.global_winners {
        ambient_slugs.insert(candidate.slug.clone());
    }

    if let Some(conflicts) = find_slug_collisions(
        effective
            .scoped_winners
            .iter()
            .map(|candidate| candidate.slug.as_str()),
        &ambient_slugs,
    ) {
        return Err(format!(
            "Scoped managed skills conflict with ambient skill slugs and cannot be loaded explicitly: {}",
            conflicts.join(", ")
        ));
    }

    let snapshot =
        materialize_scoped_snapshot(orchestra_root, &context, &effective.scoped_winners)?;
    let skill_paths = snapshot
        .as_ref()
        .map(|snapshot| snapshot.skill_paths.clone())
        .unwrap_or_default();

    let context_hash = hash_json(&LaunchPlanHashInput {
        context: context.clone(),
        global_skills: effective
            .global_winners
            .iter()
            .map(HashSkillEntry::from)
            .collect(),
        scoped_skills: effective
            .scoped_winners
            .iter()
            .map(HashSkillEntry::from)
            .collect(),
    })?;

    Ok(ManagedPiSkillLaunchPlan {
        context,
        context_hash,
        global_publication_manifest_path,
        snapshot,
        skill_paths,
        global_skill_slugs: effective
            .global_winners
            .iter()
            .map(|candidate| candidate.slug.clone())
            .collect(),
        scoped_skill_slugs: effective
            .scoped_winners
            .iter()
            .map(|candidate| candidate.slug.clone())
            .collect(),
    })
}

fn load_session_project_id(
    connection: &Connection,
    session_id: &str,
) -> Result<Option<String>, String> {
    let context = match pi_sessions::find_session_context_for_session(session_id) {
        Ok(context) => context,
        Err(_) => return Ok(None),
    };
    Ok(
        projects::get_project_by_slug(connection, &context.project_slug)
            .map_err(|error| {
                format!(
                    "Unable to resolve project {} for session {session_id}: {error}",
                    context.project_slug
                )
            })?
            .map(|project| project.id),
    )
}

fn resolve_managed_runtime_context_for_connection(
    connection: &Connection,
    session_id: &str,
    session_project_id: Option<&str>,
) -> Result<ManagedSkillRuntimeContext, String> {
    if let Some(assignment) =
        task_runtime::get_active_assignment_for_session(connection, session_id)?
    {
        let project_id = connection
            .query_row(
                "SELECT project_id FROM tasks WHERE id = ?1 LIMIT 1",
                [assignment.task_id.as_str()],
                |row| row.get::<_, String>(0),
            )
            .map_err(|error| {
                format!(
                    "Unable to resolve project for active assignment {}: {error}",
                    assignment.id
                )
            })?;
        let (agent_id, role_id) = scope_from_assignment(connection, &assignment)?;
        return Ok(ManagedSkillRuntimeContext {
            session_id: Some(session_id.to_string()),
            project_id,
            role_id,
            agent_id,
            workflow_id: Some(assignment.workflow_id),
            workflow_lane_id: Some(assignment.lane_id),
            context_source: "task_assignment".into(),
        });
    }

    if let Some((project_id, agent_id, role_id)) = connection
        .query_row(
            r#"
            SELECT ars.project_id, ars.agent_id, a.role_id
            FROM agent_runtime_states ars
            LEFT JOIN agents a ON a.id = ars.agent_id
            WHERE ars.main_session_id = ?1
            LIMIT 1
            "#,
            [session_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| {
            format!("Unable to resolve agent runtime scope for session {session_id}: {error}")
        })?
    {
        return Ok(ManagedSkillRuntimeContext {
            session_id: Some(session_id.to_string()),
            project_id,
            role_id,
            agent_id: Some(agent_id),
            workflow_id: None,
            workflow_lane_id: None,
            context_source: "agent_main_session".into(),
        });
    }

    if let Some(role_id) = connection
        .query_row(
            "SELECT role_id FROM role_instances WHERE session_id = ?1 LIMIT 1",
            [session_id],
            |row| row.get::<_, Option<String>>(0),
        )
        .optional()
        .map_err(|error| {
            format!("Unable to resolve role instance scope for session {session_id}: {error}")
        })?
        .flatten()
    {
        let project_id = session_project_id.ok_or_else(|| {
            format!(
                "Session {session_id} is bound to a role instance but has no project session context"
            )
        })?;
        return Ok(ManagedSkillRuntimeContext {
            session_id: Some(session_id.to_string()),
            project_id: project_id.to_string(),
            role_id: Some(role_id),
            agent_id: None,
            workflow_id: None,
            workflow_lane_id: None,
            context_source: "role_instance_session".into(),
        });
    }

    let project_id = session_project_id.ok_or_else(|| {
        format!("Unable to resolve managed runtime project context for session {session_id}")
    })?;
    Ok(ManagedSkillRuntimeContext {
        session_id: Some(session_id.to_string()),
        project_id: project_id.to_string(),
        role_id: None,
        agent_id: None,
        workflow_id: None,
        workflow_lane_id: None,
        context_source: "project_session".into(),
    })
}

fn scope_from_assignment(
    connection: &Connection,
    assignment: &crate::models::TaskLaneAssignment,
) -> Result<(Option<String>, Option<String>), String> {
    match assignment.worker_type.as_str() {
        "agent" => {
            let Some(agent_id) = assignment.worker_id.clone() else {
                return Ok((None, None));
            };
            let role_id = connection
                .query_row(
                    "SELECT role_id FROM agents WHERE id = ?1 LIMIT 1",
                    [agent_id.as_str()],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to resolve inherited role for agent {}: {error}",
                        agent_id
                    )
                })?
                .flatten();
            Ok((Some(agent_id), role_id))
        }
        "role" => {
            if let Some(role_id) = assignment.worker_id.clone() {
                return Ok((None, Some(role_id)));
            }
            let Some(role_instance_id) = assignment.role_instance_id.as_deref() else {
                return Ok((None, None));
            };
            let role_id = connection
                .query_row(
                    "SELECT role_id FROM role_instances WHERE id = ?1 LIMIT 1",
                    [role_instance_id],
                    |row| row.get::<_, Option<String>>(0),
                )
                .optional()
                .map_err(|error| {
                    format!(
                        "Unable to resolve role for role instance {}: {error}",
                        role_instance_id
                    )
                })?
                .flatten();
            Ok((None, role_id))
        }
        _ => Ok((None, None)),
    }
}

fn load_runtime_skill_candidates(
    connection: &Connection,
    context: &ManagedSkillRuntimeContext,
) -> Result<Vec<ResolvedRuntimeSkillCandidate>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                b.id,
                b.scope_kind,
                b.created_at,
                b.updated_at,
                s.id,
                s.slug,
                s.name,
                s.source_kind,
                s.source_path,
                s.content_path,
                s.relative_source_path,
                s.archived,
                s.status,
                s.created_at,
                s.updated_at
            FROM skill_scope_bindings b
            JOIN skills s ON s.id = b.skill_id
            WHERE b.scope_kind = 'global'
               OR (b.scope_kind = 'project' AND b.project_id = ?1)
               OR (?2 IS NOT NULL AND b.scope_kind = 'role' AND b.role_id = ?2)
               OR (?3 IS NOT NULL AND b.scope_kind = 'agent' AND b.agent_id = ?3)
               OR (?4 IS NOT NULL AND b.scope_kind = 'workflow' AND b.workflow_id = ?4)
               OR (?4 IS NOT NULL AND ?5 IS NOT NULL AND b.scope_kind = 'workflow_lane' AND b.workflow_id = ?4 AND b.workflow_lane_id = ?5)
            "#,
        )
        .map_err(|error| {
            format!(
                "Unable to prepare runtime skill resolution query for project {}: {error}",
                context.project_id
            )
        })?;

    let rows = statement
        .query_map(
            rusqlite::params![
                context.project_id,
                context.role_id,
                context.agent_id,
                context.workflow_id,
                context.workflow_lane_id,
            ],
            |row| {
                Ok(ResolvedRuntimeSkillCandidate {
                    binding_id: row.get(0)?,
                    scope_kind: row.get(1)?,
                    binding_created_at: row.get(2)?,
                    binding_updated_at: row.get(3)?,
                    skill_id: row.get(4)?,
                    slug: row.get::<_, Option<String>>(5)?.unwrap_or_default(),
                    name: row.get(6)?,
                    source_kind: row.get(7)?,
                    source_path: row.get(8)?,
                    content_path: row.get(9)?,
                    relative_source_path: row.get(10)?,
                    archived: row.get::<_, i64>(11)? != 0,
                    status: row.get(12)?,
                    skill_created_at: row.get(13)?,
                    skill_updated_at: row.get(14)?,
                })
            },
        )
        .map_err(|error| {
            format!(
                "Unable to query runtime skill candidates for project {}: {error}",
                context.project_id
            )
        })?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read runtime skill candidates: {error}"))
}

fn resolve_effective_runtime_skills(
    candidates: Vec<ResolvedRuntimeSkillCandidate>,
) -> Result<EffectiveRuntimeSkills, String> {
    let mut loadable = candidates
        .into_iter()
        .filter(is_runtime_loadable)
        .collect::<Vec<_>>();

    if let Some(invalid_slug) = loadable
        .iter()
        .find(|candidate| candidate.slug.trim().is_empty())
    {
        return Err(format!(
            "Skill {} is bound into runtime resolution but has no usable slug",
            invalid_slug.skill_id
        ));
    }

    loadable.sort_by(compare_runtime_skill_candidates);

    let mut suppressed_same_record = Vec::new();
    let mut seen_skill_ids = HashSet::new();
    let mut same_record_deduped = Vec::new();
    for candidate in loadable {
        if seen_skill_ids.insert(candidate.skill_id.clone()) {
            same_record_deduped.push(candidate);
        } else {
            suppressed_same_record.push(candidate);
        }
    }

    let mut suppressed_same_slug = Vec::new();
    let mut seen_slugs = HashSet::new();
    let mut winners = Vec::new();
    for candidate in same_record_deduped {
        if seen_slugs.insert(candidate.slug.clone()) {
            winners.push(candidate);
        } else {
            suppressed_same_slug.push(candidate);
        }
    }

    let mut global_winners = Vec::new();
    let mut scoped_winners = Vec::new();
    for winner in winners {
        if winner.scope_kind == SCOPE_GLOBAL {
            global_winners.push(winner);
        } else {
            scoped_winners.push(winner);
        }
    }

    Ok(EffectiveRuntimeSkills {
        global_winners,
        scoped_winners,
        suppressed_same_record,
        suppressed_same_slug,
    })
}

fn is_runtime_loadable(candidate: &ResolvedRuntimeSkillCandidate) -> bool {
    if candidate.archived {
        return false;
    }
    !matches!(
        candidate.status.as_str(),
        STATUS_MISSING | STATUS_INVALID | STATUS_UNLOADABLE
    )
}

fn compare_runtime_skill_candidates(
    left: &ResolvedRuntimeSkillCandidate,
    right: &ResolvedRuntimeSkillCandidate,
) -> std::cmp::Ordering {
    scope_rank(&left.scope_kind)
        .cmp(&scope_rank(&right.scope_kind))
        .then_with(|| source_rank(&left.source_kind).cmp(&source_rank(&right.source_kind)))
        .then_with(|| left.binding_created_at.cmp(&right.binding_created_at))
        .then_with(|| left.binding_updated_at.cmp(&right.binding_updated_at))
        .then_with(|| left.binding_id.cmp(&right.binding_id))
        .then_with(|| left.skill_id.cmp(&right.skill_id))
        .then_with(|| left.relative_source_path.cmp(&right.relative_source_path))
        .then_with(|| left.source_path.cmp(&right.source_path))
        .then_with(|| left.content_path.cmp(&right.content_path))
}

fn scope_rank(scope_kind: &str) -> u8 {
    match scope_kind {
        SCOPE_WORKFLOW_LANE => 0,
        SCOPE_WORKFLOW => 1,
        SCOPE_AGENT => 2,
        SCOPE_ROLE => 3,
        SCOPE_PROJECT => 4,
        SCOPE_GLOBAL => 5,
        _ => 6,
    }
}

fn source_rank(source_kind: &str) -> u8 {
    match source_kind {
        SOURCE_LOCAL => 0,
        SOURCE_EXTERNAL => 1,
        _ => 2,
    }
}

fn load_default_ambient_external_slugs(connection: &Connection) -> Result<HashSet<String>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT DISTINCT slug
            FROM skills
            WHERE source_kind = 'external'
              AND slug IS NOT NULL
              AND status NOT IN ('missing', 'invalid', 'unloadable')
            "#,
        )
        .map_err(|error| format!("Unable to prepare ambient external skill query: {error}"))?;

    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query ambient external skills: {error}"))?;

    let slugs = rows
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read ambient external skills: {error}"))?;
    Ok(slugs.into_iter().collect())
}

fn find_slug_collisions<'a>(
    candidates: impl Iterator<Item = &'a str>,
    ambient_slugs: &HashSet<String>,
) -> Option<Vec<String>> {
    let mut collisions = BTreeSet::new();
    for slug in candidates {
        if ambient_slugs.contains(slug) {
            collisions.insert(slug.to_string());
        }
    }
    if collisions.is_empty() {
        None
    } else {
        Some(collisions.into_iter().collect())
    }
}

fn publish_global_winners(
    orchestra_root: &Path,
    winners: &[ResolvedRuntimeSkillCandidate],
) -> Result<PathBuf, String> {
    let target_dir = orchestra_pi_agent_skills_dir(orchestra_root);
    let parent = target_dir.parent().ok_or_else(|| {
        format!(
            "Global skill publication path {} has no parent directory",
            target_dir.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Unable to create Orchestra Pi agent directory {}: {error}",
            parent.display()
        )
    })?;

    let publication_hash = hash_json(&PublicationHashInput {
        global_skills: winners.iter().map(HashSkillEntry::from).collect(),
    })?;
    let manifest_path = target_dir.join(MANIFEST_FILE_NAME);
    if publication_manifest_matches(&manifest_path, &publication_hash) {
        return Ok(manifest_path);
    }

    let staging_dir = parent.join(format!(".skills-staging-{}", Uuid::new_v4().simple()));
    if staging_dir.exists() {
        let _ = fs::remove_dir_all(&staging_dir);
    }
    fs::create_dir_all(&staging_dir).map_err(|error| {
        format!(
            "Unable to create staging directory {}: {error}",
            staging_dir.display()
        )
    })?;

    let mut manifest_entries = Vec::new();
    for winner in winners {
        let target_skill_dir = staging_dir.join(&winner.slug);
        materialize_skill_directory(winner, &target_skill_dir)?;
        manifest_entries.push(ManifestSkillEntry::from_candidate(
            winner,
            &target_skill_dir,
        ));
    }

    write_json_file(
        &staging_dir.join(MANIFEST_FILE_NAME),
        &PublicationManifest {
            publication_hash,
            generated_at: now_iso(),
            skills: manifest_entries,
        },
    )?;

    replace_directory_atomically(&staging_dir, &target_dir)?;
    Ok(manifest_path)
}

fn publication_manifest_matches(manifest_path: &Path, expected_hash: &str) -> bool {
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<PublicationManifest>(&content).ok())
        .map(|manifest| manifest.publication_hash == expected_hash)
        .unwrap_or(false)
}

fn materialize_scoped_snapshot(
    orchestra_root: &Path,
    context: &ManagedSkillRuntimeContext,
    winners: &[ResolvedRuntimeSkillCandidate],
) -> Result<Option<MaterializedSkillSnapshot>, String> {
    if winners.is_empty() {
        return Ok(None);
    }

    let snapshot_root = orchestra_pi_skill_snapshots_dir(orchestra_root);
    fs::create_dir_all(&snapshot_root).map_err(|error| {
        format!(
            "Unable to create scoped snapshot root {}: {error}",
            snapshot_root.display()
        )
    })?;

    let snapshot_hash = hash_json(&SnapshotHashInput {
        context: context.clone(),
        scoped_skills: winners.iter().map(HashSkillEntry::from).collect(),
    })?;
    let snapshot_dir = snapshot_root.join(&snapshot_hash);
    let skills_dir = snapshot_dir.join("skills");
    let manifest_path = snapshot_dir.join(MANIFEST_FILE_NAME);
    let skill_paths = winners
        .iter()
        .enumerate()
        .map(|(index, winner)| skills_dir.join(materialized_snapshot_entry_name(index, winner)))
        .collect::<Vec<_>>();

    if snapshot_manifest_matches(&manifest_path, &snapshot_hash) {
        return Ok(Some(MaterializedSkillSnapshot {
            snapshot_id: snapshot_hash,
            snapshot_dir,
            manifest_path,
            skill_paths,
        }));
    }

    if snapshot_dir.exists() {
        fs::remove_dir_all(&snapshot_dir).map_err(|error| {
            format!(
                "Unable to clear stale scoped snapshot {}: {error}",
                snapshot_dir.display()
            )
        })?;
    }
    fs::create_dir_all(&skills_dir).map_err(|error| {
        format!(
            "Unable to create scoped snapshot directory {}: {error}",
            skills_dir.display()
        )
    })?;

    let mut manifest_entries = Vec::new();
    for (winner, skill_path) in winners.iter().zip(skill_paths.iter()) {
        materialize_skill_directory(winner, skill_path)?;
        manifest_entries.push(ManifestSkillEntry::from_candidate(winner, skill_path));
    }

    write_json_file(
        &manifest_path,
        &SnapshotManifest {
            snapshot_id: snapshot_hash.clone(),
            snapshot_hash: snapshot_hash.clone(),
            generated_at: now_iso(),
            context: context.clone(),
            skill_args: skill_paths
                .iter()
                .map(|path| path.display().to_string())
                .collect(),
            skills: manifest_entries,
        },
    )?;

    Ok(Some(MaterializedSkillSnapshot {
        snapshot_id: snapshot_hash,
        snapshot_dir,
        manifest_path,
        skill_paths,
    }))
}

fn snapshot_manifest_matches(manifest_path: &Path, expected_hash: &str) -> bool {
    fs::read_to_string(manifest_path)
        .ok()
        .and_then(|content| serde_json::from_str::<SnapshotManifest>(&content).ok())
        .map(|manifest| manifest.snapshot_hash == expected_hash)
        .unwrap_or(false)
}

fn materialized_snapshot_entry_name(
    index: usize,
    candidate: &ResolvedRuntimeSkillCandidate,
) -> String {
    format!(
        "{index:03}-{}-{}",
        sanitize_slug(&candidate.scope_kind),
        sanitize_slug(&candidate.slug)
    )
}

fn materialize_skill_directory(
    candidate: &ResolvedRuntimeSkillCandidate,
    target_dir: &Path,
) -> Result<(), String> {
    if target_dir.exists() {
        fs::remove_dir_all(target_dir).map_err(|error| {
            format!(
                "Unable to clear existing skill directory {}: {error}",
                target_dir.display()
            )
        })?;
    }
    fs::create_dir_all(target_dir).map_err(|error| {
        format!(
            "Unable to create skill directory {}: {error}",
            target_dir.display()
        )
    })?;

    match candidate.source_kind.as_str() {
        SOURCE_LOCAL => {
            let markdown = fs::read_to_string(&candidate.content_path).map_err(|error| {
                format!(
                    "Unable to read local skill markdown {}: {error}",
                    candidate.content_path
                )
            })?;
            fs::write(target_dir.join(SKILL_FILE_NAME), markdown).map_err(|error| {
                format!(
                    "Unable to write materialized local skill {}: {error}",
                    target_dir.join(SKILL_FILE_NAME).display()
                )
            })
        }
        SOURCE_EXTERNAL => copy_directory(Path::new(&candidate.source_path), target_dir),
        other => Err(format!(
            "Skill {} has unsupported source kind {}",
            candidate.skill_id, other
        )),
    }
}

fn copy_directory(source_dir: &Path, target_dir: &Path) -> Result<(), String> {
    if !source_dir.is_dir() {
        return Err(format!(
            "Expected external skill directory at {}, but it was not a directory",
            source_dir.display()
        ));
    }

    for entry in fs::read_dir(source_dir).map_err(|error| {
        format!(
            "Unable to read external skill directory {}: {error}",
            source_dir.display()
        )
    })? {
        let entry = entry.map_err(|error| {
            format!(
                "Unable to inspect external skill entry under {}: {error}",
                source_dir.display()
            )
        })?;
        let source_path = entry.path();
        let target_path = target_dir.join(entry.file_name());
        let file_type = entry.file_type().map_err(|error| {
            format!(
                "Unable to inspect external skill path {}: {error}",
                source_path.display()
            )
        })?;
        if file_type.is_dir() {
            fs::create_dir_all(&target_path).map_err(|error| {
                format!(
                    "Unable to create external skill directory {}: {error}",
                    target_path.display()
                )
            })?;
            copy_directory(&source_path, &target_path)?;
        } else if file_type.is_file() {
            fs::copy(&source_path, &target_path).map_err(|error| {
                format!(
                    "Unable to copy external skill file {} to {}: {error}",
                    source_path.display(),
                    target_path.display()
                )
            })?;
        }
    }

    Ok(())
}

fn replace_directory_atomically(staging_dir: &Path, target_dir: &Path) -> Result<(), String> {
    let parent = target_dir.parent().ok_or_else(|| {
        format!(
            "Target directory {} has no parent directory",
            target_dir.display()
        )
    })?;
    let backup_dir = parent.join(format!(".skills-backup-{}", Uuid::new_v4().simple()));

    if backup_dir.exists() {
        let _ = fs::remove_dir_all(&backup_dir);
    }

    if target_dir.exists() {
        fs::rename(target_dir, &backup_dir).map_err(|error| {
            format!(
                "Unable to move existing skill directory {} aside: {error}",
                target_dir.display()
            )
        })?;
    }

    if let Err(error) = fs::rename(staging_dir, target_dir) {
        let _ = fs::rename(&backup_dir, target_dir);
        return Err(format!(
            "Unable to publish skill directory {}: {error}",
            target_dir.display()
        ));
    }

    let _ = fs::remove_dir_all(&backup_dir);
    Ok(())
}

fn write_json_file<T: Serialize>(path: &Path, value: &T) -> Result<(), String> {
    let parent = path.parent().ok_or_else(|| {
        format!(
            "JSON output path {} has no parent directory",
            path.display()
        )
    })?;
    fs::create_dir_all(parent).map_err(|error| {
        format!(
            "Unable to create JSON output directory {}: {error}",
            parent.display()
        )
    })?;
    let content = serde_json::to_string_pretty(value)
        .map_err(|error| format!("Unable to serialize JSON for {}: {error}", path.display()))?;
    fs::write(path, content).map_err(|error| format!("Unable to write {}: {error}", path.display()))
}

fn hash_json<T: Serialize>(value: &T) -> Result<String, String> {
    let json = serde_json::to_vec(value)
        .map_err(|error| format!("Unable to serialize runtime skill hash input: {error}"))?;
    let mut hasher = Sha256::new();
    hasher.update(&json);
    Ok(format!("{:x}", hasher.finalize()))
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

impl From<&ResolvedRuntimeSkillCandidate> for HashSkillEntry {
    fn from(value: &ResolvedRuntimeSkillCandidate) -> Self {
        Self {
            binding_id: value.binding_id.clone(),
            skill_id: value.skill_id.clone(),
            slug: value.slug.clone(),
            name: value.name.clone(),
            scope_kind: value.scope_kind.clone(),
            source_kind: value.source_kind.clone(),
            source_path: value.source_path.clone(),
            content_path: value.content_path.clone(),
            relative_source_path: value.relative_source_path.clone(),
            binding_created_at: value.binding_created_at.clone(),
            binding_updated_at: value.binding_updated_at.clone(),
            skill_created_at: value.skill_created_at.clone(),
            skill_updated_at: value.skill_updated_at.clone(),
        }
    }
}

impl ManifestSkillEntry {
    fn from_candidate(candidate: &ResolvedRuntimeSkillCandidate, materialized_dir: &Path) -> Self {
        Self {
            binding_id: candidate.binding_id.clone(),
            skill_id: candidate.skill_id.clone(),
            slug: candidate.slug.clone(),
            name: candidate.name.clone(),
            scope_kind: candidate.scope_kind.clone(),
            source_kind: candidate.source_kind.clone(),
            source_path: candidate.source_path.clone(),
            content_path: candidate.content_path.clone(),
            relative_source_path: candidate.relative_source_path.clone(),
            materialized_dir: materialized_dir.display().to_string(),
            binding_created_at: candidate.binding_created_at.clone(),
            binding_updated_at: candidate.binding_updated_at.clone(),
            skill_created_at: candidate.skill_created_at.clone(),
            skill_updated_at: candidate.skill_updated_at.clone(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{fs, path::PathBuf};

    use chrono::Utc;
    use rusqlite::{params, Connection};

    use crate::{
        models::{LocalSkillUpsertInput, SkillBindingInput},
        services::{database::initialize_database_at, skill_bindings, skills},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "orchestra-runtime-skills-{label}-{}-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            Uuid::new_v4().simple()
        ));
        path
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        path.push(format!(
            "orchestra-runtime-skills-{label}-{}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            Uuid::new_v4().simple()
        ));
        path
    }

    fn test_connection() -> Connection {
        let path = unique_temp_db("db");
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(&path).expect("database should open")
    }

    fn test_now_iso() -> String {
        Utc::now().to_rfc3339()
    }

    fn seed_project(connection: &Connection, project_id: &str, slug: &str) {
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'PRJ', ?4, ?4)",
                params![project_id, slug, slug, now],
            )
            .expect("project should seed");
    }

    fn seed_role(connection: &Connection, role_id: &str) {
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, compaction_window, direct_permissions, archived, created_at, updated_at) VALUES (?1, ?1, ?1, NULL, NULL, NULL, NULL, 'off', 1, NULL, '[]', 0, ?2, ?2)",
                params![role_id, now],
            )
            .expect("role should seed");
    }

    fn seed_agent(connection: &Connection, agent_id: &str, role_id: Option<&str>) {
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, scope, project_id, thinking_level, compaction_window, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?1, ?1, NULL, NULL, NULL, NULL, ?2, 'global', NULL, 'off', NULL, '[]', 0, 0, 0, ?3, ?3)",
                params![agent_id, role_id, now],
            )
            .expect("agent should seed");
    }

    fn seed_workflow(connection: &Connection, workflow_id: &str) {
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES (?1, ?1, ?1, NULL, 0, ?2, ?2)",
                params![workflow_id, now],
            )
            .expect("workflow should seed");
    }

    fn seed_workflow_lane(connection: &Connection, workflow_id: &str, lane_id: &str) {
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, description, lane_order, assigned_entity_type, assigned_entity_id, entry_prompt_template, use_separate_worktree, require_user_approval_on_success, success_transition_type, success_target_lane_id, failure_transition_type, failure_target_lane_id, user_intervention_target_lane_id, created_at, updated_at) VALUES (?1, ?2, ?1, ?1, NULL, 0, 'user', NULL, NULL, 0, 0, 'end', NULL, 'end', NULL, NULL, ?3, ?3)",
                params![lane_id, workflow_id, now],
            )
            .expect("lane should seed");
    }

    fn create_local_skill(connection: &mut Connection, root: &Path, slug: &str) -> String {
        skills::create_local_skill(
            connection,
            root,
            LocalSkillUpsertInput {
                name: slug.replace('-', " "),
                slug: Some(slug.to_string()),
                markdown_body: format!("# {slug}\n\nLocal skill body for {slug}."),
            },
        )
        .expect("local skill should create")
        .summary
        .id
    }

    fn insert_external_skill(
        connection: &Connection,
        source_root: &Path,
        skill_id: &str,
        slug: &str,
        status: &str,
    ) {
        let now = test_now_iso();
        let skill_dir = source_root.join(slug);
        fs::create_dir_all(&skill_dir).expect("external skill dir should create");
        fs::write(
            skill_dir.join(SKILL_FILE_NAME),
            format!("# {slug}\n\nExternal skill."),
        )
        .expect("external skill file should write");
        fs::write(skill_dir.join("extra.txt"), "nested asset")
            .expect("external skill asset should write");
        connection
            .execute(
                r#"
                INSERT INTO skills (
                    id, slug, name, description, source_kind, source_path, content_path,
                    relative_source_path, archived, status, status_reason, shadowed_by_skill_id,
                    last_seen_at, created_at, updated_at
                ) VALUES (?1, ?2, ?2, NULL, 'external', ?3, ?4, ?2, 0, ?5, NULL, NULL, ?6, ?6, ?6)
                "#,
                params![
                    skill_id,
                    slug,
                    skill_dir.display().to_string(),
                    skill_dir.join(SKILL_FILE_NAME).display().to_string(),
                    status,
                    now,
                ],
            )
            .expect("external skill should seed");
    }

    fn bind_skill(connection: &mut Connection, skill_id: &str, scope_kind: &str, scope_id: &str) {
        let input = match scope_kind {
            SCOPE_GLOBAL => SkillBindingInput {
                scope_kind: scope_kind.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
            },
            SCOPE_PROJECT => SkillBindingInput {
                scope_kind: scope_kind.into(),
                project_id: Some(scope_id.into()),
                role_id: None,
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
            },
            SCOPE_ROLE => SkillBindingInput {
                scope_kind: scope_kind.into(),
                project_id: None,
                role_id: Some(scope_id.into()),
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
            },
            SCOPE_AGENT => SkillBindingInput {
                scope_kind: scope_kind.into(),
                project_id: None,
                role_id: None,
                agent_id: Some(scope_id.into()),
                workflow_id: None,
                workflow_lane_id: None,
            },
            SCOPE_WORKFLOW => SkillBindingInput {
                scope_kind: scope_kind.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: Some(scope_id.into()),
                workflow_lane_id: None,
            },
            SCOPE_WORKFLOW_LANE => SkillBindingInput {
                scope_kind: scope_kind.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: Some("workflow-1".into()),
                workflow_lane_id: Some(scope_id.into()),
            },
            _ => unreachable!("unexpected scope"),
        };
        skill_bindings::set_skill_bindings(connection, skill_id, vec![input])
            .expect("bindings should save");
    }

    fn candidate(
        skill_id: &str,
        slug: &str,
        scope: &str,
        source: &str,
    ) -> ResolvedRuntimeSkillCandidate {
        ResolvedRuntimeSkillCandidate {
            binding_id: format!("binding-{skill_id}-{scope}"),
            skill_id: skill_id.into(),
            slug: slug.into(),
            name: skill_id.into(),
            scope_kind: scope.into(),
            source_kind: source.into(),
            source_path: format!("/tmp/{slug}"),
            content_path: format!("/tmp/{slug}/{SKILL_FILE_NAME}"),
            relative_source_path: Some(slug.into()),
            archived: false,
            status: STATUS_SHADOWED.into(),
            binding_created_at: format!("2026-01-01T00:00:0{}Z", scope_rank(scope)),
            binding_updated_at: format!("2026-01-01T00:00:1{}Z", scope_rank(scope)),
            skill_created_at: "2026-01-01T00:00:00Z".into(),
            skill_updated_at: "2026-01-01T00:00:00Z".into(),
        }
    }

    #[test]
    fn precedence_and_dedupe_follow_orc_146_rules() {
        let resolved = resolve_effective_runtime_skills(vec![
            candidate("skill-global", "alpha", SCOPE_GLOBAL, SOURCE_LOCAL),
            candidate("skill-project", "alpha", SCOPE_PROJECT, SOURCE_EXTERNAL),
            candidate("skill-role-external", "beta", SCOPE_ROLE, SOURCE_EXTERNAL),
            candidate("skill-role-local", "beta", SCOPE_ROLE, SOURCE_LOCAL),
            candidate("skill-shared", "gamma", SCOPE_GLOBAL, SOURCE_LOCAL),
            candidate("skill-shared", "gamma", SCOPE_AGENT, SOURCE_LOCAL),
            candidate("skill-lane", "delta", SCOPE_WORKFLOW_LANE, SOURCE_EXTERNAL),
        ])
        .expect("runtime skills should resolve");

        assert_eq!(
            resolved
                .global_winners
                .iter()
                .map(|candidate| candidate.slug.as_str())
                .collect::<Vec<_>>(),
            Vec::<&str>::new()
        );
        assert_eq!(
            resolved
                .scoped_winners
                .iter()
                .map(|candidate| candidate.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["delta", "gamma", "beta", "alpha"]
        );
        assert_eq!(resolved.suppressed_same_record.len(), 1);
        assert_eq!(resolved.suppressed_same_record[0].scope_kind, SCOPE_GLOBAL);
        assert_eq!(resolved.suppressed_same_slug.len(), 2);
        assert_eq!(
            resolved
                .suppressed_same_slug
                .iter()
                .map(|candidate| candidate.slug.as_str())
                .collect::<Vec<_>>(),
            vec!["beta", "alpha"]
        );
    }

    #[test]
    fn runtime_resolution_ignores_shadowed_status_but_rejects_unloadable_states() {
        let resolved = resolve_effective_runtime_skills(vec![
            candidate("skill-shadowed", "shadowed", SCOPE_GLOBAL, SOURCE_EXTERNAL),
            ResolvedRuntimeSkillCandidate {
                status: STATUS_INVALID.into(),
                ..candidate("skill-invalid", "invalid", SCOPE_WORKFLOW, SOURCE_LOCAL)
            },
            ResolvedRuntimeSkillCandidate {
                archived: true,
                ..candidate("skill-archived", "archived", SCOPE_WORKFLOW, SOURCE_LOCAL)
            },
        ])
        .expect("runtime skills should resolve");

        assert_eq!(resolved.global_winners.len(), 1);
        assert_eq!(resolved.global_winners[0].slug, "shadowed");
        assert!(resolved.scoped_winners.is_empty());
    }

    #[test]
    fn resolves_context_for_active_assignment_with_agent_role_inheritance() {
        let connection = test_connection();
        seed_project(&connection, "project-1", "project-one");
        seed_role(&connection, "role-1");
        seed_agent(&connection, "agent-1", Some("role-1"));
        seed_workflow(&connection, "workflow-1");
        seed_workflow_lane(&connection, "workflow-1", "lane-1");
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO tasks (id, project_id, sequence_number, number, title, description, task_type, status, priority, workflow_id, current_lane_id, assignee_type, assignee_id, repository_id, parent_task_id, whip_max_attempts, archived, created_at, updated_at) VALUES ('task-1', 'project-1', 1, 'PRJ-1', 'Task', NULL, 'task', 'in_progress', 'P1', 'workflow-1', 'lane-1', 'agent', 'agent-1', NULL, NULL, 10, 0, ?1, ?1)",
                [now.as_str()],
            )
            .expect("task should seed");
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES ('assignment-1', 'task-1', 'workflow-1', 'lane-1', 'agent', 'agent-1', 'active', 'session-1', '/tmp/runtime', NULL, NULL, NULL, 0, NULL, ?1, NULL, ?1, ?1)",
                [now.as_str()],
            )
            .expect("assignment should seed");

        let context = resolve_managed_runtime_context_for_connection(
            &connection,
            "session-1",
            Some("project-1"),
        )
        .expect("context should resolve");

        assert_eq!(context.project_id, "project-1");
        assert_eq!(context.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(context.role_id.as_deref(), Some("role-1"));
        assert_eq!(context.workflow_id.as_deref(), Some("workflow-1"));
        assert_eq!(context.workflow_lane_id.as_deref(), Some("lane-1"));
        assert_eq!(context.context_source, "task_assignment");
    }

    #[test]
    fn resolves_context_for_idle_agent_main_session() {
        let connection = test_connection();
        seed_project(&connection, "project-1", "project-one");
        seed_role(&connection, "role-1");
        seed_agent(&connection, "agent-1", Some("role-1"));
        let now = test_now_iso();
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-1', 'agent-1', 'idle', 'session-agent', '/tmp/runtime', NULL, NULL, NULL, ?1, ?1)",
                [now.as_str()],
            )
            .expect("agent runtime should seed");

        let context = resolve_managed_runtime_context_for_connection(
            &connection,
            "session-agent",
            Some("project-1"),
        )
        .expect("context should resolve");

        assert_eq!(context.project_id, "project-1");
        assert_eq!(context.agent_id.as_deref(), Some("agent-1"));
        assert_eq!(context.role_id.as_deref(), Some("role-1"));
        assert_eq!(context.context_source, "agent_main_session");
    }

    #[test]
    fn materializes_global_publication_and_scoped_snapshot_with_manifests() {
        let orchestra_root = unique_temp_dir("orchestra-root");
        let local_root = unique_temp_dir("local-root");
        fs::create_dir_all(&orchestra_root).expect("orchestra root should create");
        fs::create_dir_all(&local_root).expect("local root should create");
        let mut connection = test_connection();
        seed_project(&connection, "project-1", "project-one");
        seed_role(&connection, "role-1");
        seed_agent(&connection, "agent-1", Some("role-1"));
        seed_workflow(&connection, "workflow-1");
        seed_workflow_lane(&connection, "workflow-1", "lane-1");

        let global_skill_id = create_local_skill(&mut connection, &local_root, "managed-global");
        bind_skill(&mut connection, &global_skill_id, SCOPE_GLOBAL, "");

        let scoped_skill_id = create_local_skill(&mut connection, &local_root, "scoped-local");
        bind_skill(
            &mut connection,
            &scoped_skill_id,
            SCOPE_WORKFLOW,
            "workflow-1",
        );

        let context = ManagedSkillRuntimeContext {
            session_id: Some("session-1".into()),
            project_id: "project-1".into(),
            role_id: Some("role-1".into()),
            agent_id: Some("agent-1".into()),
            workflow_id: Some("workflow-1".into()),
            workflow_lane_id: Some("lane-1".into()),
            context_source: "task_assignment".into(),
        };

        let plan = build_managed_pi_skill_launch_plan(&connection, &orchestra_root, context)
            .expect("launch plan should build");

        assert_eq!(plan.global_skill_slugs, vec!["managed-global"]);
        assert_eq!(plan.scoped_skill_slugs, vec!["scoped-local"]);
        assert_eq!(plan.skill_paths.len(), 1);
        assert!(plan.global_publication_manifest_path.exists());
        assert!(plan
            .snapshot
            .as_ref()
            .expect("snapshot should exist")
            .manifest_path
            .exists());
        assert!(orchestra_pi_agent_skills_dir(&orchestra_root)
            .join("managed-global")
            .join(SKILL_FILE_NAME)
            .exists());
        assert!(plan.skill_paths[0].join(SKILL_FILE_NAME).exists());
    }

    #[test]
    fn scoped_snapshot_materialization_copies_external_skill_directories() {
        let orchestra_root = unique_temp_dir("orchestra-root-external-snapshot");
        let external_root = unique_temp_dir("external-root-external-snapshot");
        fs::create_dir_all(&orchestra_root).expect("orchestra root should create");
        fs::create_dir_all(&external_root).expect("external root should create");

        let context = ManagedSkillRuntimeContext {
            session_id: Some("session-1".into()),
            project_id: "project-1".into(),
            role_id: None,
            agent_id: None,
            workflow_id: Some("workflow-1".into()),
            workflow_lane_id: None,
            context_source: "task_assignment".into(),
        };
        let external_candidate = ResolvedRuntimeSkillCandidate {
            binding_id: "binding-external-workflow".into(),
            skill_id: "skill-external".into(),
            slug: "scoped-external".into(),
            name: "scoped-external".into(),
            scope_kind: SCOPE_WORKFLOW.into(),
            source_kind: SOURCE_EXTERNAL.into(),
            source_path: external_root.join("scoped-external").display().to_string(),
            content_path: external_root
                .join("scoped-external")
                .join(SKILL_FILE_NAME)
                .display()
                .to_string(),
            relative_source_path: Some("scoped-external".into()),
            archived: false,
            status: STATUS_SHADOWED.into(),
            binding_created_at: "2026-01-01T00:00:00Z".into(),
            binding_updated_at: "2026-01-01T00:00:00Z".into(),
            skill_created_at: "2026-01-01T00:00:00Z".into(),
            skill_updated_at: "2026-01-01T00:00:00Z".into(),
        };
        fs::create_dir_all(external_root.join("scoped-external"))
            .expect("external dir should create");
        fs::write(
            external_root.join("scoped-external").join(SKILL_FILE_NAME),
            "# scoped-external\n\nExternal scoped skill.",
        )
        .expect("skill file should write");
        fs::write(
            external_root.join("scoped-external").join("extra.txt"),
            "nested asset",
        )
        .expect("nested asset should write");

        let snapshot =
            materialize_scoped_snapshot(&orchestra_root, &context, &[external_candidate])
                .expect("snapshot should materialize")
                .expect("snapshot should exist");
        assert!(snapshot.skill_paths[0].join(SKILL_FILE_NAME).exists());
        assert!(snapshot.skill_paths[0].join("extra.txt").exists());
    }

    #[test]
    fn scoped_snapshot_ids_are_deterministic_and_reused() {
        let orchestra_root = unique_temp_dir("orchestra-root-reuse");
        let local_root = unique_temp_dir("local-root-reuse");
        fs::create_dir_all(&orchestra_root).expect("orchestra root should create");
        fs::create_dir_all(&local_root).expect("local root should create");
        let mut connection = test_connection();
        seed_project(&connection, "project-1", "project-one");

        let skill_id = create_local_skill(&mut connection, &local_root, "scoped-local");
        bind_skill(&mut connection, &skill_id, SCOPE_PROJECT, "project-1");

        let context = ManagedSkillRuntimeContext {
            session_id: Some("session-1".into()),
            project_id: "project-1".into(),
            role_id: None,
            agent_id: None,
            workflow_id: None,
            workflow_lane_id: None,
            context_source: "project_session".into(),
        };

        let first =
            build_managed_pi_skill_launch_plan(&connection, &orchestra_root, context.clone())
                .expect("first plan should build");
        let second = build_managed_pi_skill_launch_plan(&connection, &orchestra_root, context)
            .expect("second plan should build");

        let first_snapshot = first.snapshot.expect("first snapshot should exist");
        let second_snapshot = second.snapshot.expect("second snapshot should exist");
        assert_eq!(first_snapshot.snapshot_id, second_snapshot.snapshot_id);
        assert_eq!(first_snapshot.skill_paths, second_snapshot.skill_paths);
    }

    #[test]
    fn rejects_scoped_vs_ambient_slug_collisions() {
        let orchestra_root = unique_temp_dir("orchestra-root-collision");
        let local_root = unique_temp_dir("local-root-collision");
        let external_root = unique_temp_dir("external-root-collision");
        fs::create_dir_all(&orchestra_root).expect("orchestra root should create");
        fs::create_dir_all(&local_root).expect("local root should create");
        fs::create_dir_all(&external_root).expect("external root should create");
        let mut connection = test_connection();
        seed_project(&connection, "project-1", "project-one");

        insert_external_skill(
            &connection,
            &external_root,
            "skill-ambient",
            "collision-skill",
            STATUS_SHADOWED,
        );
        let local_skill = create_local_skill(&mut connection, &local_root, "collision-skill");
        bind_skill(&mut connection, &local_skill, SCOPE_PROJECT, "project-1");

        let context = ManagedSkillRuntimeContext {
            session_id: Some("session-1".into()),
            project_id: "project-1".into(),
            role_id: None,
            agent_id: None,
            workflow_id: None,
            workflow_lane_id: None,
            context_source: "project_session".into(),
        };

        let error = build_managed_pi_skill_launch_plan(&connection, &orchestra_root, context)
            .expect_err("launch plan should reject ambient collisions");
        assert!(error.contains("collision-skill"));
    }

    #[test]
    fn appends_only_scoped_skill_args_without_disabling_ambient_skills() {
        let launch_plan = ManagedPiSkillLaunchPlan {
            context: ManagedSkillRuntimeContext {
                session_id: Some("session-1".into()),
                project_id: "project-1".into(),
                role_id: None,
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
                context_source: "project_session".into(),
            },
            context_hash: "hash-1".into(),
            global_publication_manifest_path: PathBuf::from("/tmp/manifest.json"),
            snapshot: Some(MaterializedSkillSnapshot {
                snapshot_id: "snapshot-1".into(),
                snapshot_dir: PathBuf::from("/tmp/snapshot"),
                manifest_path: PathBuf::from("/tmp/snapshot/manifest.json"),
                skill_paths: vec![PathBuf::from("/tmp/snapshot/skills/000-project-alpha")],
            }),
            skill_paths: vec![PathBuf::from("/tmp/snapshot/skills/000-project-alpha")],
            global_skill_slugs: vec!["global-alpha".into()],
            scoped_skill_slugs: vec!["project-alpha".into()],
        };

        let mut args = vec![
            "--session".to_string(),
            "/tmp/session.jsonl".to_string(),
            "--session-dir".to_string(),
            "/tmp/sessions".to_string(),
        ];
        append_managed_pi_extension_and_skill_args(
            &mut args,
            Path::new("/tmp/extensions/orchestra-tools.ts"),
            &["npm:pi-extra".to_string()],
            &launch_plan,
        );

        assert!(args.contains(&"--skill".to_string()));
        assert!(!args.contains(&"--no-skills".to_string()));
        assert_eq!(
            args,
            vec![
                "--session".to_string(),
                "/tmp/session.jsonl".to_string(),
                "--session-dir".to_string(),
                "/tmp/sessions".to_string(),
                "--no-extensions".to_string(),
                "--extension".to_string(),
                "/tmp/extensions/orchestra-tools.ts".to_string(),
                "--extension".to_string(),
                "npm:pi-extra".to_string(),
                "--skill".to_string(),
                "/tmp/snapshot/skills/000-project-alpha".to_string(),
            ]
        );
    }

    #[test]
    fn runtime_reuse_decision_respawns_when_skills_change_and_defers_when_busy() {
        assert_eq!(
            decide_runtime_reuse(
                Path::new("/tmp/a"),
                Path::new("/tmp/a"),
                "hash-1",
                "hash-2",
                false,
            ),
            RuntimeReuseDecision::Respawn {
                cwd_changed: false,
                skills_changed: true,
            }
        );
        assert_eq!(
            decide_runtime_reuse(
                Path::new("/tmp/a"),
                Path::new("/tmp/b"),
                "hash-1",
                "hash-2",
                true,
            ),
            RuntimeReuseDecision::ReuseUntilIdle {
                cwd_changed: true,
                skills_changed: true,
            }
        );
        assert_eq!(
            decide_runtime_reuse(
                Path::new("/tmp/a"),
                Path::new("/tmp/a"),
                "hash-1",
                "hash-1",
                false,
            ),
            RuntimeReuseDecision::Reuse
        );
    }
}
