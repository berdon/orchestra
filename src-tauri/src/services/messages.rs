use std::collections::{BTreeMap, BTreeSet};
use std::path::PathBuf;

use rusqlite::{params, params_from_iter, Connection, OptionalExtension, ToSql};
use tauri::AppHandle;

use crate::{
    models::{
        AuthorizationContext, MailboxMessage, SendMailboxMessageInput, TaskComment, TaskDetail,
        TaskLaneAssignment,
    },
    services::{
        agent_runtime, agents, pi_sessions, projects, roles, session_ownership, task_runtime,
    },
    state::{generate_id, now_iso, AppState},
};

const PRIORITY_NORMAL: &str = "normal";
const PRIORITY_INTERRUPT: &str = "interrupt";
const RECIPIENT_USER: &str = "user";
const RECIPIENT_AGENT: &str = "agent";
const RECIPIENT_ASSIGNMENT: &str = "assignment";
const RECIPIENT_ACTIVE_ASSIGNMENT: &str = "active_assignment";
const DEFAULT_USER_ID: &str = "desktop-user";

#[derive(Debug, Clone)]
struct ResolvedSender {
    sender_type: String,
    sender_id: Option<String>,
    sender_label: String,
}

#[derive(Debug, Clone)]
struct ResolvedRecipient {
    recipient_type: String,
    recipient_id: Option<String>,
    recipient_label: String,
    assignment_id: Option<String>,
    active_assignment: Option<TaskLaneAssignment>,
}

pub fn list_user_messages(
    connection: &Connection,
    project_id: Option<&str>,
    include_archived: bool,
) -> Result<Vec<MailboxMessage>, String> {
    if let Some(project_id) = project_id {
        projects::ensure_project_exists(connection, project_id)?;
    }

    let archived_clause = if include_archived {
        ""
    } else {
        " AND d.archived_at IS NULL"
    };

    let sql = if project_id.is_some() {
        format!(
            "{} WHERE d.recipient_type = 'user' AND m.project_id = ?1{} ORDER BY d.archived_at IS NOT NULL ASC, d.read_at IS NOT NULL ASC, m.created_at DESC, d.id DESC",
            mailbox_message_select(),
            archived_clause,
        )
    } else {
        format!(
            "{} WHERE d.recipient_type = 'user'{} ORDER BY d.archived_at IS NOT NULL ASC, d.read_at IS NOT NULL ASC, m.created_at DESC, d.id DESC",
            mailbox_message_select(),
            archived_clause,
        )
    };

    match project_id {
        Some(project_id) => load_messages_with_sql(connection, &sql, vec![&project_id]),
        None => load_messages_with_sql(connection, &sql, Vec::new()),
    }
}

pub fn list_task_messages(
    connection: &Connection,
    task_id: &str,
) -> Result<Vec<MailboxMessage>, String> {
    let sql = format!(
        "{} WHERE m.task_id = ?1 ORDER BY m.created_at DESC, d.id DESC",
        mailbox_message_select()
    );
    load_messages_with_sql(connection, &sql, vec![&task_id])
}

pub fn mark_user_messages_read(
    connection: &Connection,
    delivery_ids: Option<&[String]>,
) -> Result<Vec<MailboxMessage>, String> {
    let sql = format!(
        "{} WHERE d.recipient_type = 'user' AND d.read_at IS NULL ORDER BY m.created_at DESC, d.id DESC",
        mailbox_message_select()
    );
    let unread = load_messages_with_sql(connection, &sql, Vec::new())?;
    if unread.is_empty() {
        return Ok(Vec::new());
    }

    let allowed_ids = unread
        .iter()
        .map(|message| message.delivery_id.as_str())
        .collect::<BTreeSet<_>>();
    let selected_ids = match delivery_ids {
        Some(ids) if !ids.is_empty() => ids
            .iter()
            .filter(|id| allowed_ids.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>(),
        _ => unread
            .iter()
            .map(|message| message.delivery_id.clone())
            .collect::<Vec<_>>(),
    };

    if selected_ids.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_iso();
    let read_session_id = Some(DEFAULT_USER_ID.to_string());
    let placeholders = std::iter::repeat("?")
        .take(selected_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mut params: Vec<&dyn ToSql> = Vec::with_capacity(selected_ids.len() + 2);
    params.push(&now);
    params.push(&read_session_id);
    for id in &selected_ids {
        params.push(id);
    }
    let sql = format!(
        "UPDATE mailbox_message_deliveries SET read_at = ?1, read_session_id = ?2, updated_at = ?1 WHERE id IN ({placeholders})"
    );
    connection
        .execute(&sql, params_from_iter(params))
        .map_err(|error| format!("Unable to mark user mail read: {error}"))?;

    let follow_up_sql = format!(
        "{} WHERE d.id IN ({placeholders}) ORDER BY m.created_at DESC, d.id DESC",
        mailbox_message_select()
    );
    let follow_up_params = selected_ids
        .iter()
        .map(|id| id as &dyn ToSql)
        .collect::<Vec<_>>();
    load_messages_with_sql(connection, &follow_up_sql, follow_up_params)
}

pub fn archive_user_messages(
    connection: &Connection,
    delivery_ids: Option<&[String]>,
) -> Result<Vec<MailboxMessage>, String> {
    let sql = format!(
        "{} WHERE d.recipient_type = 'user' AND d.archived_at IS NULL ORDER BY m.created_at DESC, d.id DESC",
        mailbox_message_select()
    );
    let visible = load_messages_with_sql(connection, &sql, Vec::new())?;
    if visible.is_empty() {
        return Ok(Vec::new());
    }

    let allowed_ids = visible
        .iter()
        .map(|message| message.delivery_id.as_str())
        .collect::<BTreeSet<_>>();
    let selected_ids = match delivery_ids {
        Some(ids) if !ids.is_empty() => ids
            .iter()
            .filter(|id| allowed_ids.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>(),
        _ => visible
            .iter()
            .map(|message| message.delivery_id.clone())
            .collect::<Vec<_>>(),
    };

    if selected_ids.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_iso();
    let placeholders = std::iter::repeat("?")
        .take(selected_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mut params: Vec<&dyn ToSql> = Vec::with_capacity(selected_ids.len() + 1);
    params.push(&now);
    for id in &selected_ids {
        params.push(id);
    }
    let sql = format!(
        "UPDATE mailbox_message_deliveries SET archived_at = ?1, updated_at = ?1 WHERE id IN ({placeholders})"
    );
    connection
        .execute(&sql, params_from_iter(params))
        .map_err(|error| format!("Unable to archive user mail: {error}"))?;

    let follow_up_sql = format!(
        "{} WHERE d.id IN ({placeholders}) ORDER BY m.created_at DESC, d.id DESC",
        mailbox_message_select()
    );
    let follow_up_params = selected_ids
        .iter()
        .map(|id| id as &dyn ToSql)
        .collect::<Vec<_>>();
    load_messages_with_sql(connection, &follow_up_sql, follow_up_params)
}

pub fn list_unread_mail_for_authorization(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Vec<MailboxMessage>, String> {
    let mut deliveries = BTreeMap::new();

    let assignment_scope = match authorization {
        Some(authorization) => {
            resolve_visible_assignment_mail_scope(connection, authorization, session_id, task_id)?
        }
        None => resolve_assignment_scope_without_authorization(connection, session_id, task_id)?,
    };

    let agent_id = authorization
        .filter(|entry| entry.actor_type == "agent")
        .map(|entry| entry.actor_id.clone())
        .or_else(|| {
            assignment_scope
                .as_ref()
                .filter(|assignment| assignment.worker_type == "agent")
                .and_then(|assignment| assignment.worker_id.clone())
        });

    if let Some(agent_id) = agent_id.as_deref() {
        for message in load_unread_agent_mail(connection, agent_id)? {
            deliveries.insert(message.delivery_id.clone(), message);
        }
    }

    if let Some(assignment) = assignment_scope {
        for message in load_unread_assignment_mail(connection, &assignment.id)? {
            deliveries.insert(message.delivery_id.clone(), message);
        }
    }

    Ok(deliveries.into_values().collect())
}

pub fn mark_mail_read_for_authorization(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
    task_id: Option<&str>,
    delivery_ids: Option<&[String]>,
) -> Result<Vec<MailboxMessage>, String> {
    let unread =
        list_unread_mail_for_authorization(connection, authorization, session_id, task_id)?;
    if unread.is_empty() {
        return Ok(Vec::new());
    }

    let allowed_ids = unread
        .iter()
        .map(|message| message.delivery_id.as_str())
        .collect::<BTreeSet<_>>();
    let selected_ids = match delivery_ids {
        Some(ids) if !ids.is_empty() => ids
            .iter()
            .filter(|id| allowed_ids.contains(id.as_str()))
            .cloned()
            .collect::<Vec<_>>(),
        _ => unread
            .iter()
            .map(|message| message.delivery_id.clone())
            .collect::<Vec<_>>(),
    };

    if selected_ids.is_empty() {
        return Ok(Vec::new());
    }

    let now = now_iso();
    let session_id = session_id.map(str::to_string);
    let placeholders = std::iter::repeat("?")
        .take(selected_ids.len())
        .collect::<Vec<_>>()
        .join(", ");
    let mut params: Vec<&dyn ToSql> = Vec::with_capacity(selected_ids.len() + 2);
    params.push(&now);
    params.push(&session_id);
    for id in &selected_ids {
        params.push(id);
    }
    let sql = format!(
        "UPDATE mailbox_message_deliveries SET read_at = ?1, read_session_id = ?2, updated_at = ?1 WHERE id IN ({placeholders})"
    );
    connection
        .execute(&sql, params_from_iter(params))
        .map_err(|error| format!("Unable to mark mail read: {error}"))?;

    let follow_up_sql = format!(
        "{} WHERE d.id IN ({placeholders}) ORDER BY m.created_at DESC, d.id DESC",
        mailbox_message_select()
    );
    let follow_up_params = selected_ids
        .iter()
        .map(|id| id as &dyn ToSql)
        .collect::<Vec<_>>();
    load_messages_with_sql(connection, &follow_up_sql, follow_up_params)
}

pub fn send_mailbox_message_from_user(
    app: AppHandle,
    state: &AppState,
    connection: &Connection,
    input: SendMailboxMessageInput,
) -> Result<MailboxMessage, String> {
    let sender = ResolvedSender {
        sender_type: RECIPIENT_USER.into(),
        sender_id: Some(DEFAULT_USER_ID.into()),
        sender_label: input
            .sender_label
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "User".into()),
    };
    send_mailbox_message_internal(Some(&app), Some(state), connection, sender, None, input)
}

pub fn send_mailbox_message_from_user_without_app(
    connection: &Connection,
    input: SendMailboxMessageInput,
) -> Result<MailboxMessage, String> {
    let sender = ResolvedSender {
        sender_type: RECIPIENT_USER.into(),
        sender_id: Some(DEFAULT_USER_ID.into()),
        sender_label: input
            .sender_label
            .clone()
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "User".into()),
    };
    send_mailbox_message_internal(None, None, connection, sender, None, input)
}

pub fn send_mailbox_message_from_authorization(
    app: AppHandle,
    state: &AppState,
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
    session_id: Option<&str>,
    input: SendMailboxMessageInput,
) -> Result<MailboxMessage, String> {
    let sender = resolve_sender(connection, authorization, session_id, &input)?;
    send_mailbox_message_internal(
        Some(&app),
        Some(state),
        connection,
        sender,
        session_id,
        input,
    )
}

pub fn create_user_mailbox_message_for_task_comment(
    connection: &Connection,
    task: &TaskDetail,
    comment: &TaskComment,
) -> Result<MailboxMessage, String> {
    projects::ensure_project_exists(connection, &task.project_id)?;

    let sender_label = comment.author.trim();
    if sender_label.is_empty() {
        return Err("Task comment author is required for mailbox delivery.".into());
    }

    let body = build_task_comment_mailbox_body(task, comment);
    let now = now_iso();
    let message_id = generate_id("mail-message");
    let delivery_id = generate_id("mail-delivery");

    connection
        .execute(
            r#"
            INSERT INTO mailbox_messages (
                id,
                project_id,
                task_id,
                sender_type,
                sender_id,
                sender_label,
                body,
                priority,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            "#,
            params![
                message_id,
                task.project_id.as_str(),
                task.id.as_str(),
                comment.origin_type.as_str(),
                comment.origin_id.as_deref(),
                sender_label,
                body,
                PRIORITY_NORMAL,
                now,
            ],
        )
        .map_err(|error| format!("Unable to store task comment mailbox message: {error}"))?;

    connection
        .execute(
            r#"
            INSERT INTO mailbox_message_deliveries (
                id,
                message_id,
                recipient_type,
                recipient_id,
                recipient_label,
                assignment_id,
                read_at,
                read_session_id,
                last_notified_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, NULL, NULL, NULL, NULL, ?6, ?6)
            "#,
            params![
                delivery_id,
                message_id,
                RECIPIENT_USER,
                DEFAULT_USER_ID,
                "User",
                now,
            ],
        )
        .map_err(|error| format!("Unable to store task comment mailbox delivery: {error}"))?;

    get_message_delivery(connection, &delivery_id)
}

fn send_mailbox_message_internal(
    app: Option<&AppHandle>,
    state: Option<&AppState>,
    connection: &Connection,
    sender: ResolvedSender,
    session_id: Option<&str>,
    input: SendMailboxMessageInput,
) -> Result<MailboxMessage, String> {
    let body = input.body.trim();
    if body.is_empty() {
        return Err("body: Message body is required.".into());
    }

    let priority = normalize_priority(input.priority.as_deref())?;
    let project_id = resolve_project_id_for_send(connection, &sender, session_id, &input)?;
    let task_id = input.task_id.as_deref().map(str::to_string);
    let recipient = resolve_recipient(connection, &project_id, task_id.as_deref(), &input)?;
    let now = now_iso();
    let message_id = generate_id("mail-message");
    let delivery_id = generate_id("mail-delivery");

    connection
        .execute(
            r#"
            INSERT INTO mailbox_messages (
                id,
                project_id,
                task_id,
                sender_type,
                sender_id,
                sender_label,
                body,
                priority,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?9)
            "#,
            params![
                message_id,
                project_id,
                task_id,
                sender.sender_type,
                sender.sender_id,
                sender.sender_label,
                body,
                priority,
                now,
            ],
        )
        .map_err(|error| format!("Unable to store mailbox message: {error}"))?;

    connection
        .execute(
            r#"
            INSERT INTO mailbox_message_deliveries (
                id,
                message_id,
                recipient_type,
                recipient_id,
                recipient_label,
                assignment_id,
                read_at,
                read_session_id,
                last_notified_at,
                created_at,
                updated_at
            )
            VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?7)
            "#,
            params![
                delivery_id,
                message_id,
                recipient.recipient_type,
                recipient.recipient_id,
                recipient.recipient_label,
                recipient.assignment_id,
                now,
            ],
        )
        .map_err(|error| format!("Unable to store mailbox delivery: {error}"))?;

    deliver_message(
        app,
        state,
        connection,
        &project_id,
        task_id.as_deref(),
        &sender.sender_label,
        &priority,
        &delivery_id,
        &recipient,
    )?;
    get_message_delivery(connection, &delivery_id)
}

fn build_task_comment_mailbox_body(task: &TaskDetail, comment: &TaskComment) -> String {
    format!(
        "Task comment from {} on {} — {}:\n\n{}",
        comment.author,
        task.number,
        task.title,
        comment.message.trim()
    )
}

fn resolve_sender(
    connection: &Connection,
    authorization: Option<&AuthorizationContext>,
    _session_id: Option<&str>,
    input: &SendMailboxMessageInput,
) -> Result<ResolvedSender, String> {
    let Some(authorization) = authorization else {
        return Ok(ResolvedSender {
            sender_type: RECIPIENT_USER.into(),
            sender_id: Some(DEFAULT_USER_ID.into()),
            sender_label: input
                .sender_label
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "User".into()),
        });
    };

    match authorization.actor_type.as_str() {
        "user" => Ok(ResolvedSender {
            sender_type: RECIPIENT_USER.into(),
            sender_id: Some(authorization.actor_id.clone()),
            sender_label: input
                .sender_label
                .clone()
                .filter(|value| !value.trim().is_empty())
                .unwrap_or_else(|| "User".into()),
        }),
        "agent" => {
            let agent = agents::get_agent(connection, &authorization.actor_id)?;
            Ok(ResolvedSender {
                sender_type: "agent".into(),
                sender_id: Some(agent.id),
                sender_label: agent.name,
            })
        }
        "role" => {
            let role = roles::get_role(connection, &authorization.actor_id)?;
            Ok(ResolvedSender {
                sender_type: "role".into(),
                sender_id: Some(role.id),
                sender_label: role.name,
            })
        }
        "role_instance" => {
            let (display_name, role_id) = connection
                .query_row(
                    "SELECT display_name, role_id FROM role_instances WHERE id = ?1",
                    [authorization.actor_id.as_str()],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?)),
                )
                .optional()
                .map_err(|error| format!("Unable to resolve role instance sender: {error}"))?
                .ok_or_else(|| format!("Role instance {} was not found", authorization.actor_id))?;
            let label = if display_name.trim().is_empty() {
                roles::get_role(connection, &role_id)?.name
            } else {
                display_name
            };
            Ok(ResolvedSender {
                sender_type: "role_instance".into(),
                sender_id: Some(authorization.actor_id.clone()),
                sender_label: label,
            })
        }
        other => Err(format!("Unsupported mailbox sender type: {other}")),
    }
}

fn resolve_project_id_for_send(
    connection: &Connection,
    sender: &ResolvedSender,
    session_id: Option<&str>,
    input: &SendMailboxMessageInput,
) -> Result<String, String> {
    if let Some(task_id) = input.task_id.as_deref() {
        return resolve_project_id_for_task(connection, task_id)?
            .ok_or_else(|| format!("Task {} was not found", task_id));
    }

    if let Some(project_id) = input
        .project_id
        .as_deref()
        .filter(|value| !value.trim().is_empty())
    {
        projects::ensure_project_exists(connection, project_id)?;
        return Ok(project_id.to_string());
    }

    if let Some(session_id) = session_id {
        if let Some(project_id) =
            session_ownership::load_session_project_id(connection, session_id)?
        {
            return Ok(project_id);
        }
    }

    if sender.sender_type == "agent" {
        if let Some(sender_id) = sender.sender_id.as_deref() {
            let authorization = AuthorizationContext {
                actor_type: "agent".into(),
                actor_id: sender_id.to_string(),
            };
            if let Some(agent_session_id) =
                session_ownership::load_worker_session_from_authorization(
                    connection,
                    &authorization,
                )?
            {
                if let Some(project_id) =
                    session_ownership::load_session_project_id(connection, &agent_session_id)?
                {
                    return Ok(project_id);
                }
            }
        }
    }

    projects::resolve_default_project_id(connection)?.ok_or_else(|| {
        "Create a project first before sending mail without a task context.".to_string()
    })
}

fn resolve_recipient(
    connection: &Connection,
    _project_id: &str,
    task_id: Option<&str>,
    input: &SendMailboxMessageInput,
) -> Result<ResolvedRecipient, String> {
    match input.recipient_type.as_str() {
        RECIPIENT_USER => Ok(ResolvedRecipient {
            recipient_type: RECIPIENT_USER.into(),
            recipient_id: Some(DEFAULT_USER_ID.into()),
            recipient_label: "User".into(),
            assignment_id: None,
            active_assignment: None,
        }),
        RECIPIENT_AGENT => {
            let agent_id = input
                .recipient_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "recipientId: Agent recipient id is required.".to_string())?;
            let agent = agents::get_agent(connection, agent_id)?;
            Ok(ResolvedRecipient {
                recipient_type: RECIPIENT_AGENT.into(),
                recipient_id: Some(agent.id),
                recipient_label: agent.name,
                assignment_id: None,
                active_assignment: None,
            })
        }
        RECIPIENT_ACTIVE_ASSIGNMENT => {
            let task_id = task_id.ok_or_else(|| {
                "taskId: taskId is required when sending mail to the active assignment.".to_string()
            })?;
            let assignment = task_runtime::get_current_lane_assignment(connection, task_id)?
                .ok_or_else(|| format!("Task {task_id} has no current assignment mailbox."))?;
            if assignment.worker_type == "user" {
                return Err("User-owned lanes do not expose an active assignment mailbox.".into());
            }
            Ok(ResolvedRecipient {
                recipient_type: RECIPIENT_ASSIGNMENT.into(),
                recipient_id: assignment.worker_id.clone(),
                recipient_label: build_assignment_label(connection, &assignment)?,
                assignment_id: Some(assignment.id.clone()),
                active_assignment: Some(assignment),
            })
        }
        RECIPIENT_ASSIGNMENT => {
            let assignment_id = input
                .recipient_id
                .as_deref()
                .filter(|value| !value.trim().is_empty())
                .ok_or_else(|| "recipientId: Assignment recipient id is required.".to_string())?;
            let assignment = load_assignment(connection, assignment_id)?;
            if assignment.status != "active" || assignment.session_id.is_none() {
                return Err(format!(
                    "Assignment {assignment_id} is not active and cannot receive mail."
                ));
            }
            Ok(ResolvedRecipient {
                recipient_type: RECIPIENT_ASSIGNMENT.into(),
                recipient_id: assignment.worker_id.clone(),
                recipient_label: build_assignment_label(connection, &assignment)?,
                assignment_id: Some(assignment.id.clone()),
                active_assignment: Some(assignment),
            })
        }
        other => Err(format!(
            "recipientType: Unsupported recipient type {other}."
        )),
    }
}

fn deliver_message(
    app: Option<&AppHandle>,
    state: Option<&AppState>,
    connection: &Connection,
    project_id: &str,
    task_id: Option<&str>,
    sender_label: &str,
    priority: &str,
    delivery_id: &str,
    recipient: &ResolvedRecipient,
) -> Result<(), String> {
    match recipient.recipient_type.as_str() {
        RECIPIENT_USER => Ok(()),
        RECIPIENT_AGENT => {
            let agent_id = recipient
                .recipient_id
                .as_deref()
                .ok_or_else(|| "Agent delivery is missing recipient id".to_string())?;
            let message = build_unread_mail_delivery_message(task_id, sender_label, priority);
            let delivery_mode = resolve_agent_mail_delivery_mode(connection, project_id, agent_id)?;
            agent_runtime::enqueue_agent_work_for_project(
                connection,
                project_id,
                crate::models::AgentQueueEntryInput {
                    agent_id: agent_id.to_string(),
                    source_type: "mail".into(),
                    source_task_id: task_id.map(str::to_string),
                    source_workflow_id: None,
                    source_lane_id: None,
                    delivery_mode: delivery_mode.into(),
                    title: if let Some(task_id) = task_id {
                        format!("Mail for task {task_id}")
                    } else {
                        "Mailbox delivery".into()
                    },
                    message,
                },
            )?;
            mark_delivery_notified(connection, delivery_id)?;
            if let Some(app) = app {
                let _ = crate::services::app_events::emit_session_change(
                    app,
                    "mail.sent",
                    Vec::<String>::new(),
                );
            }
            Ok(())
        }
        RECIPIENT_ASSIGNMENT => {
            let assignment = recipient
                .active_assignment
                .as_ref()
                .ok_or_else(|| "Assignment delivery is missing an active assignment".to_string())?;
            let app = app.ok_or_else(|| {
                "Active-assignment mail delivery requires the Orchestra desktop/runtime app handle"
                    .to_string()
            })?;
            let state = state.ok_or_else(|| {
                "Active-assignment mail delivery requires live Orchestra app state".to_string()
            })?;
            let context = pi_sessions::session_context_for_project_id(project_id)?;
            match task_runtime::notify_active_assignment_of_unread_mail(
                app.clone(),
                state,
                PathBuf::from(context.session_dir),
                assignment,
                &build_unread_mail_delivery_message(task_id, sender_label, priority),
                priority == PRIORITY_INTERRUPT,
            ) {
                Ok(()) => {
                    mark_delivery_notified(connection, delivery_id)?;
                }
                Err(_error) => {}
            }
            Ok(())
        }
        _ => Ok(()),
    }
}

fn resolve_visible_assignment_mail_scope(
    connection: &Connection,
    authorization: &AuthorizationContext,
    session_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Option<TaskLaneAssignment>, String> {
    if let Some(task_id) = task_id {
        let assignment = task_runtime::get_active_lane_assignment(connection, task_id)?;
        if let Some(assignment) = assignment {
            task_runtime::validate_assignment_authorization(&assignment, Some(authorization))?;
            return Ok(Some(assignment));
        }
    }

    let Some(session_id) = session_id else {
        return Ok(None);
    };
    let assignment = session_ownership::load_session_open_assignment(connection, session_id)?;
    if let Some(assignment) = assignment {
        task_runtime::validate_assignment_authorization(&assignment, Some(authorization))?;
        return Ok(Some(assignment));
    }

    Ok(None)
}

fn resolve_assignment_scope_without_authorization(
    connection: &Connection,
    session_id: Option<&str>,
    task_id: Option<&str>,
) -> Result<Option<TaskLaneAssignment>, String> {
    if let Some(task_id) = task_id {
        if let Some(assignment) = task_runtime::get_active_lane_assignment(connection, task_id)? {
            return Ok(Some(assignment));
        }
    }

    let Some(session_id) = session_id else {
        return Ok(None);
    };
    session_ownership::load_session_open_assignment(connection, session_id)
}

fn resolve_project_id_for_session(
    connection: &Connection,
    session_id: Option<&str>,
) -> Result<Option<String>, String> {
    let Some(session_id) = session_id else {
        return Ok(None);
    };

    session_ownership::load_session_project_id(connection, session_id)
}

fn resolve_project_id_for_task(
    connection: &Connection,
    task_id: &str,
) -> Result<Option<String>, String> {
    connection
        .query_row(
            "SELECT project_id FROM tasks WHERE id = ?1 LIMIT 1",
            [task_id],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| format!("Unable to resolve task project {task_id}: {error}"))
}

fn load_unread_agent_mail(
    connection: &Connection,
    agent_id: &str,
) -> Result<Vec<MailboxMessage>, String> {
    let sql = format!(
        "{} WHERE d.recipient_type = 'agent' AND d.recipient_id = ?1 AND d.read_at IS NULL ORDER BY m.created_at ASC, d.id ASC",
        mailbox_message_select()
    );

    load_messages_with_sql(connection, &sql, vec![&agent_id])
}

fn load_unread_assignment_mail(
    connection: &Connection,
    assignment_id: &str,
) -> Result<Vec<MailboxMessage>, String> {
    let sql = format!(
        "{} WHERE d.recipient_type = 'assignment' AND d.assignment_id = ?1 AND d.read_at IS NULL ORDER BY m.created_at ASC, d.id ASC",
        mailbox_message_select()
    );
    load_messages_with_sql(connection, &sql, vec![&assignment_id])
}

fn get_message_delivery(
    connection: &Connection,
    delivery_id: &str,
) -> Result<MailboxMessage, String> {
    let sql = format!("{} WHERE d.id = ?1 LIMIT 1", mailbox_message_select());
    load_messages_with_sql(connection, &sql, vec![&delivery_id])?
        .into_iter()
        .next()
        .ok_or_else(|| format!("Mailbox delivery {delivery_id} was not found"))
}

fn load_assignment(
    connection: &Connection,
    assignment_id: &str,
) -> Result<TaskLaneAssignment, String> {
    connection
        .query_row(
            r#"
            SELECT
                id,
                task_id,
                workflow_id,
                lane_id,
                worker_type,
                worker_id,
                status,
                session_id,
                runtime_cwd,
                role_queue_entry_id,
                role_instance_id,
                prompt,
                pending_outcome,
                completion_summary,
                completion_notes,
                whip_count,
                last_whip_at,
                started_at,
                completed_at,
                created_at,
                updated_at
            FROM task_lane_assignments
            WHERE id = ?1
            "#,
            [assignment_id],
            |row| {
                Ok(TaskLaneAssignment {
                    id: row.get(0)?,
                    task_id: row.get(1)?,
                    workflow_id: row.get(2)?,
                    lane_id: row.get(3)?,
                    worker_type: row.get(4)?,
                    worker_id: row.get(5)?,
                    status: row.get(6)?,
                    session_id: row.get(7)?,
                    runtime_cwd: row.get(8)?,
                    role_queue_entry_id: row.get(9)?,
                    role_instance_id: row.get(10)?,
                    prompt: row.get(11)?,
                    pending_outcome: row.get(12)?,
                    completion_summary: row.get(13)?,
                    completion_notes: row.get(14)?,
                    whip_count: row.get(15)?,
                    last_whip_at: row.get(16)?,
                    started_at: row.get(17)?,
                    completed_at: row.get(18)?,
                    created_at: row.get(19)?,
                    updated_at: row.get(20)?,
                })
            },
        )
        .optional()
        .map_err(|error| format!("Unable to load assignment {assignment_id}: {error}"))?
        .ok_or_else(|| format!("Assignment {assignment_id} was not found"))
}

fn build_assignment_label(
    connection: &Connection,
    assignment: &TaskLaneAssignment,
) -> Result<String, String> {
    let task_number = connection
        .query_row(
            "SELECT number FROM tasks WHERE id = ?1",
            [assignment.task_id.as_str()],
            |row| row.get::<_, String>(0),
        )
        .optional()
        .map_err(|error| {
            format!(
                "Unable to resolve task number for assignment {}: {error}",
                assignment.id
            )
        })?
        .unwrap_or_else(|| assignment.task_id.clone());
    let worker_label = match assignment.worker_type.as_str() {
        "agent" => assignment
            .worker_id
            .as_deref()
            .map(|agent_id| agents::get_agent(connection, agent_id).map(|agent| agent.name))
            .transpose()?
            .unwrap_or_else(|| "Agent".into()),
        "role" => assignment
            .worker_id
            .as_deref()
            .map(|role_id| roles::get_role(connection, role_id).map(|role| role.name))
            .transpose()?
            .unwrap_or_else(|| "Role".into()),
        _ => "Worker".into(),
    };
    Ok(format!("{worker_label} · {task_number}"))
}

fn normalize_priority(priority: Option<&str>) -> Result<String, String> {
    match priority.unwrap_or(PRIORITY_NORMAL).trim() {
        "" | PRIORITY_NORMAL => Ok(PRIORITY_NORMAL.into()),
        PRIORITY_INTERRUPT => Ok(PRIORITY_INTERRUPT.into()),
        other => Err(format!("priority: Unsupported priority {other}.")),
    }
}

pub fn resolve_agent_mail_delivery_mode(
    connection: &Connection,
    project_id: &str,
    agent_id: &str,
) -> Result<&'static str, String> {
    let runtime_state =
        agent_runtime::ensure_agent_runtime_state_for_project(connection, project_id, agent_id)?;
    if runtime_state.current_queue_entry_id.is_some() || runtime_state.status == "running" {
        Ok("steer")
    } else {
        Ok("prompt")
    }
}

pub fn agent_has_unread_direct_mail(
    connection: &Connection,
    agent_id: &str,
) -> Result<bool, String> {
    Ok(!load_unread_agent_mail(connection, agent_id)?.is_empty())
}

fn build_unread_mail_delivery_message(
    task_id: Option<&str>,
    sender_label: &str,
    priority: &str,
) -> String {
    let opener = if priority == PRIORITY_INTERRUPT {
        "Important unread mail"
    } else {
        "Unread mail"
    };
    match task_id {
        Some(task_id) => format!(
            "{opener} from {sender_label} about task {task_id}. Call get_unread_mail({task_id}), review the unread mail, respond if needed, then call mark_mail_read({task_id}) before you continue or complete the lane. After handling the mail, continue your current work.",
        ),
        None => format!(
            "{opener} from {sender_label}. Call get_unread_mail(), review the unread mail, respond if needed, then call mark_mail_read() before you continue with other Orchestra work.",
        ),
    }
}

fn mark_delivery_notified(connection: &Connection, delivery_id: &str) -> Result<(), String> {
    let now = now_iso();
    connection
        .execute(
            "UPDATE mailbox_message_deliveries SET last_notified_at = ?2, updated_at = ?2 WHERE id = ?1",
            params![delivery_id, now],
        )
        .map_err(|error| format!("Unable to record mailbox delivery notification {delivery_id}: {error}"))?;
    Ok(())
}

fn mailbox_message_select() -> String {
    r#"
    SELECT
        d.id,
        m.id,
        m.project_id,
        m.task_id,
        t.number,
        t.title,
        m.sender_type,
        m.sender_id,
        m.sender_label,
        d.recipient_type,
        d.recipient_id,
        d.recipient_label,
        d.assignment_id,
        m.body,
        m.priority,
        d.read_at,
        d.read_session_id,
        d.archived_at,
        d.last_notified_at,
        m.created_at,
        d.updated_at
    FROM mailbox_message_deliveries d
    JOIN mailbox_messages m ON m.id = d.message_id
    LEFT JOIN tasks t ON t.id = m.task_id
    "#
    .into()
}

fn load_messages_with_sql(
    connection: &Connection,
    sql: &str,
    params: Vec<&dyn ToSql>,
) -> Result<Vec<MailboxMessage>, String> {
    let mut statement = connection
        .prepare(sql)
        .map_err(|error| format!("Unable to prepare mailbox message query: {error}"))?;
    let rows = statement
        .query_map(params_from_iter(params), |row| {
            Ok(MailboxMessage {
                delivery_id: row.get(0)?,
                message_id: row.get(1)?,
                project_id: row.get(2)?,
                task_id: row.get(3)?,
                task_number: row.get(4)?,
                task_title: row.get(5)?,
                sender_type: row.get(6)?,
                sender_id: row.get(7)?,
                sender_label: row.get(8)?,
                recipient_type: row.get(9)?,
                recipient_id: row.get(10)?,
                recipient_label: row.get(11)?,
                assignment_id: row.get(12)?,
                body: row.get(13)?,
                priority: row.get(14)?,
                read_at: row.get(15)?,
                read_session_id: row.get(16)?,
                archived_at: row.get(17)?,
                last_notified_at: row.get(18)?,
                created_at: row.get(19)?,
                updated_at: row.get(20)?,
            })
        })
        .map_err(|error| format!("Unable to query mailbox messages: {error}"))?;
    rows.collect::<Result<Vec<_>, _>>()
        .map_err(|error| format!("Unable to collect mailbox messages: {error}"))
}

#[cfg(test)]
mod tests {
    use std::{env, path::PathBuf};

    use rusqlite::{params, Connection};
    use uuid::Uuid;

    use super::*;
    use crate::{
        models::{AuthorizationContext, TaskUpsertInput},
        services::{database::initialize_database_at, tasks},
    };

    fn unique_temp_db(label: &str) -> PathBuf {
        env::temp_dir().join(format!("{}-{}.db", label, Uuid::new_v4().simple()))
    }

    fn open_test_connection(label: &str) -> Connection {
        let path = unique_temp_db(label);
        initialize_database_at(&path).expect("database should initialize");
        let connection = Connection::open(path).expect("database should open");
        let now = now_iso();
        connection
            .execute(
                "INSERT OR IGNORE INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('orchestra', 'orchestra', 'Orchestra', NULL, 'ORC', NULL, ?1, ?1)",
                params![now.as_str()],
            )
            .expect("default project should seed");
        connection
    }

    fn seed_agent(connection: &Connection, agent_id: &str, name: &str, now: &str) {
        connection
            .execute(
                "INSERT INTO agents (id, slug, name, description, system_prompt, provider, model, role_id, thinking_level, direct_permissions, system, immutable, archived, created_at, updated_at) VALUES (?1, ?2, ?3, NULL, NULL, NULL, NULL, NULL, 'off', '[]', 0, 0, 0, ?4, ?4)",
                params![agent_id, agent_id, name, now],
            )
            .expect("agent should seed");
    }

    fn create_basic_task(connection: &mut Connection, title: &str) -> String {
        tasks::create_task(
            connection,
            Some("orchestra"),
            TaskUpsertInput {
                title: title.into(),
                description: Some("Test task".into()),
                task_type: "task".into(),
                tags: Vec::new(),
                status: "ready".into(),
                priority: "P2".into(),
                workflow_id: None,
                current_lane_id: None,
                assignee_type: "unassigned".into(),
                assignee_id: None,
                repository_id: None,
                repository_ids: Vec::new(),
                parent_task_id: None,
                whip_max_attempts: None,
                archived: Some(false),
            },
        )
        .expect("task should create")
        .id
    }

    fn seed_assignment(
        connection: &Connection,
        assignment_id: &str,
        task_id: &str,
        agent_id: &str,
        session_id: &str,
        now: &str,
    ) {
        connection
            .execute(
                "INSERT INTO task_lane_assignments (id, task_id, workflow_id, lane_id, worker_type, worker_id, status, session_id, runtime_cwd, role_queue_entry_id, role_instance_id, prompt, pending_outcome, completion_notes, whip_count, last_whip_at, started_at, completed_at, created_at, updated_at) VALUES (?1, ?2, 'workflow-1', 'lane-1', 'agent', ?3, 'active', ?4, '/tmp/runtime', NULL, NULL, 'Prompt', NULL, NULL, 0, NULL, ?5, NULL, ?5, ?5)",
                params![assignment_id, task_id, agent_id, session_id, now],
            )
            .expect("assignment should seed");
    }

    fn seed_delivery(
        connection: &Connection,
        delivery_id: &str,
        message_id: &str,
        project_id: &str,
        task_id: Option<&str>,
        sender_label: &str,
        recipient_type: &str,
        recipient_id: Option<&str>,
        recipient_label: &str,
        assignment_id: Option<&str>,
        now: &str,
    ) {
        connection
            .execute(
                "INSERT INTO mailbox_messages (id, project_id, task_id, sender_type, sender_id, sender_label, body, priority, created_at, updated_at) VALUES (?1, ?2, ?3, 'user', 'desktop-user', ?4, 'Hello', 'normal', ?5, ?5)",
                params![message_id, project_id, task_id, sender_label, now],
            )
            .expect("message should seed");
        connection
            .execute(
                "INSERT INTO mailbox_message_deliveries (id, message_id, recipient_type, recipient_id, recipient_label, assignment_id, read_at, read_session_id, last_notified_at, created_at, updated_at) VALUES (?1, ?2, ?3, ?4, ?5, ?6, NULL, NULL, NULL, ?7, ?7)",
                params![delivery_id, message_id, recipient_type, recipient_id, recipient_label, assignment_id, now],
            )
            .expect("delivery should seed");
    }

    #[test]
    fn rejects_unknown_project_ids_for_user_mail_queries() {
        let connection = open_test_connection("messages-project-validation");
        let error = list_user_messages(&connection, Some("project-missing"), false)
            .expect_err("unknown projects should be rejected");
        assert!(error.contains("Project project-missing was not found"));
    }

    #[test]
    fn rejects_unknown_project_ids_for_mail_sends() {
        let connection = open_test_connection("messages-send-validation");
        let sender = ResolvedSender {
            sender_type: "user".into(),
            sender_id: Some("desktop-user".into()),
            sender_label: "User".into(),
        };
        let error = resolve_project_id_for_send(
            &connection,
            &sender,
            None,
            &SendMailboxMessageInput {
                project_id: Some("project-missing".into()),
                task_id: None,
                recipient_type: "user".into(),
                recipient_id: None,
                sender_label: None,
                body: "hello".into(),
                priority: None,
            },
        )
        .expect_err("unknown projects should be rejected");
        assert!(error.contains("Project project-missing was not found"));
    }

    #[test]
    fn agent_send_defaults_to_current_session_project() {
        let connection = open_test_connection("messages-agent-send-session-project");
        let now = crate::state::now_iso();
        seed_agent(&connection, "agent-1", "Agent 1", &now);
        connection.execute(
            "INSERT INTO projects (id, slug, name, description, task_prefix, default_repository_id, created_at, updated_at) VALUES ('project-2', 'project-2', 'Project 2', NULL, 'P2', NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("secondary project should seed");
        connection.execute(
            "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('project-2', 'agent-1', 'idle', 'session-agent', '/tmp/runtime', NULL, NULL, NULL, ?1, ?1)",
            params![now.as_str()],
        ).expect("runtime state should seed");
        connection.execute(
            "INSERT INTO sessions (id, project_id, session_path, transcript_path, title, session_kind, session_status, list_visibility, first_seen_at, last_seen_at, agent_id, worker_type, worker_id, owner_worker_type, owner_worker_id, transcript_exists, lifecycle_state, created_at, updated_at) VALUES ('session-agent', 'orchestra', '/tmp/session-agent.jsonl', '/tmp/session-agent.jsonl', 'Agent Session', 'agent_main', 'active', 'active', ?1, ?1, 'agent-1', 'agent', 'agent-1', 'agent', 'agent-1', 0, 'active', ?1, ?1)",
            params![now.as_str()],
        ).expect("session row should seed");

        let sender = ResolvedSender {
            sender_type: "agent".into(),
            sender_id: Some("agent-1".into()),
            sender_label: "Agent 1".into(),
        };
        let project_id = resolve_project_id_for_send(
            &connection,
            &sender,
            Some("session-agent"),
            &SendMailboxMessageInput {
                project_id: None,
                task_id: None,
                recipient_type: "user".into(),
                recipient_id: None,
                sender_label: None,
                body: "hello".into(),
                priority: None,
            },
        )
        .expect("project id should resolve");

        assert_eq!(project_id, "orchestra");
    }

    #[test]
    fn unread_mail_scope_merges_agent_and_assignment_mail_and_marks_it_read() {
        let mut connection = open_test_connection("messages-unread");
        let now = crate::state::now_iso();
        seed_agent(&connection, "agent-1", "Agent 1", &now);
        let task_id = create_basic_task(&mut connection, "Mailbox runtime task");
        seed_assignment(
            &connection,
            "assignment-1",
            &task_id,
            "agent-1",
            "session-1",
            &now,
        );
        seed_delivery(
            &connection,
            "delivery-agent",
            "message-agent",
            "orchestra",
            Some(&task_id),
            "User",
            "agent",
            Some("agent-1"),
            "Agent 1",
            None,
            &now,
        );
        seed_delivery(
            &connection,
            "delivery-assignment",
            "message-assignment",
            "orchestra",
            Some(&task_id),
            "User",
            "assignment",
            Some("agent-1"),
            "Agent 1 · ORC-1",
            Some("assignment-1"),
            &now,
        );

        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: "agent-1".into(),
        };
        let unread = list_unread_mail_for_authorization(
            &connection,
            Some(&authorization),
            Some("session-1"),
            Some(&task_id),
        )
        .expect("unread mail should load");
        assert_eq!(unread.len(), 2);

        let read = mark_mail_read_for_authorization(
            &connection,
            Some(&authorization),
            Some("session-1"),
            Some(&task_id),
            None,
        )
        .expect("mail should mark read");
        assert_eq!(read.len(), 2);
        assert!(read
            .iter()
            .all(|message| message.read_session_id.as_deref() == Some("session-1")));

        let unread_after = list_unread_mail_for_authorization(
            &connection,
            Some(&authorization),
            Some("session-1"),
            Some(&task_id),
        )
        .expect("unread mail should reload");
        assert!(unread_after.is_empty());
    }

    #[test]
    fn direct_agent_mail_is_visible_even_when_message_project_differs_from_task_project() {
        let mut connection = open_test_connection("messages-cross-project-agent");
        let now = crate::state::now_iso();
        seed_agent(&connection, "agent-1", "Agent 1", &now);
        let task_id = create_basic_task(&mut connection, "Mailbox runtime task");
        seed_assignment(
            &connection,
            "assignment-1",
            &task_id,
            "agent-1",
            "session-1",
            &now,
        );
        seed_delivery(
            &connection,
            "delivery-agent-cross-project",
            "message-agent-cross-project",
            "other-project",
            None,
            "User",
            "agent",
            Some("agent-1"),
            "Agent 1",
            None,
            &now,
        );

        let authorization = AuthorizationContext {
            actor_type: "agent".into(),
            actor_id: "agent-1".into(),
        };
        let unread = list_unread_mail_for_authorization(
            &connection,
            Some(&authorization),
            Some("session-1"),
            Some(&task_id),
        )
        .expect("unread mail should load");
        assert_eq!(unread.len(), 1);
        assert_eq!(unread[0].delivery_id, "delivery-agent-cross-project");
    }

    #[test]
    fn direct_agent_mail_prompts_idle_agents_and_steers_running_agents() {
        let connection = open_test_connection("messages-agent-delivery-mode");
        let now = crate::state::now_iso();
        seed_agent(&connection, "agent-1", "Agent 1", &now);
        connection
            .execute(
                "INSERT INTO agent_runtime_states (project_id, agent_id, status, main_session_id, runtime_cwd, current_queue_entry_id, last_dispatch_at, last_error, created_at, updated_at) VALUES ('orchestra', 'agent-1', 'idle', 'session-1', '/tmp/runtime', NULL, NULL, NULL, ?1, ?1)",
                [&now],
            )
            .expect("idle runtime should seed");

        assert_eq!(
            resolve_agent_mail_delivery_mode(&connection, "orchestra", "agent-1")
                .expect("idle delivery mode should resolve"),
            "prompt"
        );

        connection
            .execute(
                "UPDATE agent_runtime_states SET status = 'running', current_queue_entry_id = 'queue-1', updated_at = ?1 WHERE project_id = 'orchestra' AND agent_id = 'agent-1'",
                [&now],
            )
            .expect("runtime should update");

        assert_eq!(
            resolve_agent_mail_delivery_mode(&connection, "orchestra", "agent-1")
                .expect("running delivery mode should resolve"),
            "steer"
        );
    }

    #[test]
    fn user_inbox_lists_and_marks_user_messages_read() {
        let connection = open_test_connection("messages-user-inbox");
        let now = crate::state::now_iso();
        seed_delivery(
            &connection,
            "delivery-user",
            "message-user",
            "orchestra",
            None,
            "Agent 1",
            "user",
            Some("desktop-user"),
            "User",
            None,
            &now,
        );

        let inbox = list_user_messages(&connection, Some("orchestra"), false)
            .expect("user inbox should load");
        assert_eq!(inbox.len(), 1);
        assert!(inbox[0].read_at.is_none());

        let read = mark_user_messages_read(&connection, Some(&["delivery-user".into()]))
            .expect("user inbox should mark read");
        assert_eq!(read.len(), 1);
        assert_eq!(read[0].read_session_id.as_deref(), Some("desktop-user"));

        let inbox_after = list_user_messages(&connection, Some("orchestra"), false)
            .expect("user inbox should reload");
        assert!(inbox_after[0].read_at.is_some());
    }

    #[test]
    fn user_inbox_can_archive_messages_and_show_them_when_requested() {
        let connection = open_test_connection("messages-user-archive");
        let now = crate::state::now_iso();
        seed_delivery(
            &connection,
            "delivery-user-archive",
            "message-user-archive",
            "orchestra",
            None,
            "Agent 1",
            "user",
            Some("desktop-user"),
            "User",
            None,
            &now,
        );

        let archived = archive_user_messages(&connection, Some(&["delivery-user-archive".into()]))
            .expect("user inbox should archive messages");
        assert_eq!(archived.len(), 1);
        assert!(archived[0].archived_at.is_some());

        let visible = list_user_messages(&connection, Some("orchestra"), false)
            .expect("unarchived inbox should load");
        assert!(visible.is_empty());

        let all_messages = list_user_messages(&connection, Some("orchestra"), true)
            .expect("archived inbox should load");
        assert_eq!(all_messages.len(), 1);
        assert!(all_messages[0].archived_at.is_some());
    }
}
