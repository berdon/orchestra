import type { AgentSummary, RoleSummary, TaskPriority, TaskStatus, TaskType, TaskUpsertInput, WorkflowSummary } from "../../types";

const TASK_TYPES: TaskType[] = ["task", "bug", "feature", "chore", "epic"];
const TASK_STATUSES: TaskStatus[] = ["draft", "ready", "in_progress", "blocked", "in_review", "completed", "canceled"];
const TASK_PRIORITIES: TaskPriority[] = ["P0", "P1", "P2", "P3", "P4"];

interface TaskEditorFormProps {
  draft: TaskUpsertInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  onChange: (nextDraft: TaskUpsertInput) => void;
}

export function TaskEditorForm({ draft, workflows, agents, roles, onChange }: TaskEditorFormProps) {
  const availableAssignees = draft.assigneeType === "agent"
    ? agents.map((agent) => ({ value: agent.slug, label: agent.name }))
    : draft.assigneeType === "role"
      ? roles.map((role) => ({ value: role.slug, label: role.name }))
      : [];

  return (
    <div className="task-editor-grid">
      <label className="field-group">
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

      <label className="field-group">
        <span className="field-group__label">Status</span>
        <select className="select-input" data-role="task-status" value={draft.status} onChange={(event) => onChange({ ...draft, status: event.target.value as TaskStatus })}>
          {TASK_STATUSES.map((status) => (
            <option key={status} value={status}>{status.replace(/_/g, " ")}</option>
          ))}
        </select>
      </label>

      <label className="field-group">
        <span className="field-group__label">Priority</span>
        <select className="select-input" data-role="task-priority" value={draft.priority} onChange={(event) => onChange({ ...draft, priority: event.target.value as TaskPriority })}>
          {TASK_PRIORITIES.map((priority) => (
            <option key={priority} value={priority}>{priority}</option>
          ))}
        </select>
      </label>

      <label className="field-group">
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

      <label className="field-group">
        <span className="field-group__label">Assignee type</span>
        <select
          className="select-input"
          data-role="task-assignee-type"
          value={draft.assigneeType}
          onChange={(event) => onChange({ ...draft, assigneeType: event.target.value, assigneeId: null })}
        >
          <option value="unassigned">unassigned</option>
          <option value="user">user</option>
          <option value="agent">agent</option>
          <option value="role">role</option>
        </select>
      </label>

      {draft.assigneeType === "agent" || draft.assigneeType === "role" ? (
        <label className="field-group task-editor-grid__full">
          <span className="field-group__label">{draft.assigneeType === "agent" ? "Agent" : "Role"}</span>
          <select className="select-input" data-role="task-assignee-id" value={draft.assigneeId ?? ""} onChange={(event) => onChange({ ...draft, assigneeId: event.target.value || null })}>
            <option value="">Select a {draft.assigneeType}</option>
            {availableAssignees.map((assignee) => (
              <option key={assignee.value} value={assignee.value}>{assignee.label}</option>
            ))}
          </select>
        </label>
      ) : null}

      <label className="field-group task-editor-grid__full">
        <span className="field-group__label">Description</span>
        <textarea className="text-area" data-role="task-description" rows={6} value={draft.description ?? ""} onChange={(event) => onChange({ ...draft, description: event.target.value })} />
      </label>
    </div>
  );
}
