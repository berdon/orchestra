import { TaskTagInput } from "../../components/TaskTagInput";
import { useExplanatoryTooltipProps } from "../../lib/tooltips";
import type { AgentSummary, RepositoryRecord, RoleSummary, TaskPriority, TaskStatus, TaskType, TaskUpsertInput, WorkflowSummary } from "../../types";

const TASK_TYPES: TaskType[] = ["task", "bug", "feature", "chore", "epic"];
const TASK_STATUSES: TaskStatus[] = ["draft", "ready", "in_progress", "blocked", "in_review", "completed", "canceled"];
const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];

interface TaskEditorFormProps {
  draft: TaskUpsertInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  repositories: RepositoryRecord[];
  showStatusField?: boolean;
  detailLayout?: boolean;
  showAssigneeFields?: boolean;
  onChange: (nextDraft: TaskUpsertInput) => void;
}

export function TaskEditorForm({
  draft,
  workflows,
  repositories,
  showStatusField = true,
  detailLayout = false,
  showAssigneeFields = true,
  onChange,
}: TaskEditorFormProps) {
  const getTooltipProps = useExplanatoryTooltipProps();

  return (
    <div className={detailLayout ? "task-editor-grid task-editor-grid--detail" : "task-editor-grid"}>
      <label className="field-group task-editor-grid__full">
        <span className="field-group__label">Title</span>
        <input className="text-input" data-role="task-title" value={draft.title} onChange={(event) => onChange({ ...draft, title: event.target.value })} />
      </label>

      <label className="field-group">
        <span className="field-group__label">Type</span>
        <select className="select-input" data-role="task-type" value={draft.type} onChange={(event) => onChange({ ...draft, type: event.target.value as TaskType })}>
          {TASK_TYPES.map((type) => (
            <option key={type} value={type}>{type}</option>
          ))}
        </select>
      </label>

      {showStatusField ? (
        <label className="field-group">
          <span className="field-group__label">Status</span>
          <select className="select-input" data-role="task-status" value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as TaskStatus })}>
            {TASK_STATUSES.map((status) => (
              <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="field-group">
        <span className="field-group__label">Priority</span>
        <select className="select-input" data-role="task-priority" value={draft.priority} onChange={(event) => onChange({ ...draft, priority: event.target.value as TaskPriority })}>
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>{priority}</option>
          ))}
        </select>
      </label>

      <label className="field-group" {...getTooltipProps("Choose which workflow owns this task's lane transitions.")}>
        <span className="field-group__label">Workflow</span>
        <select
          className="select-input"
          data-role="task-workflow"
          value={draft.workflowId ?? ""}
          onChange={(event) => onChange({ ...draft, workflowId: event.target.value || null, currentLaneId: null })}
        >
          <option value="">No workflow selected</option>
          {workflows.map((workflow) => (
            <option key={workflow.id} value={workflow.id}>{workflow.name}</option>
          ))}
        </select>
      </label>

      {detailLayout && !draft.workflowId ? (
        <div className="task-editor-grid__full task-workflow-warning" data-role="task-editor-missing-workflow-warning">
          <div className="workflow-section__header">
            <strong>No workflow configured</strong>
            <span className="status-badge status-badge--warning">Needs setup</span>
          </div>
          <p className="supporting-copy">This task will not appear in workflow lanes or be dispatchable until a workflow is assigned.</p>
        </div>
      ) : null}

      <label className="field-group" {...getTooltipProps("Limit how many automatic re-prompts happen before Orchestra escalates to a user.")}>
        <span className="field-group__label">Whip max attempts</span>
        <input
          className="text-input"
          data-role="task-whip-max-attempts"
          type="number"
          min={1}
          value={draft.whipMaxAttempts ?? 10}
          onChange={(event) => onChange({ ...draft, whipMaxAttempts: Math.max(1, Number(event.target.value || 10)) })}
        />
      </label>

      {showAssigneeFields ? null : null}

      <div className="task-editor-grid__full muted-copy">
        Orchestra re-prompts idle agent-owned task lanes to keep working. If the lane still is not completed after this many whip attempts, Orchestra automatically escalates the task to user intervention.
      </div>

      <div className="task-editor-grid__full">
        <TaskTagInput tags={draft.tags ?? []} onChange={(tags) => onChange({ ...draft, tags })} />
      </div>

      <label className="field-group task-editor-grid__full">
        <span className="field-group__label">Description</span>
        <textarea className="text-area" data-role="task-description" rows={6} value={draft.description ?? ""} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
      </label>

      <label className="field-group task-editor-grid__full" {...getTooltipProps("Choose which repositories workers should use while working on this task.")}>
        <span className="field-group__label">Task repositories</span>
        <select
          className="select-input task-repositories-input"
          data-role="task-repositories"
          multiple
          value={draft.repositoryIds ?? []}
          onChange={(event) => {
            const repositoryIds = Array.from(event.target.selectedOptions).map((option) => option.value);
            onChange({
              ...draft,
              repositoryIds,
              repositoryId: repositoryIds[0] ?? null,
            });
          }}
        >
          {repositories.map((repository) => (
            <option key={repository.id} value={repository.id}>{repository.name}</option>
          ))}
        </select>
      </label>
    </div>
  );
}
