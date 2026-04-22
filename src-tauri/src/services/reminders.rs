use std::path::PathBuf;

use chrono::{Duration, Utc};
use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use tauri::AppHandle;

use crate::{
    models::{AuthorizationContext, SendMailboxMessageInput},
    services::{
        agent_dispatch, agents, app_events, database, live_sessions, messages, pi_sessions,
        role_runtime, task_runtime,
    },
    state::{generate_id, now_iso, AppState},
};

const ACTOR_AGENT: &str = "agent";
const ACTOR_ROLE_INSTANCE: &str = "role_instance";
const DELIVERY_PROMPT: &str = "prompt";
const DELIVERY_STEER: &str = "steer";
const MAX_DELAY_SECONDS: i64 = 60 * 60 * 24 * 7;
const USER_FAILURE_SENDER: &str = "Orchestra reminder daemon";

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemindMeInput {
    pub message: String,
    #[serde(default)]
    pub delay_seconds: Option<i64>,
    #[serde(default)]
    pub delay_minutes: Option<i64>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct WorkerReminder {
    pub id: String,
    pub project_id: String,
    pub actor_type: String,
    pub actor_id: String,
    pub session_id: String,
    pub task_id: Option<String>,
    pub message: String,
    pub due_at: String,
    pub created_at: String,
    pub updated_at: String,
}

#[derive(Debug)]
enum ReminderDispatchOutcome {
    Delivered,
    Dropped(String),
}

pub fn schedule_reminder_for_authorization(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
    input: RemindMeInput,
) -> Result<WorkerReminder, String> {
    let authorization = authorization
        .ok_or_else(|| "remind_me requires a worker authorization context".to_string())?;
    if !matches!(
        authorization.actor_type.as_str(),
        ACTOR_AGENT | ACTOR_ROLE_INSTANCE
    ) {
        return Err(format!(
            "remind_me only supports agent and role instance sessions, not {}",
            authorization.actor_type
        ));
    }

    let message = input.message.trim();
    if message.is_empty() {
        return Err("message: Reminder message is required.".into());
    }

    let delay_seconds = normalize_delay_seconds(&input)?;
    let target = resolve_target_context(connection, authorization, session_id)?;
    let now = now_iso();
    let due_at = (Utc::now() + Duration::seconds(delay_seconds)).to_rfc3339();
    let reminder = WorkerReminder {
        id: generate_id("worker-reminder"),
        project_id: target.project_id,
        actor_type: authorization.actor_type.clone(),
        actor_id: authorization.actor_id.clone(),
        session_id: target.session_id,
        task_id: target.task_id,
        message: message.to_string(),
        due_at,
        created_at: now.clone(),
        updated_at: now,
    };

    connection
        .execute(
            r#"
            INSERT INTO worker_reminders (
                id,
                project_id,
                actor_type,
                actor_id,
                session_id,
                task_id,
                message,
                due_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
            "#,
            params![
                reminder.id,
                reminder.project_id,
                reminder.actor_type,
                reminder.actor_id,
                reminder.session_id,
                reminder.task_id,
                reminder.message,
                reminder.due_at,
                reminder.created_at,
                reminder.updated_at,
            ],
        )
        .map_err(|error| format!("Unable to store worker reminder: {error}"))?;

    get_worker_reminder(connection, &reminder.id)?.ok_or_else(|| {
        format!(
            "Worker reminder {} was not found after creation",
            reminder.id
        )
    })
}

pub fn process_due_reminders(app: AppHandle, state: &AppState) -> Result<usize, String> {
    let connection = database::open_connection()?;
    let reminders = list_due_worker_reminders(&connection)?;
    drop(connection);

    let mut processed = 0;
    for reminder in reminders {
        let connection = database::open_connection()?;
        let Some(reminder) = get_worker_reminder(&connection, &reminder.id)? else {
            continue;
        };

        match dispatch_due_reminder(app.clone(), state, &connection, &reminder) {
            Ok(ReminderDispatchOutcome::Delivered) => {
                delete_worker_reminder(&connection, &reminder.id)?;
                state.log(
                    "info",
                    "worker.reminder.sent",
                    &format!(
                        "Delivered reminder {} for {}:{}",
                        reminder.id, reminder.actor_type, reminder.actor_id
                    ),
                );
                if let Some(task_id) = reminder.task_id.clone() {
                    let _ = app_events::emit_task_change(&app, "worker.reminder.sent", [task_id]);
                }
                let _ = app_events::emit_session_change(
                    &app,
                    "worker.reminder.sent",
                    [reminder.session_id.clone()],
                );
                processed += 1;
            }
            Ok(ReminderDispatchOutcome::Dropped(reason)) => {
                delete_worker_reminder(&connection, &reminder.id)?;
                state.log(
                    "warn",
                    "worker.reminder.dropped",
                    &format!(
                        "Dropped reminder {} for {}:{}: {}",
                        reminder.id, reminder.actor_type, reminder.actor_id, reason
                    ),
                );
                processed += 1;
            }
            Err(error) => {
                state.log(
                    "error",
                    "worker.reminder.retry",
                    &format!(
                        "Failed to deliver reminder {} for {}:{}: {}",
                        reminder.id, reminder.actor_type, reminder.actor_id, error
                    ),
                );
            }
        }
    }

    Ok(processed)
}

fn dispatch_due_reminder(
    app: AppHandle,
    state: &AppState,
    connection: &Connection,
    reminder: &WorkerReminder,
) -> Result<ReminderDispatchOutcome, String> {
    match reminder.actor_type.as_str() {
        ACTOR_AGENT => dispatch_agent_reminder(app, state, connection, reminder),
        ACTOR_ROLE_INSTANCE => dispatch_role_reminder(app, state, connection, reminder),
        other => Ok(ReminderDispatchOutcome::Dropped(format!(
            "unsupported reminder actor type {other}"
        ))),
    }
}

fn dispatch_agent_reminder(
    app: AppHandle,
    state: &AppState,
    connection: &Connection,
    reminder: &WorkerReminder,
) -> Result<ReminderDispatchOutcome, String> {
    let agent = match agents::get_agent(connection, &reminder.actor_id) {
        Ok(agent) => agent,
        Err(error) => {
            return Ok(ReminderDispatchOutcome::Dropped(format!(
                "agent no longer exists: {error}"
            )))
        }
    };

    if agent.archived {
        return Ok(ReminderDispatchOutcome::Dropped(format!(
            "agent {} is archived",
            agent.name
        )));
    }

    let context = pi_sessions::session_context_for_project_id(&reminder.project_id)?;
    let runtime_state = agent_dispatch::ensure_main_session(
        &context.project_root,
        &context.session_dir,
        &reminder.project_id,
        &reminder.actor_id,
    )?;
    let session_id = runtime_state
        .main_session_id
        .ok_or_else(|| format!("Agent {} has no main session", reminder.actor_id))?;
    let runtime_cwd = runtime_state
        .runtime_cwd
        .unwrap_or_else(|| context.project_root.display().to_string());
    let actual_session_dir =
        pi_sessions::find_session_context_for_session(&session_id)?.session_dir;
    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(&runtime_cwd),
        actual_session_dir,
        &session_id,
    )?;

    if runtime.has_active_prompt() {
        runtime.start_delivery(
            &generate_id("reminder-steer"),
            DELIVERY_STEER,
            &reminder.message,
        )?;
    } else {
        let run_id = generate_id("reminder-prompt");
        state.begin_session_run(&session_id, &run_id)?;
        if let Err(error) = runtime.start_delivery(&run_id, DELIVERY_PROMPT, &reminder.message) {
            let _ = state.end_session_run(&session_id, &run_id);
            return Err(error);
        }
    }

    Ok(ReminderDispatchOutcome::Delivered)
}

fn dispatch_role_reminder(
    app: AppHandle,
    state: &AppState,
    connection: &Connection,
    reminder: &WorkerReminder,
) -> Result<ReminderDispatchOutcome, String> {
    let role_instance = match role_runtime::get_role_instance(connection, &reminder.actor_id) {
        Ok(instance) => instance,
        Err(error) => {
            send_role_reminder_failure_notice(
                app,
                state,
                connection,
                reminder,
                &format!("the role session no longer exists ({error})"),
            )?;
            return Ok(ReminderDispatchOutcome::Dropped(
                "role session no longer exists".into(),
            ));
        }
    };

    if !matches!(
        role_instance.status.as_str(),
        "idle" | "running" | "waiting"
    ) {
        send_role_reminder_failure_notice(
            app,
            state,
            connection,
            reminder,
            &format!("the role session is {}", role_instance.status),
        )?;
        return Ok(ReminderDispatchOutcome::Dropped(format!(
            "role session is {}",
            role_instance.status
        )));
    }

    let Some(session_id) = role_instance.session_id.clone() else {
        send_role_reminder_failure_notice(
            app,
            state,
            connection,
            reminder,
            "the role session has no session id",
        )?;
        return Ok(ReminderDispatchOutcome::Dropped(
            "role session has no session id".into(),
        ));
    };

    if pi_sessions::find_session_context_for_session(&session_id).is_err() {
        send_role_reminder_failure_notice(
            app,
            state,
            connection,
            reminder,
            "the role session is gone",
        )?;
        return Ok(ReminderDispatchOutcome::Dropped(
            "role session is gone".into(),
        ));
    }

    let context = pi_sessions::session_context_for_project_id(&reminder.project_id)?;
    let runtime_cwd = role_instance
        .worktree_path
        .clone()
        .unwrap_or_else(|| context.project_root.display().to_string());
    let runtime = live_sessions::ensure_runtime(
        &state.session_runtimes,
        app,
        PathBuf::from(&runtime_cwd),
        context.session_dir.clone(),
        &session_id,
    )?;

    if runtime.has_active_prompt() {
        runtime.start_delivery(
            &generate_id("reminder-steer"),
            DELIVERY_STEER,
            &reminder.message,
        )?;
    } else {
        let run_id = generate_id("reminder-prompt");
        state.begin_session_run(&session_id, &run_id)?;
        if let Err(error) = runtime.start_delivery(&run_id, DELIVERY_PROMPT, &reminder.message) {
            let _ = state.end_session_run(&session_id, &run_id);
            return Err(error);
        }
    }

    Ok(ReminderDispatchOutcome::Delivered)
}

fn send_role_reminder_failure_notice(
    app: AppHandle,
    state: &AppState,
    connection: &Connection,
    reminder: &WorkerReminder,
    reason: &str,
) -> Result<(), String> {
    let message = messages::send_mailbox_message_from_authorization(
        app.clone(),
        state,
        connection,
        None,
        None,
        SendMailboxMessageInput {
            project_id: Some(reminder.project_id.clone()),
            task_id: reminder.task_id.clone(),
            recipient_type: "user".into(),
            recipient_id: None,
            sender_label: Some(USER_FAILURE_SENDER.into()),
            body: format!(
                "A scheduled reminder for role session {} could not be delivered because {}. Original reminder: {}",
                reminder.actor_id, reason, reminder.message
            ),
            priority: Some("normal".into()),
        },
    )?;
    let _ = app_events::emit_inbox_change(
        &app,
        "worker.reminder.failed",
        [message.delivery_id.clone()],
    );
    if let Some(task_id) = message.task_id.clone() {
        let _ = app_events::emit_task_change(&app, "worker.reminder.failed", [task_id]);
    }
    Ok(())
}

fn normalize_delay_seconds(input: &RemindMeInput) -> Result<i64, String> {
    let mut components = 0;
    let mut total_seconds = 0_i64;

    if let Some(seconds) = input.delay_seconds {
        components += 1;
        total_seconds += seconds;
    }
    if let Some(minutes) = input.delay_minutes {
        components += 1;
        total_seconds += minutes * 60;
    }

    if components != 1 {
        return Err("Provide exactly one of delaySeconds or delayMinutes.".into());
    }
    if total_seconds <= 0 {
        return Err("Reminder delay must be greater than zero.".into());
    }
    if total_seconds > MAX_DELAY_SECONDS {
        return Err(format!(
            "Reminder delay must be {} seconds or less.",
            MAX_DELAY_SECONDS
        ));
    }

    Ok(total_seconds)
}

fn list_due_worker_reminders(connection: &Connection) -> Result<Vec<WorkerReminder>, String> {
    let now = now_iso();
    let mut statement = connection
        .prepare(
            r#"
            SELECT id, project_id, actor_type, actor_id, session_id, task_id, message, due_at, created_at, updated_at
            FROM worker_reminders
            WHERE due_at <= ?1
            ORDER BY due_at ASC, created_at ASC, id ASC
            "#,
        )
        .map_err(|error| format!("Unable to prepare due reminder query: {error}"))?;

    let rows = statement
        .query_map([now], read_worker_reminder)
        .map_err(|error| format!("Unable to query due reminders: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to read due reminders: {error}"))
}

fn get_worker_reminder(
    connection: &Connection,
    reminder_id: &str,
) -> Result<Option<WorkerReminder>, String> {
    connection
        .query_row(
            r#"
            SELECT id, project_id, actor_type, actor_id, session_id, task_id, message, due_at, created_at, updated_at
            FROM worker_reminders
            WHERE id = ?1
            "#,
            [reminder_id],
            read_worker_reminder,
        )
        .optional()
        .map_err(|error| format!("Unable to load worker reminder {reminder_id}: {error}"))
}

fn delete_worker_reminder(connection: &Connection, reminder_id: &str) -> Result<(), String> {
    connection
        .execute("DELETE FROM worker_reminders WHERE id = ?1", [reminder_id])
        .map_err(|error| format!("Unable to delete worker reminder {reminder_id}: {error}"))?;
    Ok(())
}

fn read_worker_reminder(row: &rusqlite::Row<'_>) -> rusqlite::Result<WorkerReminder> {
    Ok(WorkerReminder {
        id: row.get(0)?,
        project_id: row.get(1)?,
        actor_type: row.get(2)?,
        actor_id: row.get(3)?,
        session_id: row.get(4)?,
        task_id: row.get(5)?,
        message: row.get(6)?,
        due_at: row.get(7)?,
        created_at: row.get(8)?,
        updated_at: row.get(9)?,
    })
}

#[derive(Debug)]
struct ReminderTargetContext {
    project_id: String,
    session_id: String,
    task_id: Option<String>,
}

fn resolve_target_context(
    connection: &Connection,
    authorization: &AuthorizationContext,
    session_id: Option<&str>,
) -> Result<ReminderTargetContext, String> {
    match authorization.actor_type.as_str() {
        ACTOR_AGENT => {
            resolve_agent_target_context(connection, &authorization.actor_id, session_id)
        }
        ACTOR_ROLE_INSTANCE => {
            resolve_role_instance_target_context(connection, &authorization.actor_id, session_id)
        }
        other => Err(format!("Unsupported reminder actor type {other}")),
    }
}

fn resolve_agent_target_context(
    connection: &Connection,
    agent_id: &str,
    session_id: Option<&str>,
) -> Result<ReminderTargetContext, String> {
    if let Some(session_id) = session_id {
        if let Some(assignment) =
            task_runtime::get_active_assignment_for_session(connection, session_id)?
        {
            if assignment.worker_type == ACTOR_AGENT
                && assignment.worker_id.as_deref() == Some(agent_id)
            {
                return Ok(ReminderTargetContext {
                    project_id: resolve_project_id_for_task(connection, &assignment.task_id)?,
                    session_id: session_id.to_string(),
                    task_id: Some(assignment.task_id),
                });
            }
        }

        if let Some(project_id) = connection
            .query_row(
                "SELECT project_id FROM agent_runtime_states WHERE agent_id = ?1 AND main_session_id = ?2 LIMIT 1",
                params![agent_id, session_id],
                |row| row.get::<_, String>(0),
            )
            .optional()
            .map_err(|error| format!("Unable to resolve agent reminder project: {error}"))?
        {
            return Ok(ReminderTargetContext {
                project_id,
                session_id: session_id.to_string(),
                task_id: None,
            });
        }
    }

    let (project_id, runtime_session_id) = connection
        .query_row(
            "SELECT project_id, COALESCE(main_session_id, '') FROM agent_runtime_states WHERE agent_id = ?1 ORDER BY updated_at DESC LIMIT 1",
            [agent_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve latest agent reminder context: {error}"))?
        .unwrap_or_else(|| ("orchestra".into(), session_id.unwrap_or_default().to_string()));

    let resolved_session_id = if let Some(session_id) = session_id {
        session_id.to_string()
    } else if !runtime_session_id.trim().is_empty() {
        runtime_session_id
    } else {
        String::new()
    };

    Ok(ReminderTargetContext {
        project_id,
        session_id: resolved_session_id,
        task_id: None,
    })
}

fn resolve_role_instance_target_context(
    connection: &Connection,
    role_instance_id: &str,
    session_id: Option<&str>,
) -> Result<ReminderTargetContext, String> {
    if let Some(session_id) = session_id {
        if let Some(assignment) =
            task_runtime::get_active_assignment_for_session(connection, session_id)?
        {
            if assignment.role_instance_id.as_deref() == Some(role_instance_id) {
                return Ok(ReminderTargetContext {
                    project_id: resolve_project_id_for_task(connection, &assignment.task_id)?,
                    session_id: session_id.to_string(),
                    task_id: Some(assignment.task_id),
                });
            }
        }
    }

    let (task_id, assignment_session_id) = connection
        .query_row(
            "SELECT task_id, session_id FROM task_lane_assignments WHERE role_instance_id = ?1 AND status = 'active' ORDER BY updated_at DESC LIMIT 1",
            [role_instance_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, Option<String>>(1)?)),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve role reminder context: {error}"))?
        .ok_or_else(|| "Role reminders require an active assignment session.".to_string())?;

    Ok(ReminderTargetContext {
        project_id: resolve_project_id_for_task(connection, &task_id)?,
        session_id: assignment_session_id.unwrap_or_default(),
        task_id: Some(task_id),
    })
}

fn resolve_project_id_for_task(connection: &Connection, task_id: &str) -> Result<String, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve task project {task_id}: {error}"))?
        .ok_or_else(|| format!("Task {task_id} was not found"))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{models::AgentUpsertInput, services::database};
    use rusqlite::Connection;

    fn in_memory_connection() -> Connection {
        let connection = Connection::open_in_memory().expect("open in-memory db");
        database::apply_migrations(&connection).expect("apply migrations");
        connection
    }

    #[test]
    fn schedules_agent_reminders() {
        let mut connection = in_memory_connection();
        let agent = agents::create_agent(
            &mut connection,
            AgentUpsertInput {
                name: "Reminder Agent".into(),
                description: None,
                system_prompt: None,
                provider: None,
                model: None,
                role_id: None,
                scope: Some("global".into()),
                project_id: None,
                thinking_level: Some("medium".into()),
                compaction_window: None,
                policy_ids: Vec::new(),
                direct_permissions: vec!["tasks.read".into()],
            },
        )
        .expect("agent should create");
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', ?1, 'idle', 'session-agent', '/tmp/runtime', NULL, NULL, NULL, ?2, ?2)",
                params![agent.id.as_str(), now.as_str()],
            )
            .expect("runtime state should insert");

        let reminder = schedule_reminder_for_authorization(
            &connection,
            Some(&AuthorizationContext {
                actor_type: ACTOR_AGENT.into(),
                actor_id: agent.id.clone(),
            }),
            Some("session-agent"),
            RemindMeInput {
                message: "Check back in five seconds".into(),
                delay_seconds: Some(5),
                delay_minutes: None,
            },
        )
        .expect("reminder should schedule");

        assert_eq!(reminder.project_id, "orchestra");
        assert_eq!(reminder.actor_type, ACTOR_AGENT);
        assert_eq!(reminder.session_id, "session-agent");
        assert_eq!(reminder.message, "Check back in five seconds");
    }

    #[test]
    fn rejects_role_reminders_without_active_assignment_context() {
        let connection = in_memory_connection();
        let error = schedule_reminder_for_authorization(
            &connection,
            Some(&AuthorizationContext {
                actor_type: ACTOR_ROLE_INSTANCE.into(),
                actor_id: "role-instance-1".into(),
            }),
            Some("missing-session"),
            RemindMeInput {
                message: "Remind me later".into(),
                delay_seconds: Some(10),
                delay_minutes: None,
            },
        )
        .expect_err("role reminder should require active assignment context");

        assert!(error.contains("active assignment session"));
    }

    #[test]
    fn lists_only_due_reminders() {
        let connection = in_memory_connection();
        let now = now_iso();
        connection
            .execute(
                "INSERT INTO worker_reminders (id, project_id, actor_type, actor_id, session_id, task_id, message, due_at, created_at, updated_at) VALUES ('due-1', 'orchestra', 'agent', 'agent-1', 'session-1', NULL, 'due', '2000-01-01T00:00:00Z', ?1, ?1)",
                [now.as_str()],
            )
            .expect("due reminder should insert");
        connection
            .execute(
                "INSERT INTO worker_reminders (id, project_id, actor_type, actor_id, session_id, task_id, message, due_at, created_at, updated_at) VALUES ('future-1', 'orchestra', 'agent', 'agent-1', 'session-1', NULL, 'future', '2999-01-01T00:00:00Z', ?1, ?1)",
                [now.as_str()],
            )
            .expect("future reminder should insert");

        let due = list_due_worker_reminders(&connection).expect("due reminders should load");
        assert_eq!(due.len(), 1);
        assert_eq!(due[0].id, "due-1");
    }
}
