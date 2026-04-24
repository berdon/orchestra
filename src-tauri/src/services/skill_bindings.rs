use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension, Params};
use uuid::Uuid;

use crate::models::{
    AgentSkillLinks, RoleSkillLinks, SkillBindingInput, SkillBindingRecord,
    SkillBindingScopeCount, SkillBindingSummary, SkillLinkSummary, WorkflowLaneSkillLinks,
    WorkflowSkillLinks,
};

const SCOPE_GLOBAL: &str = "global";
const SCOPE_PROJECT: &str = "project";
const SCOPE_ROLE: &str = "role";
const SCOPE_AGENT: &str = "agent";
const SCOPE_WORKFLOW: &str = "workflow";
const SCOPE_WORKFLOW_LANE: &str = "workflow_lane";

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
struct NormalizedSkillBindingInput {
    scope_kind: String,
    project_id: Option<String>,
    role_id: Option<String>,
    agent_id: Option<String>,
    workflow_id: Option<String>,
    workflow_lane_id: Option<String>,
}

pub fn load_skill_binding_summary(
    connection: &Connection,
    skill_id: &str,
) -> Result<SkillBindingSummary, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT scope_kind, COUNT(1) AS binding_count
            FROM skill_scope_bindings
            WHERE skill_id = ?1
            GROUP BY scope_kind
            ORDER BY CASE scope_kind
                WHEN 'global' THEN 0
                WHEN 'project' THEN 1
                WHEN 'role' THEN 2
                WHEN 'agent' THEN 3
                WHEN 'workflow' THEN 4
                WHEN 'workflow_lane' THEN 5
                ELSE 6
            END ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare binding summary query for skill {skill_id}: {error}"))?;

    let scope_counts = statement
        .query_map([skill_id], |row| {
            Ok(SkillBindingScopeCount {
                scope_kind: row.get(0)?,
                count: row.get(1)?,
            })
        })
        .map_err(|error| format!("Unable to query bindings for skill {skill_id}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read bindings for skill {skill_id}: {error}"))?;

    let total_count = scope_counts.iter().map(|entry| entry.count).sum();
    Ok(SkillBindingSummary {
        total_count,
        scope_counts,
    })
}

pub fn load_skill_bindings(
    connection: &Connection,
    skill_id: &str,
) -> Result<Vec<SkillBindingRecord>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                b.id,
                b.skill_id,
                b.scope_kind,
                b.project_id,
                b.role_id,
                b.agent_id,
                b.workflow_id,
                b.workflow_lane_id,
                p.name,
                p.slug,
                r.name,
                r.slug,
                a.name,
                a.slug,
                w.name,
                w.slug,
                wl.name,
                wl.lane_key,
                b.created_at,
                b.updated_at
            FROM skill_scope_bindings b
            LEFT JOIN projects p ON p.id = b.project_id
            LEFT JOIN roles r ON r.id = b.role_id
            LEFT JOIN agents a ON a.id = b.agent_id
            LEFT JOIN workflows w ON w.id = b.workflow_id
            LEFT JOIN workflow_lanes wl
              ON wl.workflow_id = b.workflow_id
             AND wl.id = b.workflow_lane_id
            WHERE b.skill_id = ?1
            ORDER BY
                CASE b.scope_kind
                    WHEN 'global' THEN 0
                    WHEN 'project' THEN 1
                    WHEN 'role' THEN 2
                    WHEN 'agent' THEN 3
                    WHEN 'workflow' THEN 4
                    WHEN 'workflow_lane' THEN 5
                    ELSE 6
                END ASC,
                COALESCE(p.name, r.name, a.name, w.name, wl.name, '') COLLATE NOCASE ASC,
                b.created_at ASC,
                b.id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare binding detail query for skill {skill_id}: {error}"))?;

    let rows = statement
        .query_map([skill_id], |row| {
            Ok(SkillBindingRecord {
                id: row.get(0)?,
                skill_id: row.get(1)?,
                scope_kind: row.get(2)?,
                project_id: row.get(3)?,
                role_id: row.get(4)?,
                agent_id: row.get(5)?,
                workflow_id: row.get(6)?,
                workflow_lane_id: row.get(7)?,
                project_name: row.get(8)?,
                project_slug: row.get(9)?,
                role_name: row.get(10)?,
                role_slug: row.get(11)?,
                agent_name: row.get(12)?,
                agent_slug: row.get(13)?,
                workflow_name: row.get(14)?,
                workflow_slug: row.get(15)?,
                workflow_lane_name: row.get(16)?,
                workflow_lane_key: row.get(17)?,
                created_at: row.get(18)?,
                updated_at: row.get(19)?,
            })
        })
        .map_err(|error| format!("Unable to query binding details for skill {skill_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read binding details for skill {skill_id}: {error}"))
}

pub fn set_skill_bindings(
    connection: &mut Connection,
    skill_id: &str,
    bindings: Vec<SkillBindingInput>,
) -> Result<(), String> {
    ensure_skill_exists(connection, skill_id)?;
    let normalized = normalize_requested_bindings(bindings)?;
    validate_requested_bindings(connection, &normalized)?;

    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start skill binding transaction for {skill_id}: {error}"))?;

    tx.execute(
        "DELETE FROM skill_scope_bindings WHERE skill_id = ?1",
        [skill_id],
    )
    .map_err(|error| format!("Unable to clear existing bindings for skill {skill_id}: {error}"))?;

    for binding in normalized {
        tx.execute(
            r#"
            INSERT INTO skill_scope_bindings (
                id,
                skill_id,
                scope_kind,
                project_id,
                role_id,
                agent_id,
                workflow_id,
                workflow_lane_id,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            "#,
            params![
                format!("binding-{}", Uuid::new_v4().simple()),
                skill_id,
                binding.scope_kind,
                binding.project_id,
                binding.role_id,
                binding.agent_id,
                binding.workflow_id,
                binding.workflow_lane_id,
                now,
            ],
        )
        .map_err(|error| format!("Unable to insert binding for skill {skill_id}: {error}"))?;
    }

    tx.commit()
        .map_err(|error| format!("Unable to commit bindings for skill {skill_id}: {error}"))
}

pub fn get_role_skill_links(connection: &Connection, role_id: &str) -> Result<RoleSkillLinks, String> {
    ensure_target_exists(connection, "roles", role_id, "Role")?;
    Ok(RoleSkillLinks {
        role_id: role_id.to_string(),
        skills: query_skill_links(
            connection,
            r#"
            SELECT
                b.id,
                b.scope_kind,
                s.id,
                s.slug,
                s.name,
                s.description,
                s.source_kind,
                s.archived,
                s.status
            FROM skill_scope_bindings b
            JOIN skills s ON s.id = b.skill_id
            WHERE b.scope_kind = 'role'
              AND b.role_id = ?1
            ORDER BY
                s.archived ASC,
                CASE s.status
                    WHEN 'active' THEN 0
                    WHEN 'shadowed' THEN 1
                    WHEN 'invalid' THEN 2
                    WHEN 'unloadable' THEN 3
                    WHEN 'missing' THEN 4
                    ELSE 5
                END ASC,
                s.name COLLATE NOCASE ASC,
                b.created_at ASC
            "#,
            [role_id],
        )?,
    })
}

pub fn get_agent_skill_links(
    connection: &Connection,
    agent_id: &str,
) -> Result<AgentSkillLinks, String> {
    let (resolved_agent_id, inherited_role_id, inherited_role_name) = connection
        .query_row(
            r#"
            SELECT a.id, a.role_id, r.name
            FROM agents a
            LEFT JOIN roles r ON r.id = a.role_id
            WHERE a.id = ?1
            "#,
            [agent_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, Option<String>>(2)?,
                ))
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query agent {agent_id} for skill links: {error}"))?
        .ok_or_else(|| format!("Agent {agent_id} was not found."))?;

    let direct_skills = query_skill_links(
        connection,
        r#"
        SELECT
            b.id,
            b.scope_kind,
            s.id,
            s.slug,
            s.name,
            s.description,
            s.source_kind,
            s.archived,
            s.status
        FROM skill_scope_bindings b
        JOIN skills s ON s.id = b.skill_id
        WHERE b.scope_kind = 'agent'
          AND b.agent_id = ?1
        ORDER BY
            s.archived ASC,
            CASE s.status
                WHEN 'active' THEN 0
                WHEN 'shadowed' THEN 1
                WHEN 'invalid' THEN 2
                WHEN 'unloadable' THEN 3
                WHEN 'missing' THEN 4
                ELSE 5
            END ASC,
            s.name COLLATE NOCASE ASC,
            b.created_at ASC
        "#,
        [agent_id],
    )?;

    let inherited_role_skills = if let Some(role_id) = inherited_role_id.as_deref() {
        query_skill_links(
            connection,
            r#"
            SELECT
                b.id,
                b.scope_kind,
                s.id,
                s.slug,
                s.name,
                s.description,
                s.source_kind,
                s.archived,
                s.status
            FROM skill_scope_bindings b
            JOIN skills s ON s.id = b.skill_id
            WHERE b.scope_kind = 'role'
              AND b.role_id = ?1
            ORDER BY
                s.archived ASC,
                CASE s.status
                    WHEN 'active' THEN 0
                    WHEN 'shadowed' THEN 1
                    WHEN 'invalid' THEN 2
                    WHEN 'unloadable' THEN 3
                    WHEN 'missing' THEN 4
                    ELSE 5
                END ASC,
                s.name COLLATE NOCASE ASC,
                b.created_at ASC
            "#,
            [role_id],
        )?
    } else {
        Vec::new()
    };

    Ok(AgentSkillLinks {
        agent_id: resolved_agent_id,
        direct_skills,
        inherited_role_id,
        inherited_role_name,
        inherited_role_skills,
    })
}

pub fn get_workflow_skill_links(
    connection: &Connection,
    workflow_id: &str,
) -> Result<WorkflowSkillLinks, String> {
    ensure_target_exists(connection, "workflows", workflow_id, "Workflow")?;

    let workflow_skills = query_skill_links(
        connection,
        r#"
        SELECT
            b.id,
            b.scope_kind,
            s.id,
            s.slug,
            s.name,
            s.description,
            s.source_kind,
            s.archived,
            s.status
        FROM skill_scope_bindings b
        JOIN skills s ON s.id = b.skill_id
        WHERE b.scope_kind = 'workflow'
          AND b.workflow_id = ?1
        ORDER BY
            s.archived ASC,
            CASE s.status
                WHEN 'active' THEN 0
                WHEN 'shadowed' THEN 1
                WHEN 'invalid' THEN 2
                WHEN 'unloadable' THEN 3
                WHEN 'missing' THEN 4
                ELSE 5
            END ASC,
            s.name COLLATE NOCASE ASC,
            b.created_at ASC
        "#,
        [workflow_id],
    )?;

    let mut lane_statement = connection
        .prepare(
            r#"
            SELECT id, name, lane_key
            FROM workflow_lanes
            WHERE workflow_id = ?1
            ORDER BY lane_order ASC, name COLLATE NOCASE ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare workflow lane list for {workflow_id}: {error}"))?;

    let lane_rows = lane_statement
        .query_map([workflow_id], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
            ))
        })
        .map_err(|error| format!("Unable to query workflow lanes for {workflow_id}: {error}"))?
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read workflow lanes for {workflow_id}: {error}"))?;

    let mut workflow_lane_skills = Vec::new();
    for (lane_id, lane_name, lane_key) in lane_rows {
        let skills = query_skill_links(
            connection,
            r#"
            SELECT
                b.id,
                b.scope_kind,
                s.id,
                s.slug,
                s.name,
                s.description,
                s.source_kind,
                s.archived,
                s.status
            FROM skill_scope_bindings b
            JOIN skills s ON s.id = b.skill_id
            WHERE b.scope_kind = 'workflow_lane'
              AND b.workflow_id = ?1
              AND b.workflow_lane_id = ?2
            ORDER BY
                s.archived ASC,
                CASE s.status
                    WHEN 'active' THEN 0
                    WHEN 'shadowed' THEN 1
                    WHEN 'invalid' THEN 2
                    WHEN 'unloadable' THEN 3
                    WHEN 'missing' THEN 4
                    ELSE 5
                END ASC,
                s.name COLLATE NOCASE ASC,
                b.created_at ASC
            "#,
            params![workflow_id, lane_id],
        )?;

        if !skills.is_empty() {
            workflow_lane_skills.push(WorkflowLaneSkillLinks {
                workflow_lane_id: lane_id,
                workflow_lane_name: lane_name,
                workflow_lane_key: lane_key,
                skills,
            });
        }
    }

    Ok(WorkflowSkillLinks {
        workflow_id: workflow_id.to_string(),
        workflow_skills,
        workflow_lane_skills,
    })
}

fn query_skill_links<P: Params>(
    connection: &Connection,
    sql: &str,
    params: P,
) -> Result<Vec<SkillLinkSummary>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Unable to prepare skill link query: {error}"))?;

    let rows = statement
        .query_map(params, |row| {
            Ok(SkillLinkSummary {
                binding_id: row.get(0)?,
                scope_kind: row.get(1)?,
                skill_id: row.get(2)?,
                skill_slug: row.get(3)?,
                skill_name: row.get(4)?,
                skill_description: row.get(5)?,
                skill_source_kind: row.get(6)?,
                skill_archived: row.get::<_, i64>(7)? != 0,
                skill_status: row.get(8)?,
            })
        })
        .map_err(|error| format!("Unable to execute skill link query: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read skill link rows: {error}"))
}

fn normalize_requested_bindings(
    bindings: Vec<SkillBindingInput>,
) -> Result<Vec<NormalizedSkillBindingInput>, String> {
    let mut normalized = Vec::new();

    for binding in bindings {
        let scope_kind = binding.scope_kind.trim().to_string();
        let project_id = normalize_optional_id(binding.project_id);
        let role_id = normalize_optional_id(binding.role_id);
        let agent_id = normalize_optional_id(binding.agent_id);
        let workflow_id = normalize_optional_id(binding.workflow_id);
        let workflow_lane_id = normalize_optional_id(binding.workflow_lane_id);

        let normalized_binding = match scope_kind.as_str() {
            SCOPE_GLOBAL => {
                if project_id.is_some()
                    || role_id.is_some()
                    || agent_id.is_some()
                    || workflow_id.is_some()
                    || workflow_lane_id.is_some()
                {
                    return Err("Global bindings cannot include project, role, agent, workflow, or lane targets.".into());
                }
                NormalizedSkillBindingInput {
                    scope_kind,
                    project_id: None,
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                }
            }
            SCOPE_PROJECT => {
                if project_id.is_none()
                    || role_id.is_some()
                    || agent_id.is_some()
                    || workflow_id.is_some()
                    || workflow_lane_id.is_some()
                {
                    return Err("Project bindings must include only a project target.".into());
                }
                NormalizedSkillBindingInput {
                    scope_kind,
                    project_id,
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                }
            }
            SCOPE_ROLE => {
                if role_id.is_none()
                    || project_id.is_some()
                    || agent_id.is_some()
                    || workflow_id.is_some()
                    || workflow_lane_id.is_some()
                {
                    return Err("Role bindings must include only a role target.".into());
                }
                NormalizedSkillBindingInput {
                    scope_kind,
                    project_id: None,
                    role_id,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                }
            }
            SCOPE_AGENT => {
                if agent_id.is_none()
                    || project_id.is_some()
                    || role_id.is_some()
                    || workflow_id.is_some()
                    || workflow_lane_id.is_some()
                {
                    return Err("Agent bindings must include only an agent target.".into());
                }
                NormalizedSkillBindingInput {
                    scope_kind,
                    project_id: None,
                    role_id: None,
                    agent_id,
                    workflow_id: None,
                    workflow_lane_id: None,
                }
            }
            SCOPE_WORKFLOW => {
                if workflow_id.is_none()
                    || project_id.is_some()
                    || role_id.is_some()
                    || agent_id.is_some()
                    || workflow_lane_id.is_some()
                {
                    return Err("Workflow bindings must include only a workflow target.".into());
                }
                NormalizedSkillBindingInput {
                    scope_kind,
                    project_id: None,
                    role_id: None,
                    agent_id: None,
                    workflow_id,
                    workflow_lane_id: None,
                }
            }
            SCOPE_WORKFLOW_LANE => {
                if workflow_id.is_none()
                    || workflow_lane_id.is_none()
                    || project_id.is_some()
                    || role_id.is_some()
                    || agent_id.is_some()
                {
                    return Err("Workflow-lane bindings must include both a workflow and lane target only.".into());
                }
                NormalizedSkillBindingInput {
                    scope_kind,
                    project_id: None,
                    role_id: None,
                    agent_id: None,
                    workflow_id,
                    workflow_lane_id,
                }
            }
            _ => return Err(format!("Unsupported skill binding scope kind: {scope_kind}")),
        };

        if !normalized.contains(&normalized_binding) {
            normalized.push(normalized_binding);
        }
    }

    normalized.sort_by(|left, right| {
        scope_order(&left.scope_kind)
            .cmp(&scope_order(&right.scope_kind))
            .then_with(|| left.project_id.cmp(&right.project_id))
            .then_with(|| left.role_id.cmp(&right.role_id))
            .then_with(|| left.agent_id.cmp(&right.agent_id))
            .then_with(|| left.workflow_id.cmp(&right.workflow_id))
            .then_with(|| left.workflow_lane_id.cmp(&right.workflow_lane_id))
    });

    if normalized.iter().any(|binding| binding.scope_kind == SCOPE_GLOBAL) && normalized.len() > 1 {
        return Err("A global binding is mutually exclusive with every narrower skill binding scope.".into());
    }

    Ok(normalized)
}

fn validate_requested_bindings(
    connection: &Connection,
    bindings: &[NormalizedSkillBindingInput],
) -> Result<(), String> {
    for binding in bindings {
        match binding.scope_kind.as_str() {
            SCOPE_PROJECT => ensure_target_exists(
                connection,
                "projects",
                binding.project_id.as_deref().unwrap_or_default(),
                "Project",
            )?,
            SCOPE_ROLE => ensure_target_exists(
                connection,
                "roles",
                binding.role_id.as_deref().unwrap_or_default(),
                "Role",
            )?,
            SCOPE_AGENT => ensure_target_exists(
                connection,
                "agents",
                binding.agent_id.as_deref().unwrap_or_default(),
                "Agent",
            )?,
            SCOPE_WORKFLOW => ensure_target_exists(
                connection,
                "workflows",
                binding.workflow_id.as_deref().unwrap_or_default(),
                "Workflow",
            )?,
            SCOPE_WORKFLOW_LANE => {
                let workflow_id = binding.workflow_id.as_deref().unwrap_or_default();
                let workflow_lane_id = binding.workflow_lane_id.as_deref().unwrap_or_default();
                ensure_target_exists(connection, "workflows", workflow_id, "Workflow")?;
                let lane_exists = connection
                    .query_row(
                        "SELECT EXISTS(SELECT 1 FROM workflow_lanes WHERE workflow_id = ?1 AND id = ?2)",
                        params![workflow_id, workflow_lane_id],
                        |row| row.get::<_, i64>(0),
                    )
                    .map_err(|error| {
                        format!(
                            "Unable to validate workflow lane {workflow_lane_id} for workflow {workflow_id}: {error}"
                        )
                    })?
                    != 0;
                if !lane_exists {
                    return Err(format!(
                        "Workflow lane {workflow_lane_id} does not belong to workflow {workflow_id}."
                    ));
                }
            }
            SCOPE_GLOBAL => {}
            _ => return Err(format!("Unsupported skill binding scope kind: {}", binding.scope_kind)),
        }
    }

    Ok(())
}

fn ensure_skill_exists(connection: &Connection, skill_id: &str) -> Result<(), String> {
    let exists = connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM skills WHERE id = ?1)",
            [skill_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Unable to validate skill {skill_id}: {error}"))?
        != 0;

    if exists {
        Ok(())
    } else {
        Err(format!("Skill {skill_id} was not found."))
    }
}

fn ensure_target_exists(
    connection: &Connection,
    table_name: &str,
    id: &str,
    entity_label: &str,
) -> Result<(), String> {
    let sql = format!("SELECT EXISTS(SELECT 1 FROM {table_name} WHERE id = ?1)");
    let exists = connection
        .query_row(&sql, [id], |row| row.get::<_, i64>(0))
        .map_err(|error| format!("Unable to validate {entity_label} {id}: {error}"))?
        != 0;

    if exists {
        Ok(())
    } else {
        Err(format!("{entity_label} {id} was not found."))
    }
}

fn normalize_optional_id(value: Option<String>) -> Option<String> {
    value.and_then(|entry| {
        let trimmed = entry.trim();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed.to_string())
        }
    })
}

fn scope_order(scope_kind: &str) -> usize {
    match scope_kind {
        SCOPE_GLOBAL => 0,
        SCOPE_PROJECT => 1,
        SCOPE_ROLE => 2,
        SCOPE_AGENT => 3,
        SCOPE_WORKFLOW => 4,
        SCOPE_WORKFLOW_LANE => 5,
        _ => 6,
    }
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

#[cfg(test)]
mod tests {
    use std::{fs, path::PathBuf};

    use rusqlite::Connection;

    use super::*;
    use crate::{
        models::LocalSkillUpsertInput,
        services::{database::initialize_database_at, skills},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "orchestra-skill-bindings-{label}-{}-{}-{}.db",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            Uuid::new_v4().simple()
        );
        path.push(unique);
        path
    }

    fn unique_temp_dir(label: &str) -> PathBuf {
        let mut path = std::env::temp_dir();
        let unique = format!(
            "orchestra-skill-bindings-{label}-{}-{}-{}",
            std::process::id(),
            Utc::now().timestamp_nanos_opt().unwrap_or_default(),
            Uuid::new_v4().simple()
        );
        path.push(unique);
        path
    }

    fn test_connection() -> Connection {
        let path = unique_temp_db("db");
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(&path).expect("database should open")
    }

    fn seed_project(connection: &Connection, project_id: &str, name: &str, slug: &str) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 'PRJ', ?4, ?4)",
                params![project_id, slug, name, now],
            )
            .expect("project should seed");
    }

    fn seed_role(connection: &Connection, role_id: &str, name: &str, slug: &str) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, compaction_window, direct_permissions, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, 'off', 1, NULL, '[]', 0, ?4, ?4)",
                params![role_id, slug, name, now],
            )
            .expect("role should seed");
    }

    fn seed_agent(
        connection: &Connection,
        agent_id: &str,
        name: &str,
        slug: &str,
        role_id: Option<&str>,
    ) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, scope, project_id, thinking_level, compaction_window, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, ?4, 'global', NULL, 'off', NULL, '[]', 0, 0, 0, ?5, ?5)",
                params![agent_id, slug, name, role_id, now],
            )
            .expect("agent should seed");
    }

    fn seed_workflow(connection: &Connection, workflow_id: &str, name: &str, slug: &str) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, 0, ?4, ?4)",
                params![workflow_id, slug, name, now],
            )
            .expect("workflow should seed");
    }

    fn seed_workflow_lane(
        connection: &Connection,
        workflow_id: &str,
        lane_id: &str,
        lane_key: &str,
        name: &str,
        lane_order: i64,
    ) {
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO workflow_lanes (id, workflow_id, lane_key, name, description, lane_order, assigned_entity_type, assigned_entity_id, entry_prompt_template, use_separate_worktree, require_user_approval_on_success, success_transition_type, success_target_lane_id, failure_transition_type, failure_target_lane_id, user_intervention_target_lane_id, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, NULL, ?5, 'user', NULL, NULL, 0, 0, 'end', NULL, 'end', NULL, NULL, ?6, ?6)",
                params![lane_id, workflow_id, lane_key, name, lane_order, now],
            )
            .expect("workflow lane should seed");
    }

    fn create_skill(connection: &mut Connection, root: &PathBuf, name: &str) -> String {
        skills::create_local_skill(
            connection,
            root,
            LocalSkillUpsertInput {
                name: name.into(),
                slug: None,
                markdown_body: format!("{name} description."),
            },
        )
        .expect("skill should create")
        .summary
        .id
    }

    #[test]
    fn replaces_bindings_round_trip_and_loads_binding_records() {
        let root = unique_temp_dir("round-trip-root");
        fs::create_dir_all(&root).expect("root should create");
        let mut connection = test_connection();
        let skill_id = create_skill(&mut connection, &root, "Scoped Skill");
        seed_project(&connection, "project-1", "Alpha Project", "alpha-project");
        seed_role(&connection, "role-1", "Reviewer", "reviewer");
        seed_agent(&connection, "agent-1", "QA Helper", "qa-helper", Some("role-1"));
        seed_workflow(&connection, "workflow-1", "Delivery Workflow", "delivery-workflow");
        seed_workflow_lane(&connection, "workflow-1", "lane-1", "review", "Review", 0);

        set_skill_bindings(
            &mut connection,
            &skill_id,
            vec![
                SkillBindingInput {
                    scope_kind: SCOPE_PROJECT.into(),
                    project_id: Some("project-1".into()),
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                },
                SkillBindingInput {
                    scope_kind: SCOPE_ROLE.into(),
                    project_id: None,
                    role_id: Some("role-1".into()),
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                },
                SkillBindingInput {
                    scope_kind: SCOPE_AGENT.into(),
                    project_id: None,
                    role_id: None,
                    agent_id: Some("agent-1".into()),
                    workflow_id: None,
                    workflow_lane_id: None,
                },
                SkillBindingInput {
                    scope_kind: SCOPE_WORKFLOW.into(),
                    project_id: None,
                    role_id: None,
                    agent_id: None,
                    workflow_id: Some("workflow-1".into()),
                    workflow_lane_id: None,
                },
                SkillBindingInput {
                    scope_kind: SCOPE_WORKFLOW_LANE.into(),
                    project_id: None,
                    role_id: None,
                    agent_id: None,
                    workflow_id: Some("workflow-1".into()),
                    workflow_lane_id: Some("lane-1".into()),
                },
            ],
        )
        .expect("bindings should save");

        let summary = load_skill_binding_summary(&connection, &skill_id).expect("summary should load");
        assert_eq!(summary.total_count, 5);

        let bindings = load_skill_bindings(&connection, &skill_id).expect("bindings should load");
        assert_eq!(bindings.len(), 5);
        assert_eq!(bindings[0].project_name.as_deref(), Some("Alpha Project"));
        assert_eq!(bindings[1].role_name.as_deref(), Some("Reviewer"));
        assert_eq!(bindings[2].agent_name.as_deref(), Some("QA Helper"));
        assert_eq!(bindings[3].workflow_name.as_deref(), Some("Delivery Workflow"));
        assert_eq!(bindings[4].workflow_lane_name.as_deref(), Some("Review"));

        set_skill_bindings(
            &mut connection,
            &skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_GLOBAL.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
            }],
        )
        .expect("global replacement should save");

        let rebound = load_skill_bindings(&connection, &skill_id).expect("replaced bindings should load");
        assert_eq!(rebound.len(), 1);
        assert_eq!(rebound[0].scope_kind, SCOPE_GLOBAL);
    }

    #[test]
    fn rejects_global_binding_when_mixed_with_narrower_scopes() {
        let root = unique_temp_dir("global-exclusive-root");
        fs::create_dir_all(&root).expect("root should create");
        let mut connection = test_connection();
        let skill_id = create_skill(&mut connection, &root, "Global Skill");
        seed_role(&connection, "role-1", "Reviewer", "reviewer");

        let error = set_skill_bindings(
            &mut connection,
            &skill_id,
            vec![
                SkillBindingInput {
                    scope_kind: SCOPE_GLOBAL.into(),
                    project_id: None,
                    role_id: None,
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                },
                SkillBindingInput {
                    scope_kind: SCOPE_ROLE.into(),
                    project_id: None,
                    role_id: Some("role-1".into()),
                    agent_id: None,
                    workflow_id: None,
                    workflow_lane_id: None,
                },
            ],
        )
        .expect_err("global exclusivity should fail");

        assert!(error.contains("mutually exclusive"));
    }

    #[test]
    fn rejects_workflow_lane_binding_when_lane_does_not_belong_to_workflow() {
        let root = unique_temp_dir("lane-validation-root");
        fs::create_dir_all(&root).expect("root should create");
        let mut connection = test_connection();
        let skill_id = create_skill(&mut connection, &root, "Lane Skill");
        seed_workflow(&connection, "workflow-1", "Delivery Workflow", "delivery-workflow");
        seed_workflow(&connection, "workflow-2", "Other Workflow", "other-workflow");
        seed_workflow_lane(&connection, "workflow-2", "lane-1", "review", "Review", 0);

        let error = set_skill_bindings(
            &mut connection,
            &skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_WORKFLOW_LANE.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: Some("workflow-1".into()),
                workflow_lane_id: Some("lane-1".into()),
            }],
        )
        .expect_err("workflow-lane membership should fail");

        assert!(error.contains("does not belong to workflow"));
    }

    #[test]
    fn derives_agent_inherited_role_links_without_copying_rows() {
        let root = unique_temp_dir("agent-links-root");
        fs::create_dir_all(&root).expect("root should create");
        let mut connection = test_connection();
        let direct_skill_id = create_skill(&mut connection, &root, "Direct Agent Skill");
        let inherited_skill_id = create_skill(&mut connection, &root, "Inherited Role Skill");
        seed_role(&connection, "role-1", "Reviewer", "reviewer");
        seed_agent(&connection, "agent-1", "QA Helper", "qa-helper", Some("role-1"));

        set_skill_bindings(
            &mut connection,
            &direct_skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_AGENT.into(),
                project_id: None,
                role_id: None,
                agent_id: Some("agent-1".into()),
                workflow_id: None,
                workflow_lane_id: None,
            }],
        )
        .expect("agent binding should save");
        set_skill_bindings(
            &mut connection,
            &inherited_skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_ROLE.into(),
                project_id: None,
                role_id: Some("role-1".into()),
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
            }],
        )
        .expect("role binding should save");

        let links = get_agent_skill_links(&connection, "agent-1").expect("agent links should load");
        assert_eq!(links.direct_skills.len(), 1);
        assert_eq!(links.direct_skills[0].skill_id, direct_skill_id);
        assert_eq!(links.inherited_role_id.as_deref(), Some("role-1"));
        assert_eq!(links.inherited_role_name.as_deref(), Some("Reviewer"));
        assert_eq!(links.inherited_role_skills.len(), 1);
        assert_eq!(links.inherited_role_skills[0].skill_id, inherited_skill_id);
    }

    #[test]
    fn loads_role_and_workflow_reverse_links() {
        let root = unique_temp_dir("reverse-links-root");
        fs::create_dir_all(&root).expect("root should create");
        let mut connection = test_connection();
        let role_skill_id = create_skill(&mut connection, &root, "Role Skill");
        let workflow_skill_id = create_skill(&mut connection, &root, "Workflow Skill");
        let lane_skill_id = create_skill(&mut connection, &root, "Lane Skill");
        seed_role(&connection, "role-1", "Reviewer", "reviewer");
        seed_workflow(&connection, "workflow-1", "Delivery Workflow", "delivery-workflow");
        seed_workflow_lane(&connection, "workflow-1", "lane-1", "review", "Review", 0);
        seed_workflow_lane(&connection, "workflow-1", "lane-2", "ship", "Ship", 1);

        set_skill_bindings(
            &mut connection,
            &role_skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_ROLE.into(),
                project_id: None,
                role_id: Some("role-1".into()),
                agent_id: None,
                workflow_id: None,
                workflow_lane_id: None,
            }],
        )
        .expect("role binding should save");
        set_skill_bindings(
            &mut connection,
            &workflow_skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_WORKFLOW.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: Some("workflow-1".into()),
                workflow_lane_id: None,
            }],
        )
        .expect("workflow binding should save");
        set_skill_bindings(
            &mut connection,
            &lane_skill_id,
            vec![SkillBindingInput {
                scope_kind: SCOPE_WORKFLOW_LANE.into(),
                project_id: None,
                role_id: None,
                agent_id: None,
                workflow_id: Some("workflow-1".into()),
                workflow_lane_id: Some("lane-1".into()),
            }],
        )
        .expect("lane binding should save");

        let role_links = get_role_skill_links(&connection, "role-1").expect("role links should load");
        assert_eq!(role_links.skills.len(), 1);
        assert_eq!(role_links.skills[0].skill_id, role_skill_id);

        let workflow_links = get_workflow_skill_links(&connection, "workflow-1")
            .expect("workflow links should load");
        assert_eq!(workflow_links.workflow_skills.len(), 1);
        assert_eq!(workflow_links.workflow_skills[0].skill_id, workflow_skill_id);
        assert_eq!(workflow_links.workflow_lane_skills.len(), 1);
        assert_eq!(workflow_links.workflow_lane_skills[0].workflow_lane_id, "lane-1");
        assert_eq!(workflow_links.workflow_lane_skills[0].skills.len(), 1);
        assert_eq!(workflow_links.workflow_lane_skills[0].skills[0].skill_id, lane_skill_id);
    }
}
