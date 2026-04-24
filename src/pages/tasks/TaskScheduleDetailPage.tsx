import { useEffect, useMemo, useState } from "react";

import type { AgentSummary, RepositoryRecord, RoleSummary, TaskScheduleDetail, TaskScheduleUpsertInput, WorkflowSummary } from "../../types";
import { TaskActionMenu } from "../../components/TaskActionMenu";
import { TaskScheduleEditorForm } from "./TaskScheduleEditorForm";

interface TaskScheduleDetailPageProps {
  schedule: TaskScheduleDetail;
  draft: TaskScheduleUpsertInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  repositories: RepositoryRecord[];
  saving: boolean;
  deleting: boolean;
  loading: boolean;
  onDraftChange: (draft: TaskScheduleUpsertInput) => void;
  onSave: () => void;
  onDelete: () => void;
  onOpenTask: (taskId: string) => void;
  onEditingStateChange?: (editing: boolean) => void;
}

function formatTriggerLabel(schedule: TaskScheduleDetail) {
  const trigger = schedule.trigger;
  if (trigger.type === "event") {
    return `Event · ${trigger.eventKey}`;
  }
  switch (trigger.kind) {
    case "once":
      return `Once · ${trigger.at}`;
    case "everyMinutes":
      return `Every ${trigger.everyMinutes} minute${trigger.everyMinutes === 1 ? "" : "s"}`;
    case "daily":
      return `Daily · ${trigger.timeOfDay} ${trigger.timezone}`;
    case "weekly":
      return `Weekly · ${trigger.timeOfDay} ${trigger.timezone}`;
    case "monthly":
      return `Monthly · day ${trigger.dayOfMonth} at ${trigger.timeOfDay} ${trigger.timezone}`;
    default:
      return "";
  }
}

export function TaskScheduleDetailPage({
  schedule,
  draft,
  workflows,
  agents,
  roles,
  repositories,
  saving,
  deleting,
  loading,
  onDraftChange,
  onSave,
  onDelete,
  onOpenTask,
  onEditingStateChange,
}: TaskScheduleDetailPageProps) {
  const [isEditing, setIsEditing] = useState(false);

  const triggerLabel = useMemo(() => formatTriggerLabel(schedule), [schedule]);
  const isSingleFire = schedule.oneShot || (schedule.trigger.type === "time" && schedule.trigger.kind === "once");

  useEffect(() => {
    onEditingStateChange?.(isEditing);
  }, [isEditing, onEditingStateChange]);

  return (
    <section className="task-page task-detail-page panel">
      <div className="panel__header panel__header--session-detail">
        <div>
          <p className="eyebrow">Scheduled task</p>
          <h2 data-role="task-schedule-title-heading">{draft.task.title.trim() || schedule.title}</h2>
          <div className="session-detail__meta">
            <span>{schedule.enabled ? "Enabled" : "Disabled"}</span>
            <span>{isSingleFire ? "One-shot" : "Repeating"}</span>
            <span>{schedule.overlapPolicy === "skip" ? "Skip overlap" : "Create overlap"}</span>
            <span>{schedule.materializedTaskCount} materialized</span>
            <span>{schedule.openMaterializedTaskCount} open</span>
          </div>
        </div>
        <TaskActionMenu
          actions={[
            {
              id: isEditing ? "done" : "edit",
              label: isEditing ? "Done editing" : "Edit schedule",
              onClick: () => setIsEditing((current) => !current),
              variant: "secondary",
              dataRole: isEditing ? "close-edit-task-schedule" : "edit-task-schedule",
            },
            {
              id: "save",
              label: saving ? "Saving…" : "Save changes",
              onClick: onSave,
              disabled: saving || loading || !draft.task.title.trim(),
              variant: "primary",
              dataRole: "save-task-schedule",
            },
            {
              id: "delete",
              label: deleting ? "Deleting…" : "Delete",
              onClick: onDelete,
              disabled: deleting,
              variant: "danger",
              dataRole: "delete-task-schedule",
            },
          ]}
        />
      </div>

      {isEditing ? (
        <TaskScheduleEditorForm
          agents={agents}
          detailLayout
          draft={draft}
          onChange={onDraftChange}
          repositories={repositories}
          roles={roles}
          workflows={workflows}
        />
      ) : (
        <div className="task-detail-sections">
          <section className="task-section">
            <div className="task-detail-summary__header">
              <div>
                <p className="eyebrow">Overview</p>
                <h3>Current schedule</h3>
              </div>
            </div>
            <div className="task-schedule-summary-grid" data-role="task-schedule-overview">
              <article className="task-history-card">
                <strong>Trigger</strong>
                <p>{triggerLabel}</p>
              </article>
              <article className="task-history-card">
                <strong>Next fire</strong>
                <p>{schedule.nextFireAt ?? "Waiting for matching event"}</p>
              </article>
              <article className="task-history-card">
                <strong>Last fire</strong>
                <p>{schedule.lastFiredAt ?? "Not fired yet"}</p>
              </article>
              <article className="task-history-card">
                <strong>Last result</strong>
                <p>{schedule.lastError ?? "Healthy"}</p>
              </article>
            </div>
          </section>

          <section className="task-section">
            <div className="task-detail-summary__header">
              <div>
                <p className="eyebrow">Materialized tasks</p>
                <h3>Recent generated work</h3>
              </div>
            </div>
            {schedule.recentMaterializedTasks.length ? (
              <div className="task-draft-grid" data-role="task-schedule-materialized-tasks">
                {schedule.recentMaterializedTasks.map((task) => (
                  <button key={task.id} className="task-list-link" type="button" onClick={() => onOpenTask(task.id)}>
                    <div className="task-compact-card__header">
                      <span className="task-compact-card__number">{task.number}</span>
                      <span className={`status-badge status-badge--${task.status === "completed" ? "success" : task.status === "blocked" ? "error" : "neutral"}`}>
                        {task.status.replace(/_/g, " ")}
                      </span>
                    </div>
                    <strong className="task-compact-card__title">{task.title}</strong>
                  </button>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No tasks have been materialized from this schedule yet.</p>
            )}
          </section>

          <section className="task-section">
            <div className="task-detail-summary__header">
              <div>
                <p className="eyebrow">Occurrences</p>
                <h3>Recent trigger history</h3>
              </div>
            </div>
            {schedule.recentOccurrences.length ? (
              <div className="task-detail-sections" data-role="task-schedule-occurrences">
                {schedule.recentOccurrences.map((occurrence) => (
                  <article className="task-history-card" key={occurrence.id}>
                    <div className="workflow-section__header">
                      <strong>{occurrence.scheduledAt ?? occurrence.eventId ?? occurrence.occurrenceKey}</strong>
                      <span className={`status-badge status-badge--${occurrence.status === "materialized" ? "success" : occurrence.status === "failed" ? "error" : occurrence.status === "skipped" ? "warning" : "neutral"}`}>
                        {occurrence.status}
                      </span>
                    </div>
                    {occurrence.taskId ? <p>Task {occurrence.taskId}</p> : null}
                    {occurrence.error ? <p className="muted-copy">{occurrence.error}</p> : null}
                  </article>
                ))}
              </div>
            ) : (
              <p className="muted-copy">No occurrences recorded yet.</p>
            )}
          </section>
        </div>
      )}
    </section>
  );
}
