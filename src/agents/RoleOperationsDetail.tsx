import { useMemo, useState } from "react";

import { EnqueueRoleWorkForm } from "./EnqueueRoleWorkForm";
import type { RoleOperationsDetail } from "../types";

type RoleWorkFilter = "queued" | "active" | "completed";

interface RoleOperationsDetailProps {
  detail: RoleOperationsDetail;
  busy?: boolean;
  onDispatch: () => Promise<void>;
  onEnqueue: (input: { title: string; summary: string; entryPrompt: string }) => Promise<void>;
  onDeleteQueuedEntry: (entry: RoleOperationsDetail["queueEntries"][number]) => Promise<void>;
  onCancelActiveEntry: (entry: RoleOperationsDetail["queueEntries"][number], requeue: boolean) => Promise<void>;
  onRelease: (instanceId: string, outcome: "success" | "failure" | "canceled") => Promise<void>;
  onResetAssignments: () => Promise<void>;
  onDispose: (instanceId: string) => Promise<void>;
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

export function RoleOperationsDetail({ detail, busy, onDispatch, onEnqueue, onDeleteQueuedEntry, onCancelActiveEntry, onRelease, onResetAssignments, onDispose }: RoleOperationsDetailProps) {
  const [workFilter, setWorkFilter] = useState<RoleWorkFilter>("active");
  const filteredQueueEntries = useMemo(() => {
    switch (workFilter) {
      case "queued":
        return detail.queueEntries.filter((entry) => entry.status === "queued");
      case "completed":
        return detail.queueEntries.filter((entry) => ["completed", "failed", "canceled"].includes(entry.status));
      default:
        return detail.queueEntries.filter((entry) => entry.status === "assigned");
    }
  }, [detail.queueEntries, workFilter]);

  return (
    <div className="workforce-detail-stack">
      <section className="workflow-section workforce-role-summary">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Role operations</p>
            <h2>{detail.role.name}</h2>
            <p>{detail.role.description ?? "No description yet."}</p>
          </div>

          <div className="action-cluster">
            <span className="status-badge status-badge--accent">Capacity {detail.activeInstanceCount}/{detail.role.capacity}</span>
            <button className="primary-button" type="button" disabled={busy || detail.queuedCount === 0} onClick={() => void onDispatch()}>
              {busy ? "Dispatching…" : "Dispatch queue"}
            </button>
            <button
              className="secondary-button secondary-button--danger"
              data-role="reset-role-assignments"
              type="button"
              disabled={busy || detail.assignedCount === 0 && detail.activeInstanceCount === 0}
              onClick={() => void onResetAssignments()}
            >
              Reset assignments
            </button>
          </div>
        </div>

        <div className="workforce-metrics">
          <article className="metric-card">
            <span className="metric-card__label">Queued</span>
            <strong>{detail.queuedCount}</strong>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Assigned</span>
            <strong>{detail.assignedCount}</strong>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Active instances</span>
            <strong>{detail.activeInstanceCount}</strong>
          </article>
          <article className="metric-card">
            <span className="metric-card__label">Idle instances</span>
            <strong>{detail.idleInstanceCount}</strong>
          </article>
        </div>
      </section>

      <EnqueueRoleWorkForm role={detail.role} busy={busy} onSubmit={onEnqueue} />

      <section className="workflow-section">
        <div className="workflow-section__header">
          <div>
            <p className="eyebrow">Work</p>
            <h3>Queued, active, and completed work</h3>
          </div>
          <div className="filter-chip-row" role="tablist" aria-label="Role work filters">
            {([
              ["queued", "Queued"],
              ["active", "Active"],
              ["completed", "Completed"],
            ] as const).map(([value, label]) => (
              <button
                key={value}
                className={workFilter === value ? "filter-chip filter-chip--active" : "filter-chip"}
                data-role={`role-work-filter-${value}`}
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
                  <p>{entry.summary ?? "No summary provided."}</p>
                </div>
                <span className={`status-badge status-badge--${entry.status === "assigned" ? "success" : entry.status === "queued" ? "warning" : "neutral"}`}>
                  {entry.status}
                </span>
              </div>
              <div className="workforce-meta-grid muted-copy">
                <span>Source: {entry.sourceType}</span>
                <span>Assigned instance: {entry.assignedInstanceId ?? "—"}</span>
                <span>Created: {formatDateTime(entry.createdAt)}</span>
                <span>Started: {formatDateTime(entry.startedAt)}</span>
              </div>

              {entry.status === "queued" ? (
                <div className="action-cluster">
                  <button
                    className="secondary-button secondary-button--danger"
                    data-role={`delete-role-queue-entry-${entry.id}`}
                    type="button"
                    disabled={busy}
                    onClick={() => void onDeleteQueuedEntry(entry)}
                  >
                    Delete queued item
                  </button>
                </div>
              ) : null}

              {entry.status === "assigned" ? (
                <div className="action-cluster">
                  <button
                    className="secondary-button"
                    data-role={`requeue-role-work-item-${entry.id}`}
                    type="button"
                    disabled={busy}
                    onClick={() => void onCancelActiveEntry(entry, true)}
                  >
                    Cancel + requeue
                  </button>
                  <button
                    className="secondary-button secondary-button--danger"
                    data-role={`cancel-role-work-item-${entry.id}`}
                    type="button"
                    disabled={busy}
                    onClick={() => void onCancelActiveEntry(entry, false)}
                  >
                    Cancel item
                  </button>
                </div>
              ) : null}
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-section">
        <div>
          <p className="eyebrow">Instances</p>
          <h3>Runtime workers</h3>
        </div>

        {detail.instances.length === 0 ? <p className="muted-copy">Dispatch work to create the first instance.</p> : null}

        <div className="workforce-list">
          {detail.instances.map((instance) => (
            <article className="workflow-lane-card" key={instance.id}>
              <div className="workflow-section__header">
                <div>
                  <strong>{instance.displayName}</strong>
                  <p>{instance.id}</p>
                </div>
                <span className={`status-badge status-badge--${instance.status === "running" ? "success" : instance.status === "failed" ? "error" : "neutral"}`}>
                  {instance.status}
                </span>
              </div>

              <div className="workforce-meta-grid muted-copy">
                <span>Session: {instance.sessionId ?? "—"}</span>
                <span>Current work: {instance.currentQueueEntryId ?? "—"}</span>
                <span>Worktree: {instance.worktreePath ?? "—"}</span>
                <span>Updated: {formatDateTime(instance.updatedAt)}</span>
              </div>

              {instance.lastError ? <p className="error-copy">{instance.lastError}</p> : null}

              <div className="action-cluster">
                {instance.currentQueueEntryId ? (
                  <>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => void onRelease(instance.id, "success")}>
                      Mark success
                    </button>
                    <button className="secondary-button secondary-button--danger" type="button" disabled={busy} onClick={() => void onRelease(instance.id, "failure")}>
                      Mark failed
                    </button>
                    <button className="secondary-button" type="button" disabled={busy} onClick={() => void onRelease(instance.id, "canceled")}>
                      Cancel work
                    </button>
                  </>
                ) : (
                  <button className="secondary-button secondary-button--danger" type="button" disabled={busy} onClick={() => void onDispose(instance.id)}>
                    Dispose instance
                  </button>
                )}
              </div>
            </article>
          ))}
        </div>
      </section>
    </div>
  );
}
