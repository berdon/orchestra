import type { AgentSummary, RoleSummary, TaskSummary } from "../../types";
import { TaskCompactCard } from "./TaskCompactCard";
import type { TaskBoardModel } from "./taskBoardModel";
import { resolveTaskAssigneeLabel } from "./taskBoardModel";
import { WorkflowTaskBoardSection } from "./WorkflowTaskBoardSection";

export type TaskBoardFilter = "all" | "attention" | "review" | "blocked" | "active" | "done" | "epics";
export type TaskBoardViewMode = "cards" | "table";

interface TasksOverviewPageProps {
  board: TaskBoardModel;
  allTasks: TaskSummary[];
  attentionTasks: TaskSummary[];
  filter: TaskBoardFilter;
  viewMode: TaskBoardViewMode;
  onFilterChange: (filter: TaskBoardFilter) => void;
  onViewModeChange: (viewMode: TaskBoardViewMode) => void;
  agents: AgentSummary[];
  roles: RoleSummary[];
  onOpenTask: (taskId: string) => void;
}

export function TasksOverviewPage({
  board,
  allTasks,
  attentionTasks,
  filter,
  viewMode,
  onFilterChange,
  onViewModeChange,
  agents,
  roles,
  onOpenTask,
}: TasksOverviewPageProps) {
  const filterCounts = {
    all: allTasks.length,
    attention: attentionTasks.length,
    review: allTasks.filter((task) => task.status === "in_review").length,
    blocked: allTasks.filter((task) => task.status === "blocked" || task.dependencyBlocked).length,
    active: allTasks.filter((task) => task.status === "in_progress" || task.readyForDispatch).length,
    done: allTasks.filter((task) => task.status === "completed" || task.status === "canceled").length,
    epics: allTasks.filter((task) => task.type === "epic").length,
  };

  return (
    <section className="tasks-overview-page">
      <section className="tasks-overview-stack">
        <div className="task-overview-controls">
          <div className="task-nav-filters task-nav-filters--horizontal" data-role="task-nav-filters">
            {([
              ["all", "All", filterCounts.all],
              ["attention", "Attention", filterCounts.attention],
              ["review", "Needs review", filterCounts.review],
              ["blocked", "Blocked", filterCounts.blocked],
              ["active", "Active", filterCounts.active],
              ["done", "Done", filterCounts.done],
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

          <div className="task-view-toggle" data-role="task-view-toggle">
            <button
              className={viewMode === "cards" ? "task-view-toggle__button task-view-toggle__button--active" : "task-view-toggle__button"}
              data-role="task-view-cards"
              type="button"
              aria-pressed={viewMode === "cards"}
              onClick={() => onViewModeChange("cards")}
            >
              <span aria-hidden="true">▥</span>
              <span>Cards</span>
            </button>
            <button
              className={viewMode === "table" ? "task-view-toggle__button task-view-toggle__button--active" : "task-view-toggle__button"}
              data-role="task-view-table"
              type="button"
              aria-pressed={viewMode === "table"}
              onClick={() => onViewModeChange("table")}
            >
              <span aria-hidden="true">☰</span>
              <span>Table</span>
            </button>
          </div>
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

        {attentionTasks.length ? (
          <section className="task-board-section task-section--compact task-attention-queue" data-role="task-attention-section">
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
        ) : null}

        {board.workflowSections.map((section) => (
          <WorkflowTaskBoardSection
            agents={agents}
            displayMode={viewMode}
            key={section.workflowId}
            onOpenTask={onOpenTask}
            roles={roles}
            section={section}
            showDoneTasks={filter === "done"}
          />
        ))}
      </section>
    </section>
  );
}
