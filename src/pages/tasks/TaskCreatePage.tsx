import type { AgentSummary, RepositoryRecord, RoleSummary, TaskScheduleUpsertInput, TaskUpsertInput, WorkflowSummary } from "../../types";
import { TaskEditorForm } from "./TaskEditorForm";
import { TaskScheduleEditorForm } from "./TaskScheduleEditorForm";

interface TaskCreatePageProps {
  draft: TaskUpsertInput;
  scheduleDraft: TaskScheduleUpsertInput;
  scheduledMode: boolean;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  repositories: RepositoryRecord[];
  saving: boolean;
  onChange: (draft: TaskUpsertInput) => void;
  onScheduleChange: (draft: TaskScheduleUpsertInput) => void;
  onScheduledModeChange: (scheduled: boolean) => void;
  onSave: () => void;
  onPublish: () => void;
  onBack: () => void;
}

export function TaskCreatePage({
  draft,
  scheduleDraft,
  scheduledMode,
  workflows,
  agents,
  roles,
  repositories,
  saving,
  onChange,
  onScheduleChange,
  onScheduledModeChange,
  onSave,
  onPublish,
  onBack,
}: TaskCreatePageProps) {
  const canSave = scheduledMode ? Boolean(scheduleDraft.task.title.trim()) : Boolean(draft.title.trim());
  const canPublish = scheduledMode ? canSave : Boolean(draft.workflowId && draft.title.trim());

  return (
    <section className="task-page task-create-page panel">
      <div className="panel__header panel__header--session-detail">
        <div>
          <p className="eyebrow">Task creation</p>
          <h2>{scheduledMode ? "New scheduled task" : "New task"}</h2>
          <p className="muted-copy">
            {scheduledMode
              ? "Define a reusable schedule that materializes ready tasks whenever its trigger fires."
              : "New tasks start as drafts. Save changes to keep a draft, or publish to move the task into its workflow."}
          </p>
        </div>
        <div className="action-cluster action-cluster--wrap">
          <button className="secondary-button" type="button" onClick={onBack}>
            Back to tasks
          </button>
          <button
            className="secondary-button"
            data-role={scheduledMode ? "create-task-schedule" : "publish-task"}
            type="button"
            disabled={saving || !canPublish}
            onClick={onPublish}
          >
            {saving ? (scheduledMode ? "Creating…" : "Publishing…") : scheduledMode ? "Create schedule" : "Publish"}
          </button>
          <button
            className="primary-button"
            data-role={scheduledMode ? "save-task-schedule" : "save-task"}
            type="button"
            disabled={saving || !canSave}
            onClick={onSave}
          >
            {saving ? "Saving…" : scheduledMode ? "Save schedule" : "Save changes"}
          </button>
        </div>
      </div>

      <label className="checkbox-field task-create-page__mode-toggle">
        <input
          data-role="task-create-scheduled-toggle"
          type="checkbox"
          checked={scheduledMode}
          onChange={(event) => onScheduledModeChange(event.target.checked)}
        />
        <span>Create as a scheduled task definition instead of a one-off task</span>
      </label>

      {scheduledMode ? (
        <TaskScheduleEditorForm
          agents={agents}
          draft={scheduleDraft}
          onChange={onScheduleChange}
          repositories={repositories}
          roles={roles}
          workflows={workflows}
        />
      ) : (
        <TaskEditorForm agents={agents} draft={draft} onChange={onChange} repositories={repositories} roles={roles} showStatusField={false} workflows={workflows} />
      )}
    </section>
  );
}
