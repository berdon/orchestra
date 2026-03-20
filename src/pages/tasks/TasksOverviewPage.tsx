import type { AgentSummary, RoleSummary, TaskSummary } from "../../types";
import { TaskCompactCard } from "./TaskCompactCard";
import type { TaskBoardModel } from "./taskBoardModel";
import { resolveTaskAssigneeLabel } from "./taskBoardModel";
import { WorkflowTaskBoardSection } from "./WorkflowTaskBoardSection";

export type TaskBoardFilter = "all" | "attention" | "review" | "blocked" | "active" | "epics";

interface TasksOverviewPageProps {
  board: TaskBoardModel;
  allTasks: TaskSummary[];
  attentionTasks: TaskSummary[];
  filter: TaskBoardFilter;
  onFilterChange: (filter: TaskBoardFilter) => void;
  includeArchived: boolean;
  onIncludeArchivedChange: (value: boolean) => void;
  agents: AgentSummary[];
  roles: RoleSummary[];
  onOpenTask: (taskId: string) => void;
  onCreateTask: () => void;
}

export function TasksOverviewPage({
  board,
  allTasks,
  attentionTasks,
  filter,
  onFilterChange,
  includeArchived,
  onIncludeArchivedChange,
  agents,
  roles,
  onOpenTask,
  onCreateTask,
}: TasksOverviewPageProps) {
  const filterCounts = {
    all: allTasks.length,
    attention: attentionTasks.length,
    review: allTasks.filter((task) => task.status === "in_review").length,
    blocked: allTasks.filter((task) => task.status === "blocked" || task.dependencyBlocked).length,
    active: allTasks.filter((task) => task.status === "in_progress" || task.readyForDispatch).length,
    epics: allTasks.filter((task) => task.type === "epic").length,
  };

  return (
    <section className="tasks-overview-page">
      <header className="tasks-page-header panel">
        <div>
          <p className="eyebrow">Workflow operations</p>
          <h2>Tasks</h2>
          <p className="muted-copy">Scan draft work and workflow progress at a glance, then open a task for details.</p>
        </div>
        <div className="tasks-toolbar">
          <label className="checkbox-row">
            <input type="checkbox" checked={includeArchived} onChange={(event) => onIncludeArchivedChange(event.target.checked)} />
            Show archived
          </label>
          <button className="primary-button" data-role="new-task" type="button" onClick={onCreateTask}>
            New task
          </button>
        </div>
      </header>

      <section className="tasks-overview-stack">
        <div className="task-nav-filters task-nav-filters--horizontal" data-role="task-nav-filters">
          {([
            ["all", "All", filterCounts.all],
            ["attention", "Attention", filterCounts.attention],
            ["review", "Needs review", filterCounts.review],
            ["blocked", "Blocked", filterCounts.blocked],
            ["active", "Active", filterCounts.active],
            ["epics", "Epics", filterCounts.epics],
          ] as Array<[TaskBoardFilter, string, number]>).map(([key, label, count]) => (
            <button
              key={key}
              className={filter === key ? "task-nav-filter task-nav-filter--active" : "task-nav-filter"}
              data-role={`task-filter-${key}`}
              type="button"
              onClick={() => onFilterChange(key)}
            >
              <span>{label}</span>
              <span>{count}</span>
            </button>
          ))}
        </div>

        <section className="task-board-section" data-role="draft-task-section">
          <div className="task-board-section__header">
            <div>
              <p className="eyebrow">Draft work</p>
              <h3>Drafts</h3>
            </div>
            <span className="status-badge status-badge--neutral">{board.draftTasks.length}</span>
          </div>
          <div className="task-draft-grid">
            {board.draftTasks.map((task) => (
              <TaskCompactCard
                assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                key={task.id}
                task={task}
                onOpen={onOpenTask}
              />
            ))}
          </div>
        </section>

        <section className="task-board-section task-section--compact task-attention-queue">
          <div className="task-board-section__header">
            <div>
              <p className="eyebrow">Inbox</p>
              <h3>Needs attention</h3>
            </div>
          </div>
          <div className="task-draft-grid" data-role="task-attention-queue">
            {attentionTasks.slice(0, 6).map((task) => (
              <TaskCompactCard
                assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                key={task.id}
                task={task}
                onOpen={onOpenTask}
              />
            ))}
          </div>
        </section>

        {board.workflowSections.map((section) => (
          <WorkflowTaskBoardSection
            agents={agents}
            key={section.workflowId}
            onOpenTask={onOpenTask}
            roles={roles}
            section={section}
          />
        ))}
      </section>
    </section>
  );
}
