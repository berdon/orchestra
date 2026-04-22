use chrono::{
    DateTime, Datelike, Duration, LocalResult, NaiveDate, NaiveDateTime, NaiveTime, TimeZone, Utc,
};
use chrono_tz::Tz;
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};

use crate::{
    models::{
        DomainEvent, TaskScheduleDetail, TaskScheduleEventTrigger, TaskScheduleOccurrence,
        TaskScheduleSummary, TaskScheduleTimeTrigger, TaskScheduleTrigger, TaskScheduleUpsertInput,
        TaskUpsertInput,
    },
    services::{domain_events, projects, tasks},
    state::{generate_id, now_iso},
};

const OVERLAP_SKIP: &str = "skip";
const OVERLAP_CREATE_ANOTHER: &str = "create_another";
const OCCURRENCE_PENDING: &str = "pending";
const OCCURRENCE_MATERIALIZED: &str = "materialized";
const OCCURRENCE_SKIPPED: &str = "skipped";
const OCCURRENCE_FAILED: &str = "failed";
const RECENT_OCCURRENCE_LIMIT: usize = 20;
const RECENT_TASK_LIMIT: usize = 10;

#[derive(Debug, Clone, Default)]
pub struct TaskScheduleProcessResult {
    pub materialized_task_ids: Vec<String>,
    pub touched_schedule_ids: Vec<String>,
}

#[derive(Debug, Clone)]
struct PersistedTaskSchedule {
    id: String,
    project_id: String,
    title: String,
    description: Option<String>,
    task_type: String,
    priority: String,
    workflow_id: Option<String>,
    task_blueprint: TaskUpsertInput,
    trigger: TaskScheduleTrigger,
    enabled: bool,
    one_shot: bool,
    overlap_policy: String,
    next_fire_at: Option<String>,
    last_fired_at: Option<String>,
    last_materialized_task_id: Option<String>,
    last_error: Option<String>,
    consumed_at: Option<String>,
    materialized_task_count: i64,
    open_materialized_task_count: i64,
    created_at: String,
    updated_at: String,
}

pub fn list_task_schedules(
    connection: &Connection,
    project_id: &str,
) -> Result<Vec<TaskScheduleSummary>, String> {
    projects::ensure_project_exists(connection, project_id)?;

    let mut statement = connection
        .prepare(
            r#"
            SELECT
                id,
                project_id,
                title,
                description,
                task_type,
                priority,
                workflow_id,
                task_blueprint_json,
                trigger_json,
                enabled,
                one_shot,
                overlap_policy,
                next_fire_at,
                last_fired_at,
                last_materialized_task_id,
                last_error,
                consumed_at,
                created_at,
                updated_at,
                COALESCE((SELECT COUNT(*) FROM tasks WHERE source_schedule_id = task_schedules.id), 0) AS materialized_task_count,
                COALESCE((SELECT COUNT(*) FROM tasks WHERE source_schedule_id = task_schedules.id AND status NOT IN ('completed', 'canceled')), 0) AS open_materialized_task_count
            FROM task_schedules
            WHERE project_id = ?1
            ORDER BY updated_at DESC, created_at DESC
            "#,
        )
        .map_err(|error| format!("Unable to prepare task schedules query: {error}"))?;

    let rows = statement
        .query_map([project_id], read_schedule_row)
        .map_err(|error| format!("Unable to query task schedules for {project_id}: {error}"))?;

    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read task schedules for {project_id}: {error}"))?
        .into_iter()
        .map(|schedule| Ok(to_summary(schedule)))
        .collect()
}

pub fn get_task_schedule(
    connection: &Connection,
    schedule_id: &str,
) -> Result<TaskScheduleDetail, String> {
    let schedule = load_schedule(connection, schedule_id)?;
    let recent_occurrences =
        list_schedule_occurrences(connection, schedule_id, RECENT_OCCURRENCE_LIMIT)?;
    let recent_materialized_tasks =
        tasks::list_tasks_materialized_from_schedule(connection, schedule_id, RECENT_TASK_LIMIT)?;
    Ok(TaskScheduleDetail {
        id: schedule.id,
        project_id: schedule.project_id,
        title: schedule.title,
        description: schedule.description,
        task_type: schedule.task_type,
        priority: schedule.priority,
        workflow_id: schedule.workflow_id,
        repository_ids: schedule.task_blueprint.repository_ids.clone(),
        enabled: schedule.enabled,
        one_shot: schedule.one_shot,
        overlap_policy: schedule.overlap_policy,
        trigger: schedule.trigger,
        next_fire_at: schedule.next_fire_at,
        last_fired_at: schedule.last_fired_at,
        last_materialized_task_id: schedule.last_materialized_task_id,
        last_error: schedule.last_error,
        materialized_task_count: schedule.materialized_task_count,
        open_materialized_task_count: schedule.open_materialized_task_count,
        task_blueprint: schedule.task_blueprint,
        recent_materialized_tasks,
        recent_occurrences,
        created_at: schedule.created_at,
        updated_at: schedule.updated_at,
    })
}

pub fn create_task_schedule(
    connection: &mut Connection,
    project_id: &str,
    input: TaskScheduleUpsertInput,
) -> Result<TaskScheduleDetail, String> {
    projects::ensure_project_exists(connection, project_id)?;
    let prepared = prepare_schedule_input(connection, project_id, input)?;
    let schedule_id = generate_id("task-schedule");
    let now = now_iso();

    connection
        .execute(
            r#"
            INSERT INTO task_schedules (
                id,
                project_id,
                title,
                description,
                task_type,
                priority,
                workflow_id,
                task_blueprint_json,
                trigger_type,
                trigger_json,
                enabled,
                one_shot,
                overlap_policy,
                next_fire_at,
                last_fired_at,
                last_materialized_task_id,
                last_error,
                consumed_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12, ?13, ?14, NULL, NULL, NULL, NULL, ?15, ?15)
            "#,
            params![
                schedule_id,
                project_id,
                prepared.title,
                prepared.description,
                prepared.task_type,
                prepared.priority,
                prepared.workflow_id,
                prepared.task_blueprint_json,
                prepared.trigger_type,
                prepared.trigger_json,
                if prepared.enabled { 1 } else { 0 },
                if prepared.one_shot { 1 } else { 0 },
                prepared.overlap_policy,
                prepared.next_fire_at,
                now,
            ],
        )
        .map_err(|error| format!("Unable to create task schedule: {error}"))?;

    get_task_schedule(connection, &schedule_id)
}

pub fn update_task_schedule(
    connection: &mut Connection,
    schedule_id: &str,
    input: TaskScheduleUpsertInput,
) -> Result<TaskScheduleDetail, String> {
    let existing = load_schedule(connection, schedule_id)?;
    let prepared = prepare_schedule_input(connection, &existing.project_id, input)?;
    let now = now_iso();

    connection
        .execute(
            r#"
            UPDATE task_schedules
            SET title = ?2,
                description = ?3,
                task_type = ?4,
                priority = ?5,
                workflow_id = ?6,
                task_blueprint_json = ?7,
                trigger_type = ?8,
                trigger_json = ?9,
                enabled = ?10,
                one_shot = ?11,
                overlap_policy = ?12,
                next_fire_at = ?13,
                last_error = NULL,
                consumed_at = NULL,
                updated_at = ?14
            WHERE id = ?1
            "#,
            params![
                schedule_id,
                prepared.title,
                prepared.description,
                prepared.task_type,
                prepared.priority,
                prepared.workflow_id,
                prepared.task_blueprint_json,
                prepared.trigger_type,
                prepared.trigger_json,
                if prepared.enabled { 1 } else { 0 },
                if prepared.one_shot { 1 } else { 0 },
                prepared.overlap_policy,
                prepared.next_fire_at,
                now,
            ],
        )
        .map_err(|error| format!("Unable to update task schedule {schedule_id}: {error}"))?;

    get_task_schedule(connection, schedule_id)
}

pub fn delete_task_schedule(
    connection: &Connection,
    schedule_id: &str,
) -> Result<TaskScheduleDetail, String> {
    let schedule = get_task_schedule(connection, schedule_id)?;
    connection
        .execute("DELETE FROM task_schedules WHERE id = ?1", [schedule_id])
        .map_err(|error| format!("Unable to delete task schedule {schedule_id}: {error}"))?;
    Ok(schedule)
}

pub fn process_due_task_schedules(
    connection: &mut Connection,
) -> Result<TaskScheduleProcessResult, String> {
    let mut result = TaskScheduleProcessResult::default();
    let now = Utc::now();

    let due_time_schedule_ids = list_due_time_schedule_ids(connection, now)?;
    for schedule_id in due_time_schedule_ids {
        if let Some(task_id) = process_due_time_schedule(connection, &schedule_id, now)? {
            result.materialized_task_ids.push(task_id);
        }
        result.touched_schedule_ids.push(schedule_id);
    }

    let event_schedule_ids = list_enabled_event_schedule_ids(connection)?;
    for schedule_id in event_schedule_ids {
        let materialized = process_event_schedule(connection, &schedule_id, now)?;
        if !materialized.is_empty() {
            result.materialized_task_ids.extend(materialized);
            result.touched_schedule_ids.push(schedule_id);
        }
    }

    result.touched_schedule_ids.sort();
    result.touched_schedule_ids.dedup();
    result.materialized_task_ids.sort();
    result.materialized_task_ids.dedup();
    Ok(result)
}

fn process_due_time_schedule(
    connection: &mut Connection,
    schedule_id: &str,
    now: chrono::DateTime<Utc>,
) -> Result<Option<String>, String> {
    let schedule = load_schedule(connection, schedule_id)?;
    if !schedule.enabled || schedule.consumed_at.is_some() {
        return Ok(None);
    }

    let Some(next_fire_at) = schedule.next_fire_at.clone() else {
        return Ok(None);
    };
    let scheduled_at = chrono::DateTime::parse_from_rfc3339(&next_fire_at)
        .map_err(|error| {
            format!("Unable to parse next_fire_at for schedule {schedule_id}: {error}")
        })?
        .with_timezone(&Utc);
    if scheduled_at > now {
        return Ok(None);
    }

    let occurrence_key = format!("time:{}", scheduled_at.to_rfc3339());
    let occurrence = get_or_create_occurrence(
        connection,
        &schedule.id,
        &occurrence_key,
        Some(next_fire_at.clone()),
        None,
    )?;
    if matches!(
        occurrence.status.as_str(),
        OCCURRENCE_MATERIALIZED | OCCURRENCE_SKIPPED
    ) {
        update_schedule_post_time_trigger(
            connection,
            &schedule,
            now,
            None,
            None,
            occurrence.status == OCCURRENCE_SKIPPED,
        )?;
        return Ok(occurrence.task_id);
    }

    match materialize_occurrence(connection, &schedule, &occurrence, None)? {
        MaterializationOutcome::Materialized(task_id) => {
            update_schedule_post_time_trigger(
                connection,
                &schedule,
                now,
                Some(&task_id),
                None,
                false,
            )?;
            Ok(Some(task_id))
        }
        MaterializationOutcome::Skipped(reason) => {
            update_schedule_post_time_trigger(
                connection,
                &schedule,
                now,
                None,
                Some(&reason),
                true,
            )?;
            Ok(None)
        }
        MaterializationOutcome::Failed(error) => {
            mark_occurrence(
                connection,
                &occurrence.id,
                OCCURRENCE_FAILED,
                None,
                Some(&error),
            )?;
            update_schedule_error(connection, &schedule.id, &error)?;
            Ok(None)
        }
    }
}

fn process_event_schedule(
    connection: &mut Connection,
    schedule_id: &str,
    now: chrono::DateTime<Utc>,
) -> Result<Vec<String>, String> {
    let schedule = load_schedule(connection, schedule_id)?;
    if !schedule.enabled || schedule.consumed_at.is_some() {
        return Ok(Vec::new());
    }

    let TaskScheduleTrigger::Event(trigger) = &schedule.trigger else {
        return Ok(Vec::new());
    };

    let events = matching_domain_events(connection, &schedule, trigger)?;
    let mut materialized_task_ids = Vec::new();
    for event in events {
        let occurrence_key = format!("event:{}", event.id);
        let occurrence = get_or_create_occurrence(
            connection,
            &schedule.id,
            &occurrence_key,
            Some(event.created_at.clone()),
            Some(event.id.clone()),
        )?;
        if matches!(
            occurrence.status.as_str(),
            OCCURRENCE_MATERIALIZED | OCCURRENCE_SKIPPED
        ) {
            continue;
        }

        match materialize_occurrence(connection, &schedule, &occurrence, Some(&event))? {
            MaterializationOutcome::Materialized(task_id) => {
                mark_schedule_fired(
                    connection,
                    &schedule.id,
                    Some(&task_id),
                    None,
                    schedule.one_shot,
                    now,
                )?;
                materialized_task_ids.push(task_id);
                if schedule.one_shot {
                    break;
                }
            }
            MaterializationOutcome::Skipped(reason) => {
                mark_occurrence(
                    connection,
                    &occurrence.id,
                    OCCURRENCE_SKIPPED,
                    None,
                    Some(&reason),
                )?;
                mark_schedule_fired(
                    connection,
                    &schedule.id,
                    None,
                    Some(&reason),
                    schedule.one_shot,
                    now,
                )?;
                if schedule.one_shot {
                    break;
                }
            }
            MaterializationOutcome::Failed(error) => {
                mark_occurrence(
                    connection,
                    &occurrence.id,
                    OCCURRENCE_FAILED,
                    None,
                    Some(&error),
                )?;
                update_schedule_error(connection, &schedule.id, &error)?;
            }
        }
    }

    Ok(materialized_task_ids)
}

enum MaterializationOutcome {
    Materialized(String),
    Skipped(String),
    Failed(String),
}

fn materialize_occurrence(
    connection: &mut Connection,
    schedule: &PersistedTaskSchedule,
    occurrence: &TaskScheduleOccurrence,
    _event: Option<&DomainEvent>,
) -> Result<MaterializationOutcome, String> {
    if schedule.overlap_policy == OVERLAP_SKIP
        && schedule_has_open_materialized_task(connection, &schedule.id)?
    {
        mark_occurrence(
            connection,
            &occurrence.id,
            OCCURRENCE_SKIPPED,
            None,
            Some("Skipped because a previous scheduled task instance is still open."),
        )?;
        return Ok(MaterializationOutcome::Skipped(
            "Skipped because a previous scheduled task instance is still open.".into(),
        ));
    }

    match tasks::create_task_from_blueprint(
        connection,
        &schedule.project_id,
        schedule.task_blueprint.clone(),
        Some(&schedule.id),
        Some(&occurrence.id),
    ) {
        Ok(task) => {
            mark_occurrence(
                connection,
                &occurrence.id,
                OCCURRENCE_MATERIALIZED,
                Some(&task.id),
                None,
            )?;
            let _ = domain_events::record_event(
                connection,
                domain_events::DomainEventInput {
                    project_id: Some(task.project_id.clone()),
                    topic: "task.created".into(),
                    entity_type: "task".into(),
                    entity_id: Some(task.id.clone()),
                    payload: json!({
                        "taskId": task.id.clone(),
                        "taskNumber": task.number.clone(),
                        "status": task.status.clone(),
                        "workflowId": task.workflow_id.clone(),
                        "laneId": task.current_lane_id.clone(),
                        "sourceScheduleId": schedule.id.clone(),
                        "sourceScheduleOccurrenceId": occurrence.id.clone(),
                    }),
                },
            );
            Ok(MaterializationOutcome::Materialized(task.id))
        }
        Err(error) => Ok(MaterializationOutcome::Failed(error)),
    }
}

fn mark_schedule_fired(
    connection: &Connection,
    schedule_id: &str,
    task_id: Option<&str>,
    error: Option<&str>,
    one_shot: bool,
    fired_at: chrono::DateTime<Utc>,
) -> Result<(), String> {
    let fired_at_iso = fired_at.to_rfc3339();
    let consumed_at = if one_shot {
        Some(fired_at_iso.clone())
    } else {
        None
    };
    connection
        .execute(
            r#"
            UPDATE task_schedules
            SET last_fired_at = ?2,
                last_materialized_task_id = COALESCE(?3, last_materialized_task_id),
                last_error = ?4,
                consumed_at = COALESCE(?5, consumed_at),
                enabled = CASE WHEN ?6 = 1 THEN 0 ELSE enabled END,
                updated_at = ?2
            WHERE id = ?1
            "#,
            params![
                schedule_id,
                fired_at_iso,
                task_id,
                error,
                consumed_at,
                if one_shot { 1 } else { 0 },
            ],
        )
        .map_err(|error| format!("Unable to mark task schedule {schedule_id} as fired: {error}"))?;
    Ok(())
}

fn update_schedule_post_time_trigger(
    connection: &Connection,
    schedule: &PersistedTaskSchedule,
    now: chrono::DateTime<Utc>,
    task_id: Option<&str>,
    error: Option<&str>,
    skipped: bool,
) -> Result<(), String> {
    let single_fire = schedule.one_shot
        || matches!(
            schedule.trigger,
            TaskScheduleTrigger::Time(TaskScheduleTimeTrigger::Once { .. })
        );
    let next_fire_at = if single_fire {
        None
    } else {
        next_time_fire_at(&schedule.trigger, now)?.map(|value| value.to_rfc3339())
    };
    let fired_at_iso = now.to_rfc3339();
    connection
        .execute(
            r#"
            UPDATE task_schedules
            SET next_fire_at = ?2,
                last_fired_at = ?3,
                last_materialized_task_id = CASE WHEN ?4 IS NULL THEN last_materialized_task_id ELSE ?4 END,
                last_error = ?5,
                consumed_at = CASE WHEN ?6 = 1 THEN ?3 ELSE consumed_at END,
                enabled = CASE WHEN ?6 = 1 THEN 0 ELSE enabled END,
                updated_at = ?3
            WHERE id = ?1
            "#,
            params![
                schedule.id,
                next_fire_at,
                fired_at_iso,
                task_id,
                if skipped { error } else { None },
                if single_fire { 1 } else { 0 },
            ],
        )
        .map_err(|error| format!("Unable to update time-based task schedule {}: {error}", schedule.id))?;
    Ok(())
}

fn update_schedule_error(
    connection: &Connection,
    schedule_id: &str,
    error: &str,
) -> Result<(), String> {
    connection
        .execute(
            "UPDATE task_schedules SET last_error = ?2 WHERE id = ?1",
            params![schedule_id, error],
        )
        .map_err(|db_error| {
            format!("Unable to update task schedule {schedule_id} failure state: {db_error}")
        })?;
    Ok(())
}

fn list_due_time_schedule_ids(
    connection: &Connection,
    now: chrono::DateTime<Utc>,
) -> Result<Vec<String>, String> {
    let now_iso = now.to_rfc3339();
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM task_schedules
            WHERE trigger_type = 'time'
              AND enabled = 1
              AND consumed_at IS NULL
              AND next_fire_at IS NOT NULL
              AND next_fire_at <= ?1
            ORDER BY next_fire_at ASC, created_at ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare due time schedules query: {error}"))?;
    let rows = statement
        .query_map([now_iso], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query due time schedules: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read due time schedules: {error}"))
}

fn list_enabled_event_schedule_ids(connection: &Connection) -> Result<Vec<String>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id
            FROM task_schedules
            WHERE trigger_type = 'event'
              AND enabled = 1
              AND consumed_at IS NULL
            ORDER BY created_at ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare event schedules query: {error}"))?;
    let rows = statement
        .query_map([], |row| row.get::<_, String>(0))
        .map_err(|error| format!("Unable to query event schedules: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read event schedules: {error}"))
}

fn matching_domain_events(
    connection: &Connection,
    schedule: &PersistedTaskSchedule,
    trigger: &TaskScheduleEventTrigger,
) -> Result<Vec<DomainEvent>, String> {
    let existing_occurrence_event_ids =
        list_schedule_occurrence_event_ids(connection, &schedule.id)?;
    let events = domain_events::list_events(connection)?;
    let minimum_created_at = parse_rfc3339_timestamp(&schedule.updated_at)?;
    Ok(events
        .into_iter()
        .filter(|event| event.topic == trigger.event_key)
        .filter(|event| match event.project_id.as_deref() {
            Some(project_id) => project_id == schedule.project_id,
            None => true,
        })
        .filter(|event| !existing_occurrence_event_ids.contains(event.id.as_str()))
        .filter(|event| {
            parse_rfc3339_timestamp(&event.created_at)
                .map(|timestamp| timestamp > minimum_created_at)
                .unwrap_or(false)
        })
        .filter(|event| !event_originated_from_any_schedule(event))
        .collect())
}

fn event_originated_from_any_schedule(event: &DomainEvent) -> bool {
    event
        .payload
        .get("sourceScheduleId")
        .and_then(Value::as_str)
        .map(|value| !value.trim().is_empty())
        .unwrap_or(false)
}

fn parse_rfc3339_timestamp(value: &str) -> Result<DateTime<Utc>, String> {
    DateTime::parse_from_rfc3339(value)
        .map(|timestamp| timestamp.with_timezone(&Utc))
        .map_err(|error| format!("Unable to parse RFC3339 timestamp {value:?}: {error}"))
}

fn list_schedule_occurrence_event_ids(
    connection: &Connection,
    schedule_id: &str,
) -> Result<std::collections::HashSet<String>, String> {
    let mut statement = connection
        .prepare(
            "SELECT event_id FROM task_schedule_occurrences WHERE schedule_id = ?1 AND event_id IS NOT NULL AND status IN ('materialized', 'skipped')",
        )
        .map_err(|error| {
            format!(
                "Unable to prepare task schedule occurrence event query for {schedule_id}: {error}"
            )
        })?;
    let rows = statement
        .query_map([schedule_id], |row| row.get::<_, String>(0))
        .map_err(|error| {
            format!("Unable to query task schedule occurrence events for {schedule_id}: {error}")
        })?;
    rows.collect::<Result<std::collections::HashSet<_>, _>>()
        .map_err(|error| {
            format!("Unable to read task schedule occurrence events for {schedule_id}: {error}")
        })
}

fn get_or_create_occurrence(
    connection: &Connection,
    schedule_id: &str,
    occurrence_key: &str,
    scheduled_at: Option<String>,
    event_id: Option<String>,
) -> Result<TaskScheduleOccurrence, String> {
    if let Some(existing) = load_schedule_occurrence(connection, schedule_id, occurrence_key)? {
        return Ok(existing);
    }

    let occurrence = TaskScheduleOccurrence {
        id: generate_id("task-schedule-occurrence"),
        schedule_id: schedule_id.to_string(),
        occurrence_key: occurrence_key.to_string(),
        scheduled_at,
        event_id,
        status: OCCURRENCE_PENDING.to_string(),
        task_id: None,
        error: None,
        created_at: now_iso(),
        updated_at: now_iso(),
    };

    connection
        .execute(
            r#"
            INSERT INTO task_schedule_occurrences (
                id,
                schedule_id,
                occurrence_key,
                scheduled_at,
                event_id,
                status,
                task_id,
                error,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, ?7, ?8)
            "#,
            params![
                occurrence.id,
                occurrence.schedule_id,
                occurrence.occurrence_key,
                occurrence.scheduled_at,
                occurrence.event_id,
                occurrence.status,
                occurrence.created_at,
                occurrence.updated_at,
            ],
        )
        .map_err(|error| {
            format!(
                "Unable to create occurrence {occurrence_key} for task schedule {schedule_id}: {error}"
            )
        })?;

    load_schedule_occurrence(connection, schedule_id, occurrence_key)?.ok_or_else(|| {
        format!(
            "Task schedule occurrence {occurrence_key} for schedule {schedule_id} was not found after creation"
        )
    })
}

fn load_schedule_occurrence(
    connection: &Connection,
    schedule_id: &str,
    occurrence_key: &str,
) -> Result<Option<TaskScheduleOccurrence>, String> {
    connection
        .query_row(
            r#"
            SELECT id, schedule_id, occurrence_key, scheduled_at, event_id, status, task_id, error, created_at, updated_at
            FROM task_schedule_occurrences
            WHERE schedule_id = ?1 AND occurrence_key = ?2
            "#,
            params![schedule_id, occurrence_key],
            read_occurrence_row,
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to load occurrence {occurrence_key} for task schedule {schedule_id}: {error}"
            )
        })
}

fn mark_occurrence(
    connection: &Connection,
    occurrence_id: &str,
    status: &str,
    task_id: Option<&str>,
    error: Option<&str>,
) -> Result<(), String> {
    connection
        .execute(
            r#"
            UPDATE task_schedule_occurrences
            SET status = ?2,
                task_id = ?3,
                error = ?4,
                updated_at = ?5
            WHERE id = ?1
            "#,
            params![occurrence_id, status, task_id, error, now_iso()],
        )
        .map_err(|db_error| {
            format!("Unable to update task schedule occurrence {occurrence_id}: {db_error}")
        })?;
    Ok(())
}

fn schedule_has_open_materialized_task(
    connection: &Connection,
    schedule_id: &str,
) -> Result<bool, String> {
    let count = connection
        .query_row(
            "SELECT COUNT(*) FROM tasks WHERE source_schedule_id = ?1 AND status NOT IN ('completed', 'canceled')",
            [schedule_id],
            |row| row.get::<_, i64>(0),
        )
        .map_err(|error| {
            format!("Unable to query open materialized tasks for task schedule {schedule_id}: {error}")
        })?;
    Ok(count > 0)
}

fn load_schedule(
    connection: &Connection,
    schedule_id: &str,
) -> Result<PersistedTaskSchedule, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                project_id,
                title,
                description,
                task_type,
                priority,
                workflow_id,
                task_blueprint_json,
                trigger_json,
                enabled,
                one_shot,
                overlap_policy,
                next_fire_at,
                last_fired_at,
                last_materialized_task_id,
                last_error,
                consumed_at,
                created_at,
                updated_at,
                COALESCE((SELECT COUNT(*) FROM tasks WHERE source_schedule_id = task_schedules.id), 0) AS materialized_task_count,
                COALESCE((SELECT COUNT(*) FROM tasks WHERE source_schedule_id = task_schedules.id AND status NOT IN ('completed', 'canceled')), 0) AS open_materialized_task_count
            FROM task_schedules
            WHERE id = ?1
            "#,
            [schedule_id],
            read_schedule_row,
        )
        .map_err(|error| format!("Unable to load task schedule {schedule_id}: {error}"))
}

fn list_schedule_occurrences(
    connection: &Connection,
    schedule_id: &str,
    limit: usize,
) -> Result<Vec<TaskScheduleOccurrence>, String> {
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, schedule_id, occurrence_key, scheduled_at, event_id, status, task_id, error, created_at, updated_at
            FROM task_schedule_occurrences
            WHERE schedule_id = ?1
            ORDER BY created_at DESC, id DESC
            LIMIT ?2
            "#,
        )
        .map_err(|error| {
            format!("Unable to prepare task schedule occurrences query for {schedule_id}: {error}")
        })?;
    let rows = statement
        .query_map(params![schedule_id, limit as i64], read_occurrence_row)
        .map_err(|error| {
            format!("Unable to query task schedule occurrences for {schedule_id}: {error}")
        })?;
    rows.collect::<Result<Vec<_>, _>>().map_err(|error| {
        format!("Unable to read task schedule occurrences for {schedule_id}: {error}")
    })
}

struct PreparedTaskScheduleInput {
    title: String,
    description: Option<String>,
    task_type: String,
    priority: String,
    workflow_id: Option<String>,
    task_blueprint_json: String,
    trigger_type: String,
    trigger_json: String,
    enabled: bool,
    one_shot: bool,
    overlap_policy: String,
    next_fire_at: Option<String>,
}

fn prepare_schedule_input(
    connection: &Connection,
    project_id: &str,
    mut input: TaskScheduleUpsertInput,
) -> Result<PreparedTaskScheduleInput, String> {
    validate_overlap_policy(&input.overlap_policy)?;
    input.task.status = "ready".into();
    input.task.archived = Some(false);

    let task_blueprint =
        tasks::prepare_task_input_for_project(connection, project_id, input.task, None)?;
    validate_trigger(&input.trigger)?;
    let task_blueprint_json = serde_json::to_string(&task_blueprint)
        .map_err(|error| format!("Unable to serialize task schedule blueprint: {error}"))?;
    let trigger_json = serde_json::to_string(&input.trigger)
        .map_err(|error| format!("Unable to serialize task schedule trigger: {error}"))?;
    let next_fire_at =
        next_time_fire_at(&input.trigger, Utc::now())?.map(|value| value.to_rfc3339());

    Ok(PreparedTaskScheduleInput {
        title: task_blueprint.title.clone(),
        description: task_blueprint.description.clone(),
        task_type: task_blueprint.task_type.clone(),
        priority: task_blueprint.priority.clone(),
        workflow_id: task_blueprint.workflow_id.clone(),
        task_blueprint_json,
        trigger_type: trigger_type_name(&input.trigger).into(),
        trigger_json,
        enabled: input.enabled.unwrap_or(true),
        one_shot: input.one_shot,
        overlap_policy: input.overlap_policy,
        next_fire_at,
    })
}

fn validate_overlap_policy(value: &str) -> Result<(), String> {
    match value.trim() {
        OVERLAP_SKIP | OVERLAP_CREATE_ANOTHER => Ok(()),
        _ => Err("overlapPolicy: Expected skip or create_another.".into()),
    }
}

fn validate_trigger(trigger: &TaskScheduleTrigger) -> Result<(), String> {
    match trigger {
        TaskScheduleTrigger::Time(time_trigger) => validate_time_trigger(time_trigger),
        TaskScheduleTrigger::Event(event_trigger) => {
            if event_trigger.event_key.trim().is_empty() {
                return Err("trigger.eventKey: Event trigger key is required.".into());
            }
            Ok(())
        }
    }
}

fn validate_time_trigger(trigger: &TaskScheduleTimeTrigger) -> Result<(), String> {
    match trigger {
        TaskScheduleTimeTrigger::Once { at, timezone } => {
            parse_timezone(timezone)?;
            chrono::DateTime::parse_from_rfc3339(at)
                .map_err(|error| format!("trigger.at: Expected an RFC3339 datetime: {error}"))?;
            Ok(())
        }
        TaskScheduleTimeTrigger::EveryMinutes { every_minutes } => {
            if *every_minutes < 1 {
                return Err("trigger.everyMinutes: Must be at least 1 minute.".into());
            }
            Ok(())
        }
        TaskScheduleTimeTrigger::Daily {
            time_of_day,
            timezone,
        } => {
            parse_time_of_day(time_of_day)?;
            parse_timezone(timezone)?;
            Ok(())
        }
        TaskScheduleTimeTrigger::Weekly {
            time_of_day,
            timezone,
            days_of_week,
        } => {
            parse_time_of_day(time_of_day)?;
            parse_timezone(timezone)?;
            if days_of_week.is_empty() || days_of_week.iter().any(|day| *day > 6) {
                return Err("trigger.daysOfWeek: Expected one or more days between 0 (Sunday) and 6 (Saturday).".into());
            }
            Ok(())
        }
        TaskScheduleTimeTrigger::Monthly {
            time_of_day,
            timezone,
            day_of_month,
        } => {
            parse_time_of_day(time_of_day)?;
            parse_timezone(timezone)?;
            if *day_of_month < 1 || *day_of_month > 31 {
                return Err("trigger.dayOfMonth: Expected a day between 1 and 31.".into());
            }
            Ok(())
        }
    }
}

fn trigger_type_name(trigger: &TaskScheduleTrigger) -> &'static str {
    match trigger {
        TaskScheduleTrigger::Time(_) => "time",
        TaskScheduleTrigger::Event(_) => "event",
    }
}

fn next_time_fire_at(
    trigger: &TaskScheduleTrigger,
    now: chrono::DateTime<Utc>,
) -> Result<Option<chrono::DateTime<Utc>>, String> {
    match trigger {
        TaskScheduleTrigger::Event(_) => Ok(None),
        TaskScheduleTrigger::Time(time_trigger) => {
            next_time_fire_at_for_trigger(time_trigger, now).map(Some)
        }
    }
}

fn next_time_fire_at_for_trigger(
    trigger: &TaskScheduleTimeTrigger,
    now: chrono::DateTime<Utc>,
) -> Result<chrono::DateTime<Utc>, String> {
    match trigger {
        TaskScheduleTimeTrigger::Once { at, .. } => chrono::DateTime::parse_from_rfc3339(at)
            .map(|value| value.with_timezone(&Utc))
            .map_err(|error| format!("trigger.at: Expected an RFC3339 datetime: {error}")),
        TaskScheduleTimeTrigger::EveryMinutes { every_minutes } => {
            Ok(now + Duration::minutes(*every_minutes))
        }
        TaskScheduleTimeTrigger::Daily {
            time_of_day,
            timezone,
        } => {
            let tz = parse_timezone(timezone)?;
            let time = parse_time_of_day(time_of_day)?;
            next_daily_fire_at(tz, time, now)
        }
        TaskScheduleTimeTrigger::Weekly {
            time_of_day,
            timezone,
            days_of_week,
        } => {
            let tz = parse_timezone(timezone)?;
            let time = parse_time_of_day(time_of_day)?;
            next_weekly_fire_at(tz, time, days_of_week, now)
        }
        TaskScheduleTimeTrigger::Monthly {
            time_of_day,
            timezone,
            day_of_month,
        } => {
            let tz = parse_timezone(timezone)?;
            let time = parse_time_of_day(time_of_day)?;
            next_monthly_fire_at(tz, time, *day_of_month, now)
        }
    }
}

fn next_daily_fire_at(
    tz: Tz,
    time: NaiveTime,
    now: chrono::DateTime<Utc>,
) -> Result<chrono::DateTime<Utc>, String> {
    let now_local = now.with_timezone(&tz);
    for offset_days in 0..=7 {
        let candidate_date = now_local.date_naive() + Duration::days(offset_days);
        let candidate = resolve_local_datetime(tz, candidate_date.and_time(time))?;
        if candidate > now_local {
            return Ok(candidate.with_timezone(&Utc));
        }
    }
    Err("Unable to calculate the next daily fire time.".into())
}

fn next_weekly_fire_at(
    tz: Tz,
    time: NaiveTime,
    days_of_week: &[u32],
    now: chrono::DateTime<Utc>,
) -> Result<chrono::DateTime<Utc>, String> {
    let now_local = now.with_timezone(&tz);
    for offset_days in 0..=14 {
        let candidate_date = now_local.date_naive() + Duration::days(offset_days);
        let weekday = candidate_date.weekday().num_days_from_sunday();
        if !days_of_week.contains(&weekday) {
            continue;
        }
        let candidate = resolve_local_datetime(tz, candidate_date.and_time(time))?;
        if candidate > now_local {
            return Ok(candidate.with_timezone(&Utc));
        }
    }
    Err("Unable to calculate the next weekly fire time.".into())
}

fn next_monthly_fire_at(
    tz: Tz,
    time: NaiveTime,
    day_of_month: u32,
    now: chrono::DateTime<Utc>,
) -> Result<chrono::DateTime<Utc>, String> {
    let now_local = now.with_timezone(&tz);
    for offset_months in 0..=24 {
        let (year, month) = add_months(now_local.year(), now_local.month(), offset_months)?;
        let day = day_of_month.min(days_in_month(year, month)?);
        let date = NaiveDate::from_ymd_opt(year, month, day).ok_or_else(|| {
            format!("Unable to build monthly schedule date for {year}-{month}-{day}")
        })?;
        let candidate = resolve_local_datetime(tz, date.and_time(time))?;
        if candidate > now_local {
            return Ok(candidate.with_timezone(&Utc));
        }
    }
    Err("Unable to calculate the next monthly fire time.".into())
}

fn add_months(year: i32, month: u32, months_to_add: u32) -> Result<(i32, u32), String> {
    let total_months = (year as i64) * 12 + (month as i64 - 1) + months_to_add as i64;
    let next_year = (total_months / 12) as i32;
    let next_month = (total_months % 12 + 1) as u32;
    Ok((next_year, next_month))
}

fn days_in_month(year: i32, month: u32) -> Result<u32, String> {
    let next_month = if month == 12 {
        NaiveDate::from_ymd_opt(year + 1, 1, 1)
    } else {
        NaiveDate::from_ymd_opt(year, month + 1, 1)
    }
    .ok_or_else(|| format!("Unable to calculate days in month for {year}-{month}"))?;
    Ok((next_month - Duration::days(1)).day())
}

fn resolve_local_datetime(tz: Tz, naive: NaiveDateTime) -> Result<chrono::DateTime<Tz>, String> {
    match tz.from_local_datetime(&naive) {
        LocalResult::Single(datetime) => Ok(datetime),
        LocalResult::Ambiguous(first, _) => Ok(first),
        LocalResult::None => {
            for minute_offset in 1..=180 {
                let shifted = naive + Duration::minutes(minute_offset);
                match tz.from_local_datetime(&shifted) {
                    LocalResult::Single(datetime) => return Ok(datetime),
                    LocalResult::Ambiguous(first, _) => return Ok(first),
                    LocalResult::None => continue,
                }
            }
            Err(format!(
                "Unable to resolve local datetime {naive} in timezone {tz}"
            ))
        }
    }
}

fn parse_timezone(value: &str) -> Result<Tz, String> {
    value
        .trim()
        .parse::<Tz>()
        .map_err(|error| format!("trigger.timezone: Unknown timezone {value:?}: {error}"))
}

fn parse_time_of_day(value: &str) -> Result<NaiveTime, String> {
    NaiveTime::parse_from_str(value.trim(), "%H:%M")
        .map_err(|error| format!("trigger.timeOfDay: Expected HH:MM time: {error}"))
}

fn read_schedule_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<PersistedTaskSchedule> {
    let task_blueprint_json = row.get::<_, String>(7)?;
    let trigger_json = row.get::<_, String>(8)?;
    let task_blueprint =
        serde_json::from_str::<TaskUpsertInput>(&task_blueprint_json).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Text,
                Box::new(error),
            )
        })?;
    let trigger = serde_json::from_str::<TaskScheduleTrigger>(&trigger_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(8, rusqlite::types::Type::Text, Box::new(error))
    })?;
    Ok(PersistedTaskSchedule {
        id: row.get(0)?,
        project_id: row.get(1)?,
        title: row.get(2)?,
        description: row.get(3)?,
        task_type: row.get(4)?,
        priority: row.get(5)?,
        workflow_id: row.get(6)?,
        task_blueprint,
        trigger,
        enabled: row.get::<_, i64>(9)? != 0,
        one_shot: row.get::<_, i64>(10)? != 0,
        overlap_policy: row.get(11)?,
        next_fire_at: row.get(12)?,
        last_fired_at: row.get(13)?,
        last_materialized_task_id: row.get(14)?,
        last_error: row.get(15)?,
        consumed_at: row.get(16)?,
        created_at: row.get(17)?,
        updated_at: row.get(18)?,
        materialized_task_count: row.get(19)?,
        open_materialized_task_count: row.get(20)?,
    })
}

fn read_occurrence_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<TaskScheduleOccurrence> {
    Ok(TaskScheduleOccurrence {
        id: row.get(0)?,
        schedule_id: row.get(1)?,
        occurrence_key: row.get(2)?,
        scheduled_at: row.get(3)?,
        event_id: row.get(4)?,
        status: row.get(5)?,
        task_id: row.get(6)?,
        error: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

fn to_summary(schedule: PersistedTaskSchedule) -> TaskScheduleSummary {
    TaskScheduleSummary {
        id: schedule.id,
        project_id: schedule.project_id,
        title: schedule.title,
        description: schedule.description,
        task_type: schedule.task_type,
        priority: schedule.priority,
        workflow_id: schedule.workflow_id,
        repository_ids: schedule.task_blueprint.repository_ids.clone(),
        enabled: schedule.enabled,
        one_shot: schedule.one_shot,
        overlap_policy: schedule.overlap_policy,
        trigger: schedule.trigger,
        next_fire_at: schedule.next_fire_at,
        last_fired_at: schedule.last_fired_at,
        last_materialized_task_id: schedule.last_materialized_task_id,
        last_error: schedule.last_error,
        materialized_task_count: schedule.materialized_task_count,
        open_materialized_task_count: schedule.open_materialized_task_count,
        created_at: schedule.created_at,
        updated_at: schedule.updated_at,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::services::database::apply_migrations;
    use serde_json::json;

    fn setup() -> Connection {
        let connection = Connection::open_in_memory().expect("in-memory database should open");
        apply_migrations(&connection).expect("migrations should apply");
        connection
            .execute(
                "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-1', 'project-1', 'Project 1', NULL, 'P1', NULL, ?1, ?1)",
                [now_iso()],
            )
            .expect("project should insert");
        connection
    }

    fn sample_task_input() -> TaskUpsertInput {
        TaskUpsertInput {
            title: "Scheduled task".into(),
            description: Some("Do the thing".into()),
            task_type: "task".into(),
            tags: Vec::new(),
            status: "draft".into(),
            priority: "P2".into(),
            workflow_id: None,
            current_lane_id: None,
            assignee_type: "unassigned".into(),
            assignee_id: None,
            repository_id: None,
            repository_ids: Vec::new(),
            parent_task_id: None,
            whip_max_attempts: Some(10),
            archived: Some(false),
        }
    }

    #[test]
    fn deserializes_legacy_task_blueprint_without_tags() {
        let input = serde_json::from_value::<TaskUpsertInput>(json!({
            "title": "Legacy scheduled task",
            "description": "Do the thing",
            "type": "task",
            "status": "draft",
            "priority": "P2",
            "workflowId": null,
            "currentLaneId": null,
            "assigneeType": "unassigned",
            "assigneeId": null,
            "repositoryId": null,
            "repositoryIds": [],
            "parentTaskId": null,
            "whipMaxAttempts": 10,
            "archived": false
        }))
        .expect("legacy task blueprint should deserialize");

        assert!(input.tags.is_empty());
    }

    #[test]
    fn creates_and_lists_time_based_schedules() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_SKIP.into(),
                trigger: TaskScheduleTrigger::Time(TaskScheduleTimeTrigger::EveryMinutes {
                    every_minutes: 15,
                }),
            },
        )
        .expect("schedule should create");

        assert_eq!(created.title, "Scheduled task");
        assert!(created.next_fire_at.is_some());

        let listed = list_task_schedules(&connection, "project-1").expect("schedules should list");
        assert_eq!(listed.len(), 1);
        assert_eq!(listed[0].id, created.id);
    }

    #[test]
    fn time_based_schedules_materialize_fresh_tasks() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                trigger: TaskScheduleTrigger::Time(TaskScheduleTimeTrigger::Once {
                    at: (Utc::now() - Duration::minutes(1)).to_rfc3339(),
                    timezone: "UTC".into(),
                }),
            },
        )
        .expect("schedule should create");

        let result = process_due_task_schedules(&mut connection).expect("schedules should process");
        assert_eq!(result.materialized_task_ids.len(), 1);
        let task = tasks::get_task(&connection, &result.materialized_task_ids[0])
            .expect("materialized task should load");
        assert_eq!(task.title, created.title);
    }

    #[test]
    fn overlap_skip_records_skipped_occurrence() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_SKIP.into(),
                trigger: TaskScheduleTrigger::Time(TaskScheduleTimeTrigger::EveryMinutes {
                    every_minutes: 1,
                }),
            },
        )
        .expect("schedule should create");

        let _ = tasks::create_task_from_blueprint(
            &mut connection,
            "project-1",
            sample_task_input(),
            Some(&created.id),
            Some("occ-existing"),
        )
        .expect("existing materialized task should create");

        connection
            .execute(
                "UPDATE task_schedules SET next_fire_at = ?2 WHERE id = ?1",
                params![created.id, (Utc::now() - Duration::minutes(1)).to_rfc3339()],
            )
            .expect("schedule should become due");

        let result = process_due_task_schedules(&mut connection).expect("schedules should process");
        assert!(result.materialized_task_ids.is_empty());

        let occurrences = list_schedule_occurrences(&connection, &created.id, 10)
            .expect("occurrences should list");
        assert!(occurrences
            .iter()
            .any(|occurrence| occurrence.status == OCCURRENCE_SKIPPED));
    }

    #[test]
    fn event_schedules_materialize_tasks_from_matching_domain_events() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                trigger: TaskScheduleTrigger::Event(TaskScheduleEventTrigger {
                    event_key: "task.created".into(),
                }),
            },
        )
        .expect("schedule should create");

        domain_events::record_event(
            &connection,
            domain_events::DomainEventInput {
                project_id: Some("project-1".into()),
                topic: "task.created".into(),
                entity_type: "task".into(),
                entity_id: Some("task-upstream".into()),
                payload: json!({ "taskId": "task-upstream" }),
            },
        )
        .expect("domain event should record");

        let result =
            process_due_task_schedules(&mut connection).expect("event schedules should process");
        assert_eq!(result.materialized_task_ids.len(), 1);
        let occurrences = list_schedule_occurrences(&connection, &created.id, 10)
            .expect("occurrences should list");
        assert!(occurrences
            .iter()
            .any(|occurrence| occurrence.status == OCCURRENCE_MATERIALIZED));
    }

    #[test]
    fn event_schedules_ignore_historical_events_before_schedule_creation() {
        let mut connection = setup();
        let historical_event = domain_events::record_event(
            &connection,
            domain_events::DomainEventInput {
                project_id: Some("project-1".into()),
                topic: "task.created".into(),
                entity_type: "task".into(),
                entity_id: Some("task-old".into()),
                payload: json!({ "taskId": "task-old" }),
            },
        )
        .expect("historical event should record");
        std::thread::sleep(std::time::Duration::from_millis(5));

        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                trigger: TaskScheduleTrigger::Event(TaskScheduleEventTrigger {
                    event_key: "task.created".into(),
                }),
            },
        )
        .expect("schedule should create");

        let result =
            process_due_task_schedules(&mut connection).expect("event schedules should process");
        assert!(result.materialized_task_ids.is_empty());
        let occurrences = list_schedule_occurrences(&connection, &created.id, 10)
            .expect("occurrences should list");
        assert!(occurrences.is_empty());
        assert_eq!(historical_event.topic, "task.created");
    }

    #[test]
    fn schedule_materialization_emits_task_created_domain_events_with_source_metadata() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                trigger: TaskScheduleTrigger::Time(TaskScheduleTimeTrigger::Once {
                    at: (Utc::now() - Duration::minutes(1)).to_rfc3339(),
                    timezone: "UTC".into(),
                }),
            },
        )
        .expect("schedule should create");

        let result = process_due_task_schedules(&mut connection).expect("schedules should process");
        assert_eq!(result.materialized_task_ids.len(), 1);
        let events = domain_events::list_events(&connection).expect("domain events should list");
        let materialized_event = events
            .iter()
            .rev()
            .find(|event| {
                event.topic == "task.created"
                    && event
                        .payload
                        .get("sourceScheduleId")
                        .and_then(Value::as_str)
                        == Some(created.id.as_str())
            })
            .expect("materialized task should emit task.created with sourceScheduleId");
        assert_eq!(
            materialized_event
                .payload
                .get("sourceScheduleOccurrenceId")
                .and_then(Value::as_str)
                .is_some(),
            true
        );
    }

    #[test]
    fn event_schedule_retries_failed_occurrences_after_schedule_is_fixed() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                trigger: TaskScheduleTrigger::Event(TaskScheduleEventTrigger {
                    event_key: "task.created".into(),
                }),
            },
        )
        .expect("schedule should create");

        connection
            .execute(
                "UPDATE task_schedules SET task_blueprint_json = ?2, updated_at = created_at WHERE id = ?1",
                params![
                    created.id,
                    serde_json::to_string(&TaskUpsertInput {
                        workflow_id: Some("missing-workflow".into()),
                        ..sample_task_input()
                    })
                    .expect("broken blueprint should serialize"),
                ],
            )
            .expect("schedule blueprint should become invalid");

        domain_events::record_event(
            &connection,
            domain_events::DomainEventInput {
                project_id: Some("project-1".into()),
                topic: "task.created".into(),
                entity_type: "task".into(),
                entity_id: Some("task-trigger".into()),
                payload: json!({ "taskId": "task-trigger" }),
            },
        )
        .expect("domain event should record");

        let first_result =
            process_due_task_schedules(&mut connection).expect("first processing should run");
        assert!(first_result.materialized_task_ids.is_empty());
        let failed_occurrences = list_schedule_occurrences(&connection, &created.id, 10)
            .expect("failed occurrences should list");
        assert!(failed_occurrences
            .iter()
            .any(|occurrence| occurrence.status == OCCURRENCE_FAILED));

        connection
            .execute(
                "UPDATE task_schedules SET task_blueprint_json = ?2 WHERE id = ?1",
                params![
                    created.id,
                    serde_json::to_string(&sample_task_input())
                        .expect("fixed blueprint should serialize"),
                ],
            )
            .expect("schedule blueprint should be fixed");

        let retried = process_due_task_schedules(&mut connection)
            .expect("second processing should retry failed event occurrence");
        assert_eq!(retried.materialized_task_ids.len(), 1);
    }

    #[test]
    fn recurring_overdue_time_schedules_materialize_only_one_occurrence_per_tick() {
        let mut connection = setup();
        let created = create_task_schedule(
            &mut connection,
            "project-1",
            TaskScheduleUpsertInput {
                task: sample_task_input(),
                enabled: Some(true),
                one_shot: false,
                overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                trigger: TaskScheduleTrigger::Time(TaskScheduleTimeTrigger::EveryMinutes {
                    every_minutes: 5,
                }),
            },
        )
        .expect("schedule should create");

        connection
            .execute(
                "UPDATE task_schedules SET next_fire_at = ?2 WHERE id = ?1",
                params![created.id, (Utc::now() - Duration::hours(6)).to_rfc3339()],
            )
            .expect("schedule should become overdue");

        let result = process_due_task_schedules(&mut connection)
            .expect("overdue recurring schedule should process");
        assert_eq!(result.materialized_task_ids.len(), 1);
        let occurrences = list_schedule_occurrences(&connection, &created.id, 10)
            .expect("occurrences should list");
        assert_eq!(occurrences.len(), 1);
    }

    #[test]
    fn event_schedules_ignore_task_created_events_emitted_by_other_schedules() {
        let mut connection = setup();
        for _ in 0..2 {
            create_task_schedule(
                &mut connection,
                "project-1",
                TaskScheduleUpsertInput {
                    task: sample_task_input(),
                    enabled: Some(true),
                    one_shot: false,
                    overlap_policy: OVERLAP_CREATE_ANOTHER.into(),
                    trigger: TaskScheduleTrigger::Event(TaskScheduleEventTrigger {
                        event_key: "task.created".into(),
                    }),
                },
            )
            .expect("schedule should create");
        }

        domain_events::record_event(
            &connection,
            domain_events::DomainEventInput {
                project_id: Some("project-1".into()),
                topic: "task.created".into(),
                entity_type: "task".into(),
                entity_id: Some("task-external".into()),
                payload: json!({ "taskId": "task-external" }),
            },
        )
        .expect("manual task.created event should record");

        let first_pass = process_due_task_schedules(&mut connection)
            .expect("first pass should process external event");
        assert_eq!(first_pass.materialized_task_ids.len(), 2);

        let second_pass = process_due_task_schedules(&mut connection)
            .expect("second pass should ignore schedule-originated task.created events");
        assert!(second_pass.materialized_task_ids.is_empty());
    }
}
