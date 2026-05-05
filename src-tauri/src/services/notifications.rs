use tauri::AppHandle;

use rusqlite::Connection;

use crate::{
    models::{
        MailboxMessage, NotificationAction, NotificationActionTarget, NotificationActionType,
        NotificationEventType, NotificationIntent, TaskDetail, WorkflowLane,
    },
    services::{app_events, channels, projects, web_push},
};

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationAdapter {
    Telegram,
    Local,
    WebPush,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum NotificationDeliveryStatus {
    Delivered,
    Suppressed,
    Failed,
}

#[derive(Debug, Clone, PartialEq, Eq)]
struct NotificationDeliveryOutcome {
    adapter: NotificationAdapter,
    status: NotificationDeliveryStatus,
    detail: Option<String>,
}

fn truncate_notification_text(value: &str, max_length: usize) -> String {
    let normalized = value.split_whitespace().collect::<Vec<_>>().join(" ");
    if normalized.chars().count() <= max_length {
        return normalized;
    }
    normalized
        .chars()
        .take(max_length.saturating_sub(1))
        .collect::<String>()
        + "…"
}

fn build_mailbox_notification_body(message: &MailboxMessage, project_label: &str) -> String {
    let task_label = match (
        message.task_number.as_deref(),
        message.task_title.as_deref(),
    ) {
        (Some(number), Some(title)) => Some(format!("{number} · {title}")),
        (Some(number), None) => Some(number.to_string()),
        _ => None,
    };
    let summary = truncate_notification_text(&message.body, 140);
    let context = [
        Some(project_label.to_string()),
        Some(message.sender_label.clone()),
        task_label,
    ]
    .into_iter()
    .flatten()
    .collect::<Vec<_>>()
    .join(" · ");
    if summary.is_empty() {
        context
    } else {
        format!("{context}\n{summary}")
    }
}

fn build_task_attention_notification_body(
    task: &TaskDetail,
    project_label: &str,
    event_type: NotificationEventType,
    notes: Option<&str>,
) -> String {
    let headline = format!("{project_label} · {} · {}", task.number, task.title);
    let notes = notes
        .map(|value| truncate_notification_text(value, 140))
        .filter(|value| !value.is_empty())
        .or_else(|| {
            task.active_lane_assignment
                .as_ref()
                .and_then(|assignment| assignment.completion_notes.as_deref())
                .map(|value| truncate_notification_text(value, 140))
                .filter(|value| !value.is_empty())
        });
    let action = match event_type {
        NotificationEventType::TaskAwaitingUserApproval => {
            "Open Orchestra to approve the lane or send it back for more work."
        }
        NotificationEventType::TaskAwaitingUserIntervention => {
            "Open Orchestra to review the blocker and decide how to proceed."
        }
        NotificationEventType::TaskAssignedToUser => {
            "Open Orchestra to review the task and continue the workflow."
        }
        NotificationEventType::MailboxMessageReceived => {
            "Open Orchestra to review the latest update."
        }
    };
    [Some(headline), notes, Some(action.to_string())]
        .into_iter()
        .flatten()
        .take(2)
        .collect::<Vec<_>>()
        .join("\n")
}

pub fn build_mailbox_notification_intent(
    connection: &Connection,
    message: &MailboxMessage,
) -> Result<NotificationIntent, String> {
    let project = projects::get_project(connection, &message.project_id)?;
    Ok(NotificationIntent {
        id: format!("notification-mailbox-{}", message.delivery_id),
        event_type: NotificationEventType::MailboxMessageReceived,
        title: "Orchestra — New message".into(),
        body: build_mailbox_notification_body(message, &project.name),
        tag: format!("mailbox:{}", message.delivery_id),
        project_id: Some(message.project_id.clone()),
        task_id: message.task_id.clone(),
        delivery_id: Some(message.delivery_id.clone()),
        action: Some(NotificationAction {
            r#type: NotificationActionType::OpenInbox,
            task_id: message.task_id.clone(),
            target: None,
        }),
        occurred_at: message.created_at.clone(),
    })
}

pub fn build_task_attention_notification_intent(
    connection: &Connection,
    task: &TaskDetail,
    reason: &str,
    notes: Option<&str>,
) -> Result<NotificationIntent, String> {
    let project = projects::get_project(connection, &task.project_id)?;
    let event_type = match reason {
        "awaiting_user_approval" => NotificationEventType::TaskAwaitingUserApproval,
        "awaiting_user_intervention" | "needs_user" => {
            NotificationEventType::TaskAwaitingUserIntervention
        }
        "assigned_to_user" => NotificationEventType::TaskAssignedToUser,
        other => {
            return Err(format!(
                "Unsupported task attention notification reason: {other}"
            ))
        }
    };
    let title = match event_type {
        NotificationEventType::TaskAwaitingUserApproval => "Orchestra — Approval needed",
        NotificationEventType::TaskAwaitingUserIntervention => {
            "Orchestra — User intervention needed"
        }
        NotificationEventType::TaskAssignedToUser => "Orchestra — Task assigned to you",
        NotificationEventType::MailboxMessageReceived => "Orchestra — Notification",
    };
    let target = match event_type {
        NotificationEventType::TaskAwaitingUserApproval => Some(NotificationActionTarget::Review),
        NotificationEventType::TaskAwaitingUserIntervention
        | NotificationEventType::TaskAssignedToUser => Some(NotificationActionTarget::Details),
        NotificationEventType::MailboxMessageReceived => None,
    };

    Ok(NotificationIntent {
        id: format!(
            "notification-task-{}-{}-{}",
            match event_type {
                NotificationEventType::TaskAwaitingUserApproval => "task.awaiting_user_approval",
                NotificationEventType::TaskAwaitingUserIntervention => {
                    "task.awaiting_user_intervention"
                }
                NotificationEventType::TaskAssignedToUser => "task.assigned_to_user",
                NotificationEventType::MailboxMessageReceived => "mailbox.message_received",
            },
            task.id,
            task.updated_at
        ),
        event_type,
        title: title.into(),
        body: build_task_attention_notification_body(task, &project.name, event_type, notes),
        tag: format!(
            "task-attention:{}:{}",
            match event_type {
                NotificationEventType::TaskAwaitingUserApproval => "task.awaiting_user_approval",
                NotificationEventType::TaskAwaitingUserIntervention => {
                    "task.awaiting_user_intervention"
                }
                NotificationEventType::TaskAssignedToUser => "task.assigned_to_user",
                NotificationEventType::MailboxMessageReceived => "mailbox.message_received",
            },
            task.id
        ),
        project_id: Some(task.project_id.clone()),
        task_id: Some(task.id.clone()),
        delivery_id: None,
        action: Some(NotificationAction {
            r#type: NotificationActionType::OpenTask,
            task_id: Some(task.id.clone()),
            target,
        }),
        occurred_at: task.updated_at.clone(),
    })
}

fn dispatch_notification_intent_with<TelegramDispatch, LocalDispatch, WebPushDispatch>(
    intent: &NotificationIntent,
    dispatch_telegram: TelegramDispatch,
    dispatch_local: LocalDispatch,
    dispatch_web_push: WebPushDispatch,
) -> Vec<NotificationDeliveryOutcome>
where
    TelegramDispatch: FnOnce(&NotificationIntent) -> Result<bool, String>,
    LocalDispatch: FnOnce(&NotificationIntent) -> Result<bool, String>,
    WebPushDispatch: FnOnce(&NotificationIntent) -> Result<bool, String>,
{
    let mut outcomes = Vec::new();

    match dispatch_telegram(intent) {
        Ok(true) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::Telegram,
            status: NotificationDeliveryStatus::Delivered,
            detail: None,
        }),
        Ok(false) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::Telegram,
            status: NotificationDeliveryStatus::Suppressed,
            detail: None,
        }),
        Err(error) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::Telegram,
            status: NotificationDeliveryStatus::Failed,
            detail: Some(error),
        }),
    }

    match dispatch_local(intent) {
        Ok(true) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::Local,
            status: NotificationDeliveryStatus::Delivered,
            detail: None,
        }),
        Ok(false) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::Local,
            status: NotificationDeliveryStatus::Suppressed,
            detail: None,
        }),
        Err(error) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::Local,
            status: NotificationDeliveryStatus::Failed,
            detail: Some(error),
        }),
    }

    match dispatch_web_push(intent) {
        Ok(true) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::WebPush,
            status: NotificationDeliveryStatus::Delivered,
            detail: None,
        }),
        Ok(false) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::WebPush,
            status: NotificationDeliveryStatus::Suppressed,
            detail: None,
        }),
        Err(error) => outcomes.push(NotificationDeliveryOutcome {
            adapter: NotificationAdapter::WebPush,
            status: NotificationDeliveryStatus::Failed,
            detail: Some(error),
        }),
    }

    outcomes
}

fn dispatch_notification_intent(
    app: Option<&AppHandle>,
    connection: &Connection,
    intent: &NotificationIntent,
) -> Vec<NotificationDeliveryOutcome> {
    dispatch_notification_intent_with(
        intent,
        |intent| {
            channels::deliver_telegram_notification_intent(connection, intent)
                .map(|delivered| delivered > 0)
        },
        |intent| match app {
            Some(app) => app_events::emit_notification_intent(app, intent).map(|_| true),
            None => Ok(false),
        },
        |intent| match app {
            Some(app) => web_push::deliver_remote_web_push_notification(app, connection, intent),
            None => Ok(false),
        },
    )
}

pub fn publish_mailbox_notification(
    app: Option<&AppHandle>,
    connection: &Connection,
    message: &MailboxMessage,
) -> Result<Option<NotificationIntent>, String> {
    if message.recipient_type != "user" {
        return Ok(None);
    }

    let intent = build_mailbox_notification_intent(connection, message)?;
    let _ = dispatch_notification_intent(app, connection, &intent);
    Ok(Some(intent))
}

pub fn publish_task_attention_notification(
    app: Option<&AppHandle>,
    connection: &Connection,
    task: &TaskDetail,
    _lane: &WorkflowLane,
    reason: &str,
    notes: Option<&str>,
) -> Result<NotificationIntent, String> {
    let intent = build_task_attention_notification_intent(connection, task, reason, notes)?;
    let _ = dispatch_notification_intent(app, connection, &intent);
    Ok(intent)
}

#[cfg(test)]
mod tests {
    use super::{
        build_mailbox_notification_body, build_task_attention_notification_body,
        dispatch_notification_intent_with, NotificationAdapter, NotificationDeliveryStatus,
    };
    use crate::models::{MailboxMessage, NotificationEventType, TaskDetail, TaskLaneAssignment};

    fn fixture_mailbox_message() -> MailboxMessage {
        MailboxMessage {
            delivery_id: "delivery-1".into(),
            message_id: "message-1".into(),
            project_id: "project-1".into(),
            task_id: Some("task-1".into()),
            task_number: Some("ORC-1".into()),
            task_title: Some("Implement notifications".into()),
            sender_type: "agent".into(),
            sender_id: Some("agent-reviewer".into()),
            sender_label: "Reviewer".into(),
            recipient_type: "user".into(),
            recipient_id: Some("user-1".into()),
            recipient_label: "User".into(),
            assignment_id: None,
            body: "Please review the latest runtime output before approving the lane.".into(),
            priority: "interrupt".into(),
            read_at: None,
            read_session_id: None,
            archived_at: None,
            last_notified_at: None,
            created_at: "2026-04-24T00:00:00Z".into(),
            updated_at: "2026-04-24T00:00:00Z".into(),
        }
    }

    fn fixture_task() -> TaskDetail {
        TaskDetail {
            id: "task-1".into(),
            number: "ORC-1".into(),
            title: "Implement notifications".into(),
            description: None,
            task_type: "task".into(),
            status: "in_review".into(),
            priority: "P1".into(),
            workflow_id: Some("workflow-1".into()),
            current_lane_id: Some("lane-review".into()),
            assignee_type: "user".into(),
            assignee_id: None,
            repository_id: None,
            repository_ids: vec![],
            parent_task_id: None,
            whip_max_attempts: 10,
            archived: false,
            comment_count: 0,
            unread_comment_count: 0,
            lane_run_count: 0,
            child_count: 0,
            completed_child_count: 0,
            in_progress_child_count: 0,
            blocked_child_count: 0,
            blocked_by_count: 0,
            blocking_count: 0,
            attachment_count: 0,
            dependency_blocked: false,
            active_lane_assignment_status: Some("awaiting_user_approval".into()),
            ready_for_dispatch: false,
            tags: vec![],
            created_at: "2026-04-24T00:00:00Z".into(),
            updated_at: "2026-04-24T00:00:00Z".into(),
            project_id: "project-1".into(),
            parent: None,
            lineage: vec![],
            children: vec![],
            blocked_by: vec![],
            blocking: vec![],
            attachments: vec![],
            task_repositories: vec![],
            file_references: vec![],
            comments: vec![],
            todos: vec![],
            lane_runs: vec![],
            active_lane_assignment: Some(TaskLaneAssignment {
                id: "assignment-1".into(),
                task_id: "task-1".into(),
                workflow_id: "workflow-1".into(),
                lane_id: "lane-review".into(),
                worker_type: "agent".into(),
                worker_id: Some("agent-1".into()),
                status: "awaiting_user_approval".into(),
                session_id: Some("session-1".into()),
                runtime_cwd: None,
                role_queue_entry_id: None,
                role_instance_id: None,
                prompt: None,
                pending_outcome: Some("success".into()),
                completion_notes: Some("Please verify the lane output before approving.".into()),
                whip_count: 0,
                last_whip_at: None,
                started_at: "2026-04-24T00:00:00Z".into(),
                completed_at: None,
                created_at: "2026-04-24T00:00:00Z".into(),
                updated_at: "2026-04-24T00:00:00Z".into(),
            }),
        }
    }

    #[test]
    fn mailbox_notification_body_includes_context_and_summary() {
        let body = build_mailbox_notification_body(&fixture_mailbox_message(), "Orchestra");
        assert!(body.contains("Orchestra · Reviewer · ORC-1 · Implement notifications"));
        assert!(body.contains("Please review the latest runtime output"));
    }

    #[test]
    fn task_attention_body_prefers_completion_notes() {
        let task = fixture_task();
        let body = build_task_attention_notification_body(
            &task,
            "Orchestra",
            NotificationEventType::TaskAwaitingUserApproval,
            None,
        );
        assert!(body.contains("ORC-1 · Implement notifications"));
        assert!(body.contains("Please verify the lane output before approving."));
    }

    #[test]
    fn task_assigned_to_user_body_uses_user_handoff_copy() {
        let task = fixture_task();
        let body = build_task_attention_notification_body(
            &task,
            "Orchestra",
            NotificationEventType::TaskAssignedToUser,
            None,
        );
        assert!(body.contains("ORC-1 · Implement notifications"));
        assert!(body.contains("Please verify the lane output before approving."));
    }

    #[test]
    fn dispatch_fans_out_when_one_adapter_fails() {
        let outcomes = dispatch_notification_intent_with(
            &crate::models::NotificationIntent {
                id: "intent-1".into(),
                event_type: NotificationEventType::MailboxMessageReceived,
                title: "Title".into(),
                body: "Body".into(),
                tag: "tag".into(),
                project_id: Some("project-1".into()),
                task_id: None,
                delivery_id: Some("delivery-1".into()),
                action: None,
                occurred_at: "2026-04-24T00:00:00Z".into(),
            },
            |_| Err("telegram failed".into()),
            |_| Ok(true),
            |_| Ok(false),
        );

        assert_eq!(outcomes.len(), 3);
        assert_eq!(outcomes[0].adapter, NotificationAdapter::Telegram);
        assert_eq!(outcomes[0].status, NotificationDeliveryStatus::Failed);
        assert_eq!(outcomes[1].adapter, NotificationAdapter::Local);
        assert_eq!(outcomes[1].status, NotificationDeliveryStatus::Delivered);
        assert_eq!(outcomes[2].adapter, NotificationAdapter::WebPush);
        assert_eq!(outcomes[2].status, NotificationDeliveryStatus::Suppressed);
    }

    #[test]
    fn dispatch_records_suppressed_adapters() {
        let outcomes = dispatch_notification_intent_with(
            &crate::models::NotificationIntent {
                id: "intent-2".into(),
                event_type: NotificationEventType::TaskAwaitingUserIntervention,
                title: "Title".into(),
                body: "Body".into(),
                tag: "tag".into(),
                project_id: Some("project-1".into()),
                task_id: Some("task-1".into()),
                delivery_id: None,
                action: None,
                occurred_at: "2026-04-24T00:00:00Z".into(),
            },
            |_| Ok(false),
            |_| Ok(false),
            |_| Ok(false),
        );

        assert!(outcomes
            .iter()
            .all(|outcome| outcome.status == NotificationDeliveryStatus::Suppressed));
    }
}
