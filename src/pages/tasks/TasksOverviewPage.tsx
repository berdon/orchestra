import type { AgentSummary, RoleSummary, TaskScheduleSummary, TaskSummary } from "../../types";
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
  schedules: TaskScheduleSummary[];
  filter: TaskBoardFilter;
  viewMode: TaskBoardViewMode;
  onFilterChange: (filter: TaskBoardFilter) => void;
  onViewModeChange: (viewMode: TaskBoardViewMode) => void;
  agents: AgentSummary[];
  roles: RoleSummary[];
  onOpenTask: (taskId: string) => void;
  onOpenSchedule: (scheduleId: string) => void;
}

function formatScheduleTrigger(schedule: TaskScheduleSummary) {
  const trigger = schedule.trigger;
  if (trigger.type === "event") {
    return `Event · ${trigger.eventKey}`;
  }
  switch (trigger.kind) {
    case "once":
      return `Once · ${trigger.at}`;
    case "everyMinutes":
      return `Every ${trigger.everyMinutes}m`;
    case "daily":
      return `Daily · ${trigger.timeOfDay}`;
    case "weekly":
      return `Weekly · ${trigger.timeOfDay}`;
    case "monthly":
      return `Monthly · day ${trigger.dayOfMonth}`;
    default:
      return "";
  }
}

export function TasksOverviewPage({
  board,
  allTasks,
  attentionTasks,
  schedules,
  filter,
  viewMode,
  onFilterChange,
  onViewModeChange,
  agents,
  roles,
  onOpenTask,
  onOpenSchedule,
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

        <section className="task-board-section" data-role="task-schedule-section">
          <div className="task-board-section__header">
            <div>
              <p className="eyebrow">Automation</p>
              <h3>Scheduled tasks</h3>
            </div>
            <span className="status-badge status-badge--neutral">{schedules.length}</span>
          </div>
          {schedules.length ? (
            <div className="task-draft-grid" data-role="task-schedule-grid">
              {schedules.map((schedule) => (
                <button key={schedule.id} className="task-list-link" data-role="task-schedule-card" type="button" onClick={() => onOpenSchedule(schedule.id)}>
                  <div className="task-compact-card__header">
                    <span className="task-list-link__eyebrow">{formatScheduleTrigger(schedule)}</span>
                    <span className={`status-badge status-badge--${schedule.enabled ? "success" : "neutral"}`}>
                      {schedule.enabled ? "enabled" : "disabled"}
                    </span>
                  </div>
                  <strong className="task-compact-card__title">{schedule.title}</strong>
                  <div className="task-list-link__meta">
                    <span>{schedule.oneShot ? "one-shot" : "repeating"}</span>
                    <span>{schedule.openMaterializedTaskCount} open</span>
                    <span>{schedule.materializedTaskCount} total</span>
                  </div>
                </button>
              ))}
            </div>
          ) : (
            <p className="muted-copy">No scheduled task definitions yet.</p>
          )}
        </section>

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
