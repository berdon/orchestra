import type { MailboxMessage, NotificationIntent, TaskDetail } from "../types";

function truncateNotificationText(value: string, maxLength = 140) {
  const normalized = value.replace(/\s+/g, " ").trim();
  if (normalized.length <= maxLength) {
    return normalized;
  }
  return `${normalized.slice(0, maxLength - 1)}…`;
}

export function resolveNotificationProjectLabel(
  projects: Array<{ id: string; name: string }>,
  projectId?: string | null,
) {
  return projects.find((project) => project.id === projectId)?.name ?? "Orchestra";
}

function buildMailboxNotificationBody(message: MailboxMessage, projectLabel: string) {
  const taskLabel = message.taskNumber
    ? message.taskTitle
      ? `${message.taskNumber} · ${message.taskTitle}`
      : message.taskNumber
    : null;
  const summary = truncateNotificationText(message.body);
  const context = [projectLabel, message.senderLabel, taskLabel].filter(Boolean).join(" · ");
  return summary ? `${context}\n${summary}` : context;
}

function buildTaskAttentionNotificationBody(task: TaskDetail, projectLabel: string, reason: NotificationIntent["eventType"]) {
  const headline = `${projectLabel} · ${task.number} · ${task.title}`;
  const notes = task.activeLaneAssignment?.completionNotes
    ? truncateNotificationText(task.activeLaneAssignment.completionNotes)
    : "";
  const action = reason === "task.awaiting_user_approval"
    ? "Open Orchestra to approve the lane or send it back for more work."
    : reason === "task.awaiting_user_intervention"
      ? "Open Orchestra to review the blocker and decide how to proceed."
      : "Open Orchestra to review the task and continue the workflow.";
  return [headline, notes || action].filter(Boolean).join("\n");
}

export function buildMailboxNotificationIntent(
  message: MailboxMessage,
  projectLabel: string,
): NotificationIntent {
  return {
    id: `notification-mailbox-${message.deliveryId}`,
    eventType: "mailbox.message_received",
    title: "Orchestra — New message",
    body: buildMailboxNotificationBody(message, projectLabel),
    tag: `mailbox:${message.deliveryId}`,
    projectId: message.projectId,
    taskId: message.taskId ?? null,
    deliveryId: message.deliveryId,
    action: {
      type: "open_inbox",
      taskId: message.taskId ?? null,
      target: null,
    },
    occurredAt: message.createdAt,
  };
}

export function buildTaskAttentionNotificationIntent(
  task: TaskDetail,
  reason: Extract<NotificationIntent["eventType"], "task.awaiting_user_approval" | "task.awaiting_user_intervention" | "task.assigned_to_user">,
  projectLabel?: string,
): NotificationIntent {
  return {
    id: `notification-task-${reason}-${task.id}-${task.updatedAt}`,
    eventType: reason,
    title: reason === "task.awaiting_user_approval"
      ? "Orchestra — Approval needed"
      : reason === "task.awaiting_user_intervention"
        ? "Orchestra — User intervention needed"
        : "Orchestra — Task assigned to you",
    body: buildTaskAttentionNotificationBody(
      task,
      projectLabel ?? "Orchestra",
      reason,
    ),
    tag: `task-attention:${reason}:${task.id}`,
    projectId: task.projectId,
    taskId: task.id,
    deliveryId: null,
    action: {
      type: "open_task",
      taskId: task.id,
      target: reason === "task.awaiting_user_approval" ? "review" : "details",
    },
    occurredAt: task.updatedAt,
  };
}

export function applyProjectLabelToTaskIntent(
  intent: NotificationIntent,
  task: TaskDetail,
  projectLabel: string,
): NotificationIntent {
  if (!intent.eventType.startsWith("task.")) {
    return intent;
  }
  return {
    ...intent,
    body: buildTaskAttentionNotificationBody(task, projectLabel, intent.eventType),
  };
}
