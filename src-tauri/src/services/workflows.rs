use std::collections::HashSet;

use chrono::Utc;
use rusqlite::{params, Connection, OptionalExtension};
use uuid::Uuid;

use crate::models::{
    WorkflowDefinition, WorkflowLane, WorkflowLaneInput, WorkflowSummary, WorkflowUpsertInput,
    WorkflowValidationError, WorkflowValidationResult,
};

pub fn list_workflows(
    connection: &Connection,
    include_archived: bool,
) -> Result<Vec<WorkflowSummary>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                w.id,
                w.slug,
                w.name,
                w.description,
                w.archived,
                w.created_at,
                w.updated_at,
                COUNT(l.id) AS lane_count
            FROM workflows w
            LEFT JOIN workflow_lanes l ON l.workflow_id = w.id
            WHERE (?1 = 1 OR w.archived = 0)
            GROUP BY w.id, w.slug, w.name, w.description, w.archived, w.created_at, w.updated_at
            ORDER BY w.archived ASC, w.updated_at DESC, w.name ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare workflow list query: {error}"))?;

    let rows = statement
        .query_map([if include_archived { 1 } else { 0 }], |row| {
            Ok(WorkflowSummary {
                id: row.get(0)?,
                slug: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                archived: row.get::<_, i64>(4)? != 0,
                created_at: row.get(5)?,
                updated_at: row.get(6)?,
                lane_count: row.get::<_, i64>(7)? as usize,
            })
        })
        .map_err(|error| format!("Unable to query workflows: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read workflow rows: {error}"))
}

pub fn get_workflow(
    connection: &Connection,
    workflow_id: &str,
) -> Result<WorkflowDefinition, String> {
    let mut workflow = connection
        .query_row(
            r#"
            SELECT id, slug, name, description, archived, created_at, updated_at
            FROM workflows
            WHERE id = ?1
            "#,
            [workflow_id],
            |row| {
                Ok(WorkflowDefinition {
                    id: row.get(0)?,
                    slug: row.get(1)?,
                    name: row.get(2)?,
                    description: row.get(3)?,
                    archived: row.get::<_, i64>(4)? != 0,
                    created_at: row.get(5)?,
                    updated_at: row.get(6)?,
                    lanes: Vec::new(),
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to query workflow {workflow_id}: {error}"))?
        .ok_or_else(|| format!("Workflow {workflow_id} was not found"))?;

    workflow.lanes = load_lanes(connection, workflow_id)?;
    Ok(workflow)
}

pub fn create_workflow(
    connection: &mut Connection,
    input: WorkflowUpsertInput,
) -> Result<WorkflowDefinition, String> {
    let validation = validate_workflow(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let now = now_iso();
    let workflow_id = workflow_id();
    let slug = unique_slug(connection, &input.name, None)?;
    let normalized = normalize_input(input);
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start workflow creation transaction: {error}"))?;

    tx.execute(
        r#"
        INSERT INTO workflows (id, slug, name, description, archived, created_at, updated_at)
        VALUES (?1, ?2, ?3, ?4, 0, ?5, ?5)
        "#,
        params![
            workflow_id,
            slug,
            normalized.name,
            normalized.description,
            now
        ],
    )
    .map_err(|error| format!("Unable to create workflow: {error}"))?;

    write_lanes(&tx, &workflow_id, &normalized.lanes, &now)?;
    tx.commit()
        .map_err(|error| format!("Unable to commit workflow creation: {error}"))?;

    get_workflow(connection, &workflow_id)
}

pub fn update_workflow(
    connection: &mut Connection,
    workflow_id: &str,
    input: WorkflowUpsertInput,
) -> Result<WorkflowDefinition, String> {
    if !workflow_exists(connection, workflow_id)? {
        return Err(format!("Workflow {workflow_id} was not found"));
    }

    let validation = validate_workflow(connection, &input)?;
    if !validation.valid {
        return Err(format_validation_errors(&validation.errors));
    }

    let existing_slug: String = connection
        .query_row(
            "SELECT slug FROM workflows WHERE id = ?1",
            [workflow_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to load workflow {workflow_id} for update: {error}"))?;

    let normalized = normalize_input(input);
    let next_slug = if slugify(&normalized.name)
        == slugify(&workflow_name_for_slug(connection, workflow_id)?)
    {
        existing_slug
    } else {
        unique_slug(connection, &normalized.name, Some(workflow_id))?
    };
    let now = now_iso();
    let tx = connection
        .transaction()
        .map_err(|error| format!("Unable to start workflow update transaction: {error}"))?;

    tx.execute(
        r#"
        UPDATE workflows
        SET slug = ?2, name = ?3, description = ?4, updated_at = ?5
        WHERE id = ?1
        "#,
        params![
            workflow_id,
            next_slug,
            normalized.name,
            normalized.description,
            now
        ],
    )
    .map_err(|error| format!("Unable to update workflow {workflow_id}: {error}"))?;

    tx.execute(
        "DELETE FROM workflow_lanes WHERE workflow_id = ?1",
        [workflow_id],
    )
    .map_err(|error| format!("Unable to replace workflow lanes for {workflow_id}: {error}"))?;
    write_lanes(&tx, workflow_id, &normalized.lanes, &now)?;

    tx.commit()
        .map_err(|error| format!("Unable to commit workflow update: {error}"))?;

    get_workflow(connection, workflow_id)
}

pub fn duplicate_workflow(
    connection: &mut Connection,
    workflow_id: &str,
    new_name: Option<String>,
) -> Result<WorkflowDefinition, String> {
    let workflow = get_workflow(connection, workflow_id)?;
    let duplicated_name = new_name
        .and_then(|value| normalized_optional_string(Some(value)))
        .unwrap_or_else(|| format!("{} Copy", workflow.name));

    let lane_id_map = workflow
        .lanes
        .iter()
        .map(|lane| (lane.id.clone(), lane_id()))
        .collect::<std::collections::HashMap<_, _>>();

    let input = WorkflowUpsertInput {
        name: duplicated_name,
        description: workflow.description,
        lanes: workflow
            .lanes
            .into_iter()
            .map(|lane| WorkflowLaneInput {
                id: lane_id_map.get(&lane.id).cloned(),
                key: lane.key,
                name: lane.name,
                description: lane.description,
                order: Some(lane.order),
                assigned_entity_type: lane.assigned_entity_type,
                assigned_entity_id: lane.assigned_entity_id,
                entry_prompt_template: lane.entry_prompt_template,
                use_separate_worktree: lane.use_separate_worktree,
                require_user_approval_on_success: lane.require_user_approval_on_success,
                success_transition_type: lane.success_transition_type,
                success_target_lane_id: remap_lane_target(
                    &lane_id_map,
                    lane.success_target_lane_id,
                ),
                failure_transition_type: lane.failure_transition_type,
                failure_target_lane_id: remap_lane_target(
                    &lane_id_map,
                    lane.failure_target_lane_id,
                ),
            })
            .collect(),
    };

    create_workflow(connection, input)
}

pub fn archive_workflow(
    connection: &Connection,
    workflow_id: &str,
) -> Result<WorkflowDefinition, String> {
    let updated = connection
        .execute(
            "UPDATE workflows SET archived = 1, updated_at = ?2 WHERE id = ?1",
            params![workflow_id, now_iso()],
        )
        .map_err(|error| format!("Unable to archive workflow {workflow_id}: {error}"))?;

    if updated == 0 {
        return Err(format!("Workflow {workflow_id} was not found"));
    }

    get_workflow(connection, workflow_id)
}

pub fn validate_workflow(
    connection: &Connection,
    input: &WorkflowUpsertInput,
) -> Result<WorkflowValidationResult, String> {
    let normalized = normalize_input(input.clone());
    let mut errors = Vec::new();

    if normalized.name.is_empty() {
        errors.push(validation_error(
            "required",
            "name",
            "Workflow name is required.",
        ));
    }

    if normalized.lanes.is_empty() {
        errors.push(validation_error(
            "required",
            "lanes",
            "A workflow must contain at least one lane.",
        ));
    }

    let mut seen_lane_ids = HashSet::new();
    let mut seen_lane_keys = HashSet::new();
    let mut seen_orders = HashSet::new();
    let mut lane_ids = HashSet::new();

    for (index, lane) in normalized.lanes.iter().enumerate() {
        let path_prefix = format!("lanes[{index}]");

        if lane.id.trim().is_empty() {
            errors.push(validation_error(
                "required",
                &format!("{path_prefix}.id"),
                "Lane id is required.",
            ));
        }
        if !seen_lane_ids.insert(lane.id.clone()) {
            errors.push(validation_error(
                "duplicate",
                &format!("{path_prefix}.id"),
                "Lane ids must be unique within a workflow.",
            ));
        }
        lane_ids.insert(lane.id.clone());

        if lane.key.trim().is_empty() {
            errors.push(validation_error(
                "required",
                &format!("{path_prefix}.key"),
                "Lane key is required.",
            ));
        } else if !seen_lane_keys.insert(lane.key.clone()) {
            errors.push(validation_error(
                "duplicate",
                &format!("{path_prefix}.key"),
                "Lane keys must be unique within a workflow.",
            ));
        }

        if lane.name.trim().is_empty() {
            errors.push(validation_error(
                "required",
                &format!("{path_prefix}.name"),
                "Lane name is required.",
            ));
        }

        if !seen_orders.insert(lane.order) {
            errors.push(validation_error(
                "duplicate",
                &format!("{path_prefix}.order"),
                "Lane order values must be unique within a workflow.",
            ));
        }

        let entity_type = lane.assigned_entity_type.as_str();
        if !matches!(entity_type, "user" | "agent" | "role") {
            errors.push(validation_error(
                "invalid",
                &format!("{path_prefix}.assignedEntityType"),
                "Lane owner type must be one of: user, agent, role.",
            ));
        }

        match entity_type {
            "user" => {
                if lane.assigned_entity_id.is_some() {
                    errors.push(validation_error(
                        "invalid",
                        &format!("{path_prefix}.assignedEntityId"),
                        "User-owned lanes must not specify an assigned entity id.",
                    ));
                }
                if lane.require_user_approval_on_success {
                    errors.push(validation_error(
                        "invalid",
                        &format!("{path_prefix}.requireUserApprovalOnSuccess"),
                        "User-owned lanes cannot require user approval on success.",
                    ));
                }
            }
            "agent" => {
                validate_owner_reference(
                    connection,
                    "agents",
                    "slug",
                    lane,
                    &path_prefix,
                    &mut errors,
                )?;
            }
            "role" => {
                validate_owner_reference(
                    connection,
                    "roles",
                    "slug",
                    lane,
                    &path_prefix,
                    &mut errors,
                )?;
            }
            _ => {}
        }
    }

    for (index, lane) in normalized.lanes.iter().enumerate() {
        validate_transition(
            &mut errors,
            &lane_ids,
            lane.success_transition_type.as_str(),
            lane.success_target_lane_id.as_deref(),
            &format!("lanes[{index}].successTransitionType"),
            &format!("lanes[{index}].successTargetLaneId"),
        );
        validate_transition(
            &mut errors,
            &lane_ids,
            lane.failure_transition_type.as_str(),
            lane.failure_target_lane_id.as_deref(),
            &format!("lanes[{index}].failureTransitionType"),
            &format!("lanes[{index}].failureTargetLaneId"),
        );
    }

    Ok(WorkflowValidationResult {
        valid: errors.is_empty(),
        errors,
    })
}

fn validate_transition(
    errors: &mut Vec<WorkflowValidationError>,
    lane_ids: &HashSet<String>,
    transition_type: &str,
    target: Option<&str>,
    type_path: &str,
    target_path: &str,
) {
    if !matches!(transition_type, "lane" | "user_intervention" | "end") {
        errors.push(validation_error(
            "invalid",
            type_path,
            "Transition type must be one of: lane, user_intervention, end.",
        ));
        return;
    }

    match transition_type {
        "lane" => {
            let Some(target) = target.filter(|value| !value.trim().is_empty()) else {
                errors.push(validation_error(
                    "required",
                    target_path,
                    "Lane transitions must reference a target lane.",
                ));
                return;
            };

            if !lane_ids.contains(target) {
                errors.push(validation_error(
                    "invalid_reference",
                    target_path,
                    "Transition target must reference an existing lane id.",
                ));
            }
        }
        "user_intervention" | "end" => {
            if target.is_some_and(|value| !value.trim().is_empty()) {
                errors.push(validation_error(
                    "invalid",
                    target_path,
                    "Only lane transitions may specify a target lane.",
                ));
            }
        }
        _ => {}
    }
}

fn validate_owner_reference(
    connection: &Connection,
    table: &str,
    reference_column: &str,
    lane: &NormalizedLaneInput,
    path_prefix: &str,
    errors: &mut Vec<WorkflowValidationError>,
) -> Result<(), String> {
    let Some(entity_id) = lane.assigned_entity_id.as_deref() else {
        errors.push(validation_error(
            "required",
            &format!("{path_prefix}.assignedEntityId"),
            "This lane owner type requires an assigned entity id.",
        ));
        return Ok(());
    };

    let exists = connection
        .query_row(
            &format!(
                "SELECT EXISTS(SELECT 1 FROM {table} WHERE {reference_column} = ?1 AND archived = 0)"
            ),
            [entity_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| format!("Unable to validate lane owner reference: {error}"))?
        != 0;

    if !exists {
        errors.push(validation_error(
            "invalid_reference",
            &format!("{path_prefix}.assignedEntityId"),
            "Assigned entity id does not reference an existing active worker.",
        ));
    }

    Ok(())
}

fn workflow_exists(connection: &Connection, workflow_id: &str) -> Result<bool, String> {
    connection
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM workflows WHERE id = ?1)",
            [workflow_id],
            |row| row.get::<_, i64>(0),
        )
        .map(|value| value != 0)
        .map_err(|error| format!("Unable to check workflow existence for {workflow_id}: {error}"))
}

fn workflow_name_for_slug(connection: &Connection, workflow_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT name FROM workflows WHERE id = ?1",
            [workflow_id],
            |row| row.get(0),
        )
        .map_err(|error| format!("Unable to load workflow name for {workflow_id}: {error}"))
}

fn unique_slug(
    connection: &Connection,
    name: &str,
    exclude_workflow_id: Option<&str>,
) -> Result<String, String> {
    let base_slug = slugify(name);
    let mut suffix = 0usize;

    loop {
        let candidate = if suffix == 0 {
            base_slug.clone()
        } else {
            format!("{}-{}", base_slug, suffix + 1)
        };

        let exists = if let Some(workflow_id) = exclude_workflow_id {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflows WHERE slug = ?1 AND id != ?2)",
                params![candidate, workflow_id],
                |row| row.get::<_, i64>(0),
            )
        } else {
            connection.query_row(
                "SELECT EXISTS(SELECT 1 FROM workflows WHERE slug = ?1)",
                params![candidate],
                |row| row.get::<_, i64>(0),
            )
        }
        .map_err(|error| format!("Unable to generate workflow slug: {error}"))?
            != 0;

        if !exists {
            return Ok(candidate);
        }

        suffix += 1;
    }
}

fn load_lanes(connection: &Connection, workflow_id: &str) -> Result<Vec<WorkflowLane>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                lane_key,
                name,
                description,
                lane_order,
                assigned_entity_type,
                assigned_entity_id,
                entry_prompt_template,
                use_separate_worktree,
                require_user_approval_on_success,
                success_transition_type,
                success_target_lane_id,
                failure_transition_type,
                failure_target_lane_id
            FROM workflow_lanes
            WHERE workflow_id = ?1
            ORDER BY lane_order ASC, created_at ASC
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare lane query for workflow {workflow_id}: {error}")
        })?;

    let rows = statement
        .query_map([workflow_id], |row| {
            Ok(WorkflowLane {
                id: row.get(0)?,
                key: row.get(1)?,
                name: row.get(2)?,
                description: row.get(3)?,
                order: row.get(4)?,
                assigned_entity_type: row.get(5)?,
                assigned_entity_id: row.get(6)?,
                entry_prompt_template: row.get(7)?,
                use_separate_worktree: row.get::<_, i64>(8)? != 0,
                require_user_approval_on_success: row.get::<_, i64>(9)? != 0,
                success_transition_type: row.get(10)?,
                success_target_lane_id: row.get(11)?,
                failure_transition_type: row.get(12)?,
                failure_target_lane_id: row.get(13)?,
            })
        })
        .map_err(|error| format!("Unable to query workflow lanes for {workflow_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read workflow lanes for {workflow_id}: {error}"))
}

fn write_lanes(
    connection: &Connection,
    workflow_id: &str,
    lanes: &[NormalizedLaneInput],
    now: &str,
) -> Result<(), String> {
    for lane in lanes {
        connection
            .execute(
                r#"
                INSERT INTO workflow_lanes (
                    id,
                    workflow_id,
                    lane_key,
                    name,
                    description,
                    lane_order,
                    assigned_entity_type,
                    assigned_entity_id,
                    entry_prompt_template,
                    use_separate_worktree,
                    require_user_approval_on_success,
                    success_transition_type,
                    success_target_lane_id,
                    failure_transition_type,
                    failure_target_lane_id,
                    user_intervention_target_lane_id,
                    created_at,
                    updated_at
                ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, ?15, NULL, ?16, ?16)
                "#,
                params![
                    lane.id,
                    workflow_id,
                    lane.key,
                    lane.name,
                    lane.description,
                    lane.order,
                    lane.assigned_entity_type,
                    lane.assigned_entity_id,
                    lane.entry_prompt_template,
                    if lane.use_separate_worktree { 1 } else { 0 },
                    if lane.require_user_approval_on_success { 1 } else { 0 },
                    lane.success_transition_type,
                    lane.success_target_lane_id,
                    lane.failure_transition_type,
                    lane.failure_target_lane_id,
                    now,
                ],
            )
            .map_err(|error| format!("Unable to create workflow lane {}: {error}", lane.name))?;
    }

    Ok(())
}

#[derive(Debug, Clone)]
struct NormalizedWorkflowInput {
    name: String,
    description: Option<String>,
    lanes: Vec<NormalizedLaneInput>,
}

#[derive(Debug, Clone)]
struct NormalizedLaneInput {
    id: String,
    key: String,
    name: String,
    description: Option<String>,
    order: i64,
    assigned_entity_type: String,
    assigned_entity_id: Option<String>,
    entry_prompt_template: Option<String>,
    use_separate_worktree: bool,
    require_user_approval_on_success: bool,
    success_transition_type: String,
    success_target_lane_id: Option<String>,
    failure_transition_type: String,
    failure_target_lane_id: Option<String>,
}

fn remap_lane_target(
    lane_id_map: &std::collections::HashMap<String, String>,
    target: Option<String>,
) -> Option<String> {
    target.and_then(|value| lane_id_map.get(&value).cloned())
}

fn normalize_input(input: WorkflowUpsertInput) -> NormalizedWorkflowInput {
    NormalizedWorkflowInput {
        name: input.name.trim().to_string(),
        description: normalized_optional_string(input.description),
        lanes: input
            .lanes
            .into_iter()
            .enumerate()
            .map(|(index, lane)| normalize_lane_input(index, lane))
            .collect(),
    }
}

fn normalize_lane_input(index: usize, lane: WorkflowLaneInput) -> NormalizedLaneInput {
    let assigned_entity_type = lane.assigned_entity_type.trim().to_lowercase();
    NormalizedLaneInput {
        id: lane
            .id
            .and_then(|value| normalized_optional_string(Some(value)))
            .unwrap_or_else(lane_id),
        key: slugify(&lane.key),
        name: lane.name.trim().to_string(),
        description: normalized_optional_string(lane.description),
        order: lane.order.unwrap_or(index as i64),
        assigned_entity_type: assigned_entity_type.clone(),
        assigned_entity_id: normalized_optional_string(lane.assigned_entity_id),
        entry_prompt_template: normalized_optional_string(lane.entry_prompt_template),
        use_separate_worktree: lane.use_separate_worktree && matches!(assigned_entity_type.as_str(), "agent" | "role"),
        require_user_approval_on_success: lane.require_user_approval_on_success,
        success_transition_type: normalize_transition_type(&lane.success_transition_type),
        success_target_lane_id: normalize_transition_target(
            &lane.success_transition_type,
            lane.success_target_lane_id,
        ),
        failure_transition_type: normalize_transition_type(&lane.failure_transition_type),
        failure_target_lane_id: normalize_transition_target(
            &lane.failure_transition_type,
            lane.failure_target_lane_id,
        ),
    }
}

fn normalized_optional_string(value: Option<String>) -> Option<String> {
    value.and_then(|inner| {
        let trimmed = inner.trim().to_string();
        if trimmed.is_empty() {
            None
        } else {
            Some(trimmed)
        }
    })
}

fn normalize_transition_type(value: &str) -> String {
    let normalized = value.trim().to_lowercase();
    if matches!(normalized.as_str(), "lane" | "user_intervention" | "end") {
        normalized
    } else {
        "end".into()
    }
}

fn normalize_transition_target(transition_type: &str, target: Option<String>) -> Option<String> {
    if transition_type.trim().eq_ignore_ascii_case("lane") {
        normalized_optional_string(target)
    } else {
        None
    }
}

fn slugify(value: &str) -> String {
    let mut slug = String::new();
    let mut last_was_dash = false;

    for ch in value.trim().chars().flat_map(|ch| ch.to_lowercase()) {
        if ch.is_ascii_alphanumeric() {
            slug.push(ch);
            last_was_dash = false;
        } else if !last_was_dash {
            slug.push('-');
            last_was_dash = true;
        }
    }

    let trimmed = slug.trim_matches('-').to_string();
    if trimmed.is_empty() {
        "workflow".into()
    } else {
        trimmed
    }
}

fn workflow_id() -> String {
    format!("workflow-{}", Uuid::new_v4().simple())
}

fn lane_id() -> String {
    format!("lane-{}", Uuid::new_v4().simple())
}

fn now_iso() -> String {
    Utc::now().to_rfc3339()
}

fn validation_error(code: &str, path: &str, message: &str) -> WorkflowValidationError {
    WorkflowValidationError {
        code: code.into(),
        path: path.into(),
        message: message.into(),
    }
}

fn format_validation_errors(errors: &[WorkflowValidationError]) -> String {
    let joined = errors
        .iter()
        .map(|error| format!("{}: {}", error.path, error.message))
        .collect::<Vec<_>>()
        .join("; ");
    format!("Workflow validation failed: {joined}")
}

#[cfg(test)]
pub fn seed_worker(
    connection: &Connection,
    table: &str,
    id: &str,
    name: &str,
) -> Result<(), String> {
    let now = now_iso();

    match table {
        "roles" => {
            connection
                .execute(
                    "INSERT INTO roles (id, slug, name, description, system_prompt, provider, model, thinking_level, capacity, direct_permissions, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, 'off', 1, '[]', 0, ?4, ?4)",
                    params![id, slugify(name), name, now],
                )
                .map_err(|error| format!("Unable to seed role for tests: {error}"))?;
        }
        "agents" => {
            connection
                .execute(
                    "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, NULL, 'off', '[]', 0, 0, 0, ?4, ?4)",
                    params![id, slugify(name), name, now],
                )
                .map_err(|error| format!("Unable to seed agent for tests: {error}"))?;
        }
        _ => {
            connection
                .execute(
                    &format!(
                        "INSERT INTO {table} (id, name, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, NULL, 'off', '[]', 0, 0, 0, ?3, ?3)"
                    ),
                    params![id, name, now],
                )
                .map_err(|error| format!("Unable to seed worker for tests: {error}"))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::initialize_database_at;
    use std::{
        env,
        path::PathBuf,
        time::{SystemTime, UNIX_EPOCH},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        let suffix = format!(
            "{}-{}-{}",
            label,
            std::process::id(),
            SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .expect("time should move forward")
                .as_millis()
        );
        env::temp_dir().join(suffix).join("orchestra.db")
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        Connection::open(path).expect("database should open")
    }

    fn sample_workflow_input() -> WorkflowUpsertInput {
        WorkflowUpsertInput {
            name: "Development".into(),
            description: Some("Basic development flow".into()),
            lanes: vec![
                WorkflowLaneInput {
                    id: Some("lane-plan".into()),
                    key: "plan".into(),
                    name: "Plan".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "user".into(),
                    assigned_entity_id: None,
                    entry_prompt_template: Some("Draft a plan".into()),
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "lane".into(),
                    success_target_lane_id: Some("lane-build".into()),
                    failure_transition_type: "user_intervention".into(),
                    failure_target_lane_id: None,
                },
                WorkflowLaneInput {
                    id: Some("lane-build".into()),
                    key: "build".into(),
                    name: "Build".into(),
                    description: None,
                    order: Some(1),
                    assigned_entity_type: "user".into(),
                    assigned_entity_id: None,
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "lane".into(),
                    failure_target_lane_id: Some("lane-plan".into()),
                },
            ],
        }
    }

    #[test]
    fn creates_lists_and_loads_workflows() {
        let mut connection = open_test_connection("workflow-crud");

        let created = create_workflow(&mut connection, sample_workflow_input())
            .expect("workflow should create");
        assert_eq!(created.name, "Development");
        assert_eq!(created.lanes.len(), 2);
        assert_eq!(created.slug, "development");

        let list = list_workflows(&connection, false).expect("workflows should list");
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].lane_count, 2);

        let loaded = get_workflow(&connection, &created.id).expect("workflow should load");
        assert_eq!(loaded.id, created.id);
        assert_eq!(loaded.lanes[0].id, "lane-plan");
        assert_eq!(loaded.lanes[1].success_target_lane_id, None);
    }

    #[test]
    fn updates_duplicates_and_archives_workflows() {
        let mut connection = open_test_connection("workflow-update");
        let created = create_workflow(&mut connection, sample_workflow_input())
            .expect("workflow should create");

        let updated = update_workflow(
            &mut connection,
            &created.id,
            WorkflowUpsertInput {
                name: "Development Revised".into(),
                description: Some("Updated description".into()),
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "user".into(),
                    assigned_entity_id: None,
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("workflow should update");

        assert_eq!(updated.name, "Development Revised");
        assert_eq!(updated.slug, "development-revised");
        assert_eq!(updated.lanes.len(), 1);

        let duplicated = duplicate_workflow(&mut connection, &updated.id, None)
            .expect("workflow should duplicate");
        assert_eq!(duplicated.name, "Development Revised Copy");
        assert_ne!(duplicated.id, updated.id);

        let archived = archive_workflow(&connection, &updated.id).expect("workflow should archive");
        assert!(archived.archived);

        let visible = list_workflows(&connection, false).expect("workflows should list");
        assert_eq!(visible.len(), 1);
        assert_eq!(visible[0].id, duplicated.id);

        let all = list_workflows(&connection, true).expect("all workflows should list");
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn rejects_invalid_transition_targets() {
        let connection = open_test_connection("workflow-validation-transition");
        let validation = validate_workflow(
            &connection,
            &WorkflowUpsertInput {
                name: "Broken".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-plan".into()),
                    key: "plan".into(),
                    name: "Plan".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "user".into(),
                    assigned_entity_id: None,
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "lane".into(),
                    success_target_lane_id: Some("missing-lane".into()),
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "lanes[0].successTargetLaneId"));
    }

    #[test]
    fn rejects_invalid_owner_references() {
        let connection = open_test_connection("workflow-validation-owner");
        let validation = validate_workflow(
            &connection,
            &WorkflowUpsertInput {
                name: "Needs worker".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-review".into()),
                    key: "review".into(),
                    name: "Review".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some("agent-missing".into()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "lanes[0].assignedEntityId"));
    }

    #[test]
    fn accepts_existing_role_owner_references() {
        let connection = open_test_connection("workflow-validation-owner-success");
        seed_worker(&connection, "roles", "role-reviewer", "Reviewer").expect("role should seed");

        let validation = validate_workflow(
            &connection,
            &WorkflowUpsertInput {
                name: "Review flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-review".into()),
                    key: "review".into(),
                    name: "Review".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "role".into(),
                    assigned_entity_id: Some("reviewer".into()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("validation should run");

        assert!(validation.valid);
    }

    #[test]
    fn accepts_existing_agent_owner_references_by_slug() {
        let connection = open_test_connection("workflow-validation-agent-owner-success");
        seed_worker(&connection, "agents", "agent-data", "Data").expect("agent should seed");

        let validation = validate_workflow(
            &connection,
            &WorkflowUpsertInput {
                name: "Implementation flow".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-implement".into()),
                    key: "implement".into(),
                    name: "Implement".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "agent".into(),
                    assigned_entity_id: Some("data".into()),
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: false,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("validation should run");

        assert!(validation.valid);
    }

    #[test]
    fn rejects_success_approval_for_user_owned_lanes() {
        let connection = open_test_connection("workflow-validation-user-approval");
        let validation = validate_workflow(
            &connection,
            &WorkflowUpsertInput {
                name: "User review loop".into(),
                description: None,
                lanes: vec![WorkflowLaneInput {
                    id: Some("lane-user".into()),
                    key: "user".into(),
                    name: "User".into(),
                    description: None,
                    order: Some(0),
                    assigned_entity_type: "user".into(),
                    assigned_entity_id: None,
                    entry_prompt_template: None,
                    use_separate_worktree: false,
                    require_user_approval_on_success: true,
                    success_transition_type: "end".into(),
                    success_target_lane_id: None,
                    failure_transition_type: "end".into(),
                    failure_target_lane_id: None,
                }],
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "lanes[0].requireUserApprovalOnSuccess"));
    }

    #[test]
    fn enforces_unique_lane_keys_and_orders() {
        let connection = open_test_connection("workflow-validation-duplicates");
        let validation = validate_workflow(
            &connection,
            &WorkflowUpsertInput {
                name: "Duplicate lanes".into(),
                description: None,
                lanes: vec![
                    WorkflowLaneInput {
                        id: Some("lane-a".into()),
                        key: "repeat".into(),
                        name: "First".into(),
                        description: None,
                        order: Some(0),
                        assigned_entity_type: "user".into(),
                        assigned_entity_id: None,
                        entry_prompt_template: None,
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "end".into(),
                        success_target_lane_id: None,
                        failure_transition_type: "end".into(),
                        failure_target_lane_id: None,
                    },
                    WorkflowLaneInput {
                        id: Some("lane-b".into()),
                        key: "repeat".into(),
                        name: "Second".into(),
                        description: None,
                        order: Some(0),
                        assigned_entity_type: "user".into(),
                        assigned_entity_id: None,
                        entry_prompt_template: None,
                        use_separate_worktree: false,
                        require_user_approval_on_success: false,
                        success_transition_type: "end".into(),
                        success_target_lane_id: None,
                        failure_transition_type: "end".into(),
                        failure_target_lane_id: None,
                    },
                ],
            },
        )
        .expect("validation should run");

        assert!(!validation.valid);
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "lanes[1].key"));
        assert!(validation
            .errors
            .iter()
            .any(|error| error.path == "lanes[1].order"));
    }

    #[test]
    fn generates_unique_slugs_for_duplicate_names() {
        let mut connection = open_test_connection("workflow-slugs");
        let first = create_workflow(&mut connection, sample_workflow_input())
            .expect("first workflow should create");
        let second = create_workflow(&mut connection, sample_workflow_input())
            .expect("second workflow should create");

        assert_eq!(first.slug, "development");
        assert_eq!(second.slug, "development-2");
    }
}
