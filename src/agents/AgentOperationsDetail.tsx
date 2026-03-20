import type { AgentOperationsDetail } from "../types";

interface AgentOperationsDetailProps {
  detail: AgentOperationsDetail;
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

export function AgentOperationsDetail({ detail }: AgentOperationsDetailProps) {
  return (
    <div className="workforce-detail-stack">
      <section className="workflow-section workforce-role-summary">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Agent runtime</p>
            <h2>{detail.agent.name}</h2>
            <p>{detail.agent.description ?? "No description yet."}</p>
          </div>

          <div className="action-cluster">
            <span className={`status-badge status-badge--${detail.runtimeState.status === "running" ? "success" : detail.runtimeState.status === "needs_attention" ? "error" : "neutral"}`}>
              {detail.runtimeState.status}
            </span>
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
        <div>
          <p className="eyebrow">Queue</p>
          <h3>Queued and dispatched work</h3>
        </div>

        {detail.queueEntries.length === 0 ? <p className="muted-copy">No queued work yet.</p> : null}

        <div className="workforce-list">
          {detail.queueEntries.map((entry) => (
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
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
