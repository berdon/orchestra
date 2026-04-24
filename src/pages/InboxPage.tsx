import { useEffect, useMemo, useState } from "react";

import { ResourceStatusBanner } from "../components/ResourceStatusBanner";
import { reportUiError } from "../lib/orchestraData/errors";
import { useInboxData } from "../lib/orchestraData/inbox";
import { useOrchestraClient } from "../lib/orchestraClient";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { TaskSummary } from "../types";

interface InboxPageProps {
  projectId?: string | null;
  onOpenTask: (taskId: string) => void;
}

type InboxMailFilter = "all" | "unread" | "read";

function summarizeAttentionReason(task: TaskSummary) {
  if (task.status === "in_review") {
    return "Waiting for review or approval.";
  }
  if (task.status === "blocked") {
    return "Blocked and needs user attention.";
  }
  if (task.dependencyBlocked) {
    return "Blocked by unresolved dependencies or unfinished subtasks.";
  }
  return "Needs attention.";
}

export function InboxPage({ projectId = null, onOpenTask }: InboxPageProps) {
  const orchestraClient = useOrchestraClient();
  const getTooltipProps = useExplanatoryTooltipProps();
  const {
    agents,
    connection,
    error,
    loading,
    messages,
    refresh,
    refreshing,
    retry,
    setError,
    tasks,
  } = useInboxData(projectId);
  const [sending, setSending] = useState(false);
  const [markingRead, setMarkingRead] = useState<string | null>(null);
  const [archiving, setArchiving] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [interruptPriority, setInterruptPriority] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);
  const [mailFilter, setMailFilter] = useState<InboxMailFilter>("all");
  const [showArchived, setShowArchived] = useState(false);

  useEffect(() => {
    setSelectedAgentId((current) => current || agents[0]?.id || "");
  }, [agents]);

  const attentionTasks = useMemo(
    () => tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked),
    [tasks],
  );

  const filteredMessages = useMemo(() => messages.filter((message) => {
    if (!showArchived && message.archivedAt) {
      return false;
    }
    if (mailFilter === "unread") {
      return !message.readAt;
    }
    if (mailFilter === "read") {
      return Boolean(message.readAt);
    }
    return true;
  }), [mailFilter, messages, showArchived]);

  async function handleSend() {
    if (!selectedAgentId || !messageBody.trim()) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      await orchestraClient.inbox.send({
        projectId,
        taskId: selectedTaskId || null,
        recipientType: "agent",
        recipientId: selectedAgentId,
        body: messageBody,
        priority: interruptPriority ? "interrupt" : "normal",
      });
      setMessageBody("");
      setInterruptPriority(false);
      setComposeOpen(false);
      await refresh({ silent: true });
    } catch (nextError) {
      setError(await reportUiError(orchestraClient, "ui.inbox.send", nextError, "Unable to send message."));
    } finally {
      setSending(false);
    }
  }

  async function handleMarkRead(deliveryId?: string) {
    setMarkingRead(deliveryId ?? "all");
    setError(null);
    try {
      await orchestraClient.inbox.markRead({ deliveryIds: deliveryId ? [deliveryId] : undefined });
      await refresh({ silent: true });
    } catch (nextError) {
      setError(await reportUiError(orchestraClient, "ui.inbox.mark_read", nextError, "Unable to mark messages read."));
    } finally {
      setMarkingRead(null);
    }
  }

  async function handleArchive(deliveryId: string) {
    setArchiving(deliveryId);
    setError(null);
    try {
      await orchestraClient.inbox.archive({ deliveryIds: [deliveryId] });
      await refresh({ silent: true });
    } catch (nextError) {
      setError(await reportUiError(orchestraClient, "ui.inbox.archive", nextError, "Unable to archive message."));
    } finally {
      setArchiving(null);
    }
  }

  const unreadCount = messages.filter((message) => !message.readAt && !message.archivedAt).length;

  return (
    <section className="tasks-overview-page">
      <section className="tasks-overview-stack">
        <section className="task-board-section">
          <div className="task-board-section__header">
            <div>
              <p className="eyebrow">Mailbox</p>
              <h3>User Inbox</h3>
            </div>
            <div className="action-cluster">
              <span className="status-badge status-badge--neutral status-badge--compact" data-role="inbox-unread-count">{unreadCount} unread</span>
              <button
                className="secondary-button"
                data-role="open-inbox-compose"
                type="button"
                {...getTooltipProps("Write a mailbox message to an agent from the user inbox.")}
                onClick={() => setComposeOpen((current) => !current)}
              >
                {composeOpen ? "Hide compose" : "Compose"}
              </button>
              <button
                className="secondary-button"
                data-role="mark-all-inbox-read"
                type="button"
                disabled={!unreadCount || markingRead === "all"}
                {...getTooltipProps("Mark every visible unread inbox message as read.")}
                onClick={() => void handleMarkRead()}
              >
                Mark all read
              </button>
            </div>
          </div>

          <ResourceStatusBanner
            connection={connection}
            error={error}
            hasData={messages.length > 0 || tasks.length > 0}
            refreshing={refreshing}
            onRetry={() => void retry()}
            retryLabel="Retry Inbox"
            refreshingLabel="Refreshing Inbox…"
            dataRolePrefix="inbox-status"
          />
          {loading && messages.length === 0 && tasks.length === 0 ? <p className="muted-copy">Loading Inbox…</p> : null}

          <div className="filter-chip-row" role="tablist" aria-label="Inbox mail filters">
            {([
              ["all", "All mail"],
              ["unread", "Unread"],
              ["read", "Read"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={mailFilter === value ? "filter-chip filter-chip--active" : "filter-chip"}
                data-role={`inbox-filter-${value}`}
                type="button"
                onClick={() => setMailFilter(value)}
              >
                {label}
              </button>
            ))}
            <button
              className={showArchived ? "filter-chip filter-chip--active" : "filter-chip"}
              data-role="inbox-filter-archived"
              type="button"
              onClick={() => setShowArchived((current) => !current)}
            >
              {showArchived ? "Hide archived" : "Show archived"}
            </button>
          </div>

          {composeOpen ? (
            <div className="task-editor-grid" data-role="inbox-compose-panel">
              <label className="field-group">
                <span className="field-group__label">Send to agent</span>
                <select className="text-input" data-role="inbox-compose-agent" value={selectedAgentId} onChange={(event) => setSelectedAgentId(event.target.value)}>
                  {agents.map((agent) => (
                    <option key={agent.id} value={agent.id}>{agent.name}</option>
                  ))}
                </select>
              </label>
              <label className="field-group">
                <span className="field-group__label">Related task</span>
                <select className="text-input" data-role="inbox-compose-task" value={selectedTaskId} onChange={(event) => setSelectedTaskId(event.target.value)}>
                  <option value="">None</option>
                  {tasks.map((task) => (
                    <option key={task.id} value={task.id}>{task.number} · {task.title}</option>
                  ))}
                </select>
              </label>
              <label className="field-group task-editor-grid__full">
                <span className="field-group__label">Message</span>
                <textarea className="text-area" data-role="inbox-compose-body" rows={4} value={messageBody} onChange={(event) => setMessageBody(event.target.value)} />
              </label>
              <label className="checkbox-field task-editor-grid__full" {...getTooltipProps("Send this as an interrupt instead of a normal mailbox delivery.")}>
                <input data-role="inbox-compose-interrupt" type="checkbox" checked={interruptPriority} onChange={(event) => setInterruptPriority(event.target.checked)} />
                <span>Interrupt recipient</span>
              </label>
              <div className="task-editor-grid__full action-cluster">
                <button className="primary-button" data-role="send-inbox-message" type="button" disabled={sending || !selectedAgentId || !messageBody.trim()} onClick={() => void handleSend()}>
                  {sending ? "Sending…" : "Send message"}
                </button>
                <button className="secondary-button" data-role="cancel-inbox-compose" type="button" disabled={sending} onClick={() => setComposeOpen(false)}>
                  Cancel
                </button>
              </div>
            </div>
          ) : null}

          <div className="task-section-list" data-role="user-inbox-messages">
            {filteredMessages.length ? filteredMessages.map((message) => (
              <article className="task-history-card" key={message.deliveryId}>
                <div className="workflow-section__header">
                  <div>
                    <strong>{message.senderLabel}</strong>
                    <p className="muted-copy">to {message.recipientLabel}</p>
                  </div>
                  <div className="action-cluster">
                    {message.archivedAt ? <span className="status-badge status-badge--neutral status-badge--compact">Archived</span> : null}
                    {!message.readAt ? <span className="status-badge status-badge--warning status-badge--compact">Unread</span> : <span className="status-badge status-badge--neutral status-badge--compact">Read</span>}
                    <button className="secondary-button" data-role={`mark-inbox-read-${message.deliveryId}`} type="button" disabled={Boolean(message.readAt) || markingRead === message.deliveryId} onClick={() => void handleMarkRead(message.deliveryId)}>
                      Mark read
                    </button>
                    {!message.archivedAt ? (
                      <button className="secondary-button" data-role={`archive-inbox-message-${message.deliveryId}`} type="button" disabled={archiving === message.deliveryId} onClick={() => void handleArchive(message.deliveryId)}>
                        {archiving === message.deliveryId ? "Archiving…" : "Archive"}
                      </button>
                    ) : null}
                  </div>
                </div>
                {message.taskId ? (
                  <button className="text-button" data-role={`open-inbox-task-${message.taskId}`} type="button" onClick={() => onOpenTask(message.taskId!)}>
                    {message.taskNumber ?? message.taskId} · {message.taskTitle ?? "Open related task"}
                  </button>
                ) : null}
                <p className="pre-wrap" data-role="inbox-message-body">{message.body}</p>
              </article>
            )) : <p className="muted-copy">No {showArchived ? "matching" : "active"} user messages right now.</p>}
          </div>
        </section>

        <section className="task-board-section task-section--compact" data-role="inbox-attention-tasks">
          <div className="task-board-section__header">
            <div>
              <p className="eyebrow">Workflow attention</p>
              <h3>Review & intervention requests</h3>
            </div>
            <span className="status-badge status-badge--neutral status-badge--compact">{attentionTasks.length}</span>
          </div>
          <div className="task-section-list">
            {attentionTasks.length ? attentionTasks.map((task) => (
              <article className="task-history-card" key={task.id}>
                <div className="workflow-section__header">
                  <strong>{task.number} · {task.title}</strong>
                  <span className={`status-badge status-badge--${task.status === "blocked" ? "error" : "warning"}`}>{task.status.replace(/_/g, " ")}</span>
                </div>
                <p className="muted-copy">{summarizeAttentionReason(task)}</p>
                <button className="secondary-button" data-role={`open-attention-task-${task.id}`} type="button" onClick={() => onOpenTask(task.id)}>
                  Open task
                </button>
              </article>
            )) : <p className="muted-copy">No review or intervention requests right now.</p>}
          </div>
        </section>
      </section>
    </section>
  );
}
