import type { AgentSummary, RepositoryRecord, RoleSummary, TaskUpsertInput, WorkflowSummary } from "../../types";
import { TaskEditorForm } from "./TaskEditorForm";

interface TaskCreatePageProps {
  draft: TaskUpsertInput;
  workflows: WorkflowSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  repositories: RepositoryRecord[];
  saving: boolean;
  onChange: (draft: TaskUpsertInput) => void;
  onSave: () => void;
  onBack: () => void;
}

export function TaskCreatePage({ draft, workflows, agents, roles, repositories, saving, onChange, onSave, onBack }: TaskCreatePageProps) {
  return (
    <section className="task-page task-create-page panel">
      <div className="panel__header panel__header--session-detail">
        <div>
          <p className="eyebrow">Task creation</p>
          <h2>New task</h2>
          <p className="muted-copy">Create a draft or route work directly into a workflow.</p>
        </div>
        <div className="action-cluster">
          <button className="secondary-button" type="button" onClick={onBack}>
            Back to tasks
          </button>
          <button className="primary-button" data-role="save-task" type="button" disabled={saving} onClick={onSave}>
            {saving ? "Creating…" : "Create task"}
          </button>
        </div>
      </div>

      <TaskEditorForm agents={agents} draft={draft} onChange={onChange} repositories={repositories} roles={roles} workflows={workflows} />
    </section>
  );
}
