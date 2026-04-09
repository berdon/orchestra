use serde_json::json;
use tauri::{AppHandle, State};

use crate::{
    models::{TaskScheduleDetail, TaskScheduleSummary, TaskScheduleUpsertInput},
    services::{app_events, database, domain_events, task_schedules},
    state::AppState,
};

fn emit_schedule_change(app: &AppHandle, reason: &str) {
    let _ = app_events::emit_task_change(app, reason.to_string(), Vec::<String>::new());
}

#[tauri::command]
pub fn list_task_schedules(project_id: Option<String>) -> Result<Vec<TaskScheduleSummary>, String> {
    let connection = database::open_connection()?;
    task_schedules::list_task_schedules(
        &connection,
        project_id.as_deref().unwrap_or("orchestra"),
    )
}

#[tauri::command]
pub fn get_task_schedule(schedule_id: String) -> Result<TaskScheduleDetail, String> {
    let connection = database::open_connection()?;
    task_schedules::get_task_schedule(&connection, &schedule_id)
}

#[tauri::command]
pub fn create_task_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    project_id: String,
    input: TaskScheduleUpsertInput,
) -> Result<TaskScheduleDetail, String> {
    let mut connection = database::open_connection()?;
    let schedule = task_schedules::create_task_schedule(&mut connection, &project_id, input)?;
    state.log(
        "info",
        "task.schedule.created",
        &format!("Created task schedule {}", schedule.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(schedule.project_id.clone()),
            topic: "task.schedule.created".into(),
            entity_type: "task_schedule".into(),
            entity_id: Some(schedule.id.clone()),
            payload: json!({
                "scheduleId": schedule.id.clone(),
                "title": schedule.title.clone(),
                "enabled": schedule.enabled,
                "triggerType": match &schedule.trigger {
                    crate::models::TaskScheduleTrigger::Time(_) => "time",
                    crate::models::TaskScheduleTrigger::Event(_) => "event",
                },
            }),
        },
    );
    emit_schedule_change(&app, "task.schedule.created");
    Ok(schedule)
}

#[tauri::command]
pub fn update_task_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule_id: String,
    input: TaskScheduleUpsertInput,
) -> Result<TaskScheduleDetail, String> {
    let mut connection = database::open_connection()?;
    let schedule = task_schedules::update_task_schedule(&mut connection, &schedule_id, input)?;
    state.log(
        "info",
        "task.schedule.updated",
        &format!("Updated task schedule {}", schedule.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(schedule.project_id.clone()),
            topic: "task.schedule.updated".into(),
            entity_type: "task_schedule".into(),
            entity_id: Some(schedule.id.clone()),
            payload: json!({
                "scheduleId": schedule.id.clone(),
                "title": schedule.title.clone(),
                "enabled": schedule.enabled,
                "triggerType": match &schedule.trigger {
                    crate::models::TaskScheduleTrigger::Time(_) => "time",
                    crate::models::TaskScheduleTrigger::Event(_) => "event",
                },
            }),
        },
    );
    emit_schedule_change(&app, "task.schedule.updated");
    Ok(schedule)
}

#[tauri::command]
pub fn delete_task_schedule(
    app: AppHandle,
    state: State<'_, AppState>,
    schedule_id: String,
) -> Result<TaskScheduleDetail, String> {
    let connection = database::open_connection()?;
    let schedule = task_schedules::delete_task_schedule(&connection, &schedule_id)?;
    state.log(
        "info",
        "task.schedule.deleted",
        &format!("Deleted task schedule {}", schedule.id),
    );
    let _ = domain_events::record_event(
        &connection,
        domain_events::DomainEventInput {
            project_id: Some(schedule.project_id.clone()),
            topic: "task.schedule.deleted".into(),
            entity_type: "task_schedule".into(),
            entity_id: Some(schedule.id.clone()),
            payload: json!({
                "scheduleId": schedule.id.clone(),
                "title": schedule.title.clone(),
            }),
        },
    );
    emit_schedule_change(&app, "task.schedule.deleted");
    Ok(schedule)
}
