import { useEffect, useMemo, useState } from "react";

import { listAgents } from "../lib/agents";
import {
  listInboxMessages,
  listenToInboxChanges,
  listenToTaskChanges,
  markMailboxMessagesRead,
  sendMailboxMessage,
} from "../lib/tauri";
import { listTasks } from "../lib/tauri";
import type { AgentSummary, MailboxMessage, TaskSummary } from "../types";

interface InboxPageProps {
  projectId?: string | null;
  onOpenTask: (taskId: string) => void;
}

function summarizeAttentionReason(task: TaskSummary) {
  if (task.status === "in_review") {
    return "Waiting for review or approval.";
  }
  if (task.status === "blocked") {
    return "Blocked and needs user attention.";
  }
  if (task.dependencyBlocked) {
    return "Blocked by unresolved dependencies.";
  }
  return "Needs attention.";
}

export function InboxPage({ projectId = null, onOpenTask }: InboxPageProps) {
  const [messages, setMessages] = useState<MailboxMessage[]>([]);
  const [tasks, setTasks] = useState<TaskSummary[]>([]);
  const [agents, setAgents] = useState<AgentSummary[]>([]);
  const [sending, setSending] = useState(false);
  const [markingRead, setMarkingRead] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedAgentId, setSelectedAgentId] = useState("");
  const [selectedTaskId, setSelectedTaskId] = useState("");
  const [messageBody, setMessageBody] = useState("");
  const [interruptPriority, setInterruptPriority] = useState(false);
  const [composeOpen, setComposeOpen] = useState(false);

  const attentionTasks = useMemo(
    () => tasks.filter((task) => task.status === "in_review" || task.status === "blocked" || task.dependencyBlocked),
    [tasks],
  );

  async function loadData() {
    const [nextMessages, nextTasks, nextAgents] = await Promise.all([
      listInboxMessages(projectId),
      listTasks(false, projectId),
      listAgents(false),
    ]);
    setMessages(nextMessages);
    setTasks(nextTasks);
    setAgents(nextAgents);
    setSelectedAgentId((current) => current || nextAgents[0]?.id || "");
  }

  useEffect(() => {
    void loadData().catch((nextError) => {
      setError(nextError instanceof Error ? nextError.message : "Unable to load Inbox.");
    });
  }, [projectId]);

  useEffect(() => {
    let disposed = false;
    let stopInbox = () => {};
    let stopTasks = () => {};

    void listenToInboxChanges(() => {
      if (!disposed) {
        void loadData();
      }
    }).then((dispose) => {
      stopInbox = dispose;
    });

    void listenToTaskChanges(() => {
      if (!disposed) {
        void loadData();
      }
    }).then((dispose) => {
      stopTasks = dispose;
    });

    return () => {
      disposed = true;
      stopInbox();
      stopTasks();
    };
  }, [projectId]);

  async function handleSend() {
    if (!selectedAgentId || !messageBody.trim()) {
      return;
    }

    setSending(true);
    setError(null);
    try {
      await sendMailboxMessage({
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
      await loadData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to send message.");
    } finally {
      setSending(false);
    }
  }

  async function handleMarkRead(deliveryId?: string) {
    setMarkingRead(deliveryId ?? "all");
    setError(null);
    try {
      await markMailboxMessagesRead({ deliveryIds: deliveryId ? [deliveryId] : undefined });
      await loadData();
    } catch (nextError) {
      setError(nextError instanceof Error ? nextError.message : "Unable to mark messages read.");
    } finally {
      setMarkingRead(null);
    }
  }

  const unreadCount = messages.filter((message) => !message.readAt).length;

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
              <span className="status-badge status-badge--neutral" data-role="inbox-unread-count">{unreadCount} unread</span>
              <button
                className="secondary-button"
                data-role="open-inbox-compose"
                type="button"
                onClick={() => setComposeOpen((current) => !current)}
              >
                {composeOpen ? "Hide compose" : "Compose"}
              </button>
              <button
                className="secondary-button"
                data-role="mark-all-inbox-read"
                type="button"
                disabled={!unreadCount || markingRead === "all"}
                onClick={() => void handleMarkRead()}
              >
                Mark all read
              </button>
            </div>
          </div>

          {error ? <p className="error-copy">{error}</p> : null}

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
              <label className="checkbox-field task-editor-grid__full">
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
            {messages.length ? messages.map((message) => (
              <article className="task-history-card" key={message.deliveryId}>
                <div className="workflow-section__header">
                  <div>
                    <strong>{message.senderLabel}</strong>
                    <p className="muted-copy">to {message.recipientLabel}</p>
                  </div>
                  <div className="action-cluster">
                    {!message.readAt ? <span className="status-badge status-badge--warning">Unread</span> : <span className="status-badge status-badge--neutral">Read</span>}
                    <button className="secondary-button" data-role={`mark-inbox-read-${message.deliveryId}`} type="button" disabled={Boolean(message.readAt) || markingRead === message.deliveryId} onClick={() => void handleMarkRead(message.deliveryId)}>
                      Mark read
                    </button>
                  </div>
                </div>
                {message.taskId ? (
                  <button className="text-button" data-role={`open-inbox-task-${message.taskId}`} type="button" onClick={() => onOpenTask(message.taskId!)}>
                    {message.taskNumber ?? message.taskId} · {message.taskTitle ?? "Open related task"}
                  </button>
                ) : null}
                <p className="pre-wrap" data-role="inbox-message-body">{message.body}</p>
              </article>
            )) : <p className="muted-copy">No user messages yet.</p>}
          </div>
        </section>

        <section className="task-board-section task-section--compact" data-role="inbox-attention-tasks">
          <div className="task-board-section__header">
            <div>
              <p className="eyebrow">Workflow attention</p>
              <h3>Review & intervention requests</h3>
            </div>
            <span className="status-badge status-badge--neutral">{attentionTasks.length}</span>
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
