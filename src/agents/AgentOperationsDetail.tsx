import { useMemo, useState } from "react";

import type { AgentOperationsDetail } from "../types";

type AgentWorkFilter = "queued" | "active" | "completed";

interface AgentOperationsDetailProps {
  detail: AgentOperationsDetail;
  onOpenSession: (agentId: string) => void;
  onOpenSessionTerminal: (agentId: string) => void;
  onDeleteQueuedEntry: (entry: AgentOperationsDetail["queueEntries"][number]) => void;
  onCancelActiveWorkflowEntry: (entry: AgentOperationsDetail["queueEntries"][number], requeue: boolean) => void;
  supportsTerminal?: boolean;
  busy?: boolean;
}

function formatDateTime(timestamp?: string | null) {
  if (!timestamp) {
    return "—";
  }

  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AgentOperationsDetail({ detail, onOpenSession, onOpenSessionTerminal, onDeleteQueuedEntry, onCancelActiveWorkflowEntry, supportsTerminal = false, busy = false }: AgentOperationsDetailProps) {
  const [workFilter, setWorkFilter] = useState<AgentWorkFilter>("active");
  const filteredQueueEntries = useMemo(() => {
    switch (workFilter) {
      case "queued":
        return detail.queueEntries.filter((entry) => entry.status === "queued");
      case "completed":
        return detail.queueEntries.filter((entry) => ["completed", "failed", "canceled"].includes(entry.status));
      default:
        return detail.queueEntries.filter((entry) => entry.status === "dispatched");
    }
  }, [detail.queueEntries, workFilter]);

  const canOpenTerminal = supportsTerminal && !busy && detail.runtimeState.status !== "running" && !detail.runtimeState.terminalAttached;

  return (
    <div className="workforce-detail-stack">
      <section className="workflow-section workforce-role-summary">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Agent runtime</p>
            <h2>{detail.agent.name}</h2>
            <p>{detail.agent.description ?? "No description yet."}</p>
          </div>

          <div className="action-cluster action-cluster--wrap">
            <button
              className="primary-button"
              data-role="open-agent-session"
              type="button"
              onClick={() => onOpenSession(detail.agent.id)}
            >
              {detail.runtimeState.mainSessionId ? "Open session" : "Launch session"}
            </button>
            {supportsTerminal ? (
              <button
                className="secondary-button"
                data-role="open-agent-session-terminal"
                type="button"
                disabled={!canOpenTerminal}
                onClick={() => onOpenSessionTerminal(detail.agent.id)}
              >
                Open in terminal
              </button>
            ) : null}
            <span className={`status-badge status-badge--${detail.runtimeState.status === "running" ? "success" : detail.runtimeState.status === "needs_attention" ? "error" : "neutral"}`}>
              {detail.runtimeState.status}
            </span>
            {detail.runtimeState.terminalAttached ? <span className="status-badge status-badge--warning">Terminal attached</span> : null}
          </div>
        </div>

        <div className="workforce-metrics">
          <article className="metric-card">
            <span className="metric-card__label">Queued</span>
            <strong>{detail.queueEntries.filter((entry) => entry.status === "queued").length}</strong>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Dispatched</span>
            <strong>{detail.queueEntries.filter((entry) => entry.status === "dispatched").length}</strong>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Session</span>
            <strong>{detail.runtimeState.mainSessionId ?? "—"}</strong>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Runtime cwd</span>
            <strong>{detail.runtimeState.runtimeCwd ?? "—"}</strong>
          </article>
        </div>
      </section>

      <section className="workflow-section">
        <div>
          <p className="eyebrow">Runtime state</p>
          <h3>Project-scoped execution</h3>
        </div>

        <div className="workforce-meta-grid muted-copy">
          <span>Last dispatch: {formatDateTime(detail.runtimeState.lastDispatchAt)}</span>
          <span>Current queue entry: {detail.runtimeState.currentQueueEntryId ?? "—"}</span>
          <span>Updated: {formatDateTime(detail.runtimeState.updatedAt)}</span>
          <span>Created: {formatDateTime(detail.runtimeState.createdAt)}</span>
        </div>

        {detail.runtimeState.lastError ? <p className="error-copy">{detail.runtimeState.lastError}</p> : null}
      </section>

      <section className="workflow-section">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Work</p>
            <h3>Queued, active, and completed work</h3>
          </div>
          <div className="filter-chip-row" role="tablist" aria-label="Agent work filters">
            {([
              ["queued", "Queued"],
              ["active", "Active"],
              ["completed", "Completed"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={workFilter === value ? "filter-chip filter-chip--active" : "filter-chip"}
                data-role={`agent-work-filter-${value}`}
                type="button"
                onClick={() => setWorkFilter(value)}
              >
                {label}
              </button>
            ))}
          </div>
        </div>

        {filteredQueueEntries.length === 0 ? <p className="muted-copy">No {workFilter} work right now.</p> : null}

        <div className="workforce-list">
          {filteredQueueEntries.map((entry) => (
            <article className="workflow-lane-card" key={entry.id}>
              <div className="workflow-section__header">
                <div>
                  <strong>{entry.title}</strong>
                  <p>{entry.message}</p>
                </div>
                <span className={`status-badge status-badge--${entry.status === "dispatched" ? "success" : entry.status === "queued" ? "warning" : entry.status === "failed" ? "error" : "neutral"}`}>
                  {entry.status}
                </span>
              </div>
              <div className="workforce-meta-grid muted-copy">
                <span>Source: {entry.sourceType}</span>
                <span>Delivery: {entry.deliveryMode}</span>
                <span>Task: {entry.sourceTaskId ?? "—"}</span>
                <span>Session: {entry.sessionId ?? "—"}</span>
                <span>Run: {entry.runId ?? "—"}</span>
                <span>Created: {formatDateTime(entry.createdAt)}</span>
              </div>
              {entry.status === "queued" ? (
                <div className="action-cluster">
                  <button
                    className="secondary-button secondary-button--danger"
                    data-role={`delete-agent-queue-entry-${entry.id}`}
                    type="button"
                    disabled={busy}
                    onClick={() => onDeleteQueuedEntry(entry)}
                  >
                    Delete queued item
                  </button>
                </div>
              ) : null}

              {entry.status === "dispatched" && entry.sourceType === "workflow_lane" && entry.sourceTaskId ? (
                <div className="action-cluster">
                  <button
                    className="secondary-button"
                    data-role={`requeue-agent-work-item-${entry.id}`}
                    type="button"
                    disabled={busy}
                    onClick={() => onCancelActiveWorkflowEntry(entry, true)}
                  >
                    Cancel + requeue
                  </button>
                  <button
                    className="secondary-button secondary-button--danger"
                    data-role={`cancel-agent-work-item-${entry.id}`}
                    type="button"
                    disabled={busy}
                    onClick={() => onCancelActiveWorkflowEntry(entry, false)}
                  >
                    Cancel item
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
