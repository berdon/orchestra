import type { AgentSummary, RoleSummary, TaskSummary } from "../../types";
import { TaskCompactCard } from "./TaskCompactCard";
import type { TaskBoardViewMode } from "./TasksOverviewPage";
import { TaskSummaryStatusBadges } from "./taskStatusBadges";
import type { TaskWorkflowSection } from "./taskBoardModel";
import { resolveTaskAssigneeLabel } from "./taskBoardModel";

interface WorkflowTaskBoardSectionProps {
  section: TaskWorkflowSection;
  agents: AgentSummary[];
  roles: RoleSummary[];
  displayMode: TaskBoardViewMode;
  showDoneTasks: boolean;
  onOpenTask: (taskId: string) => void;
}

function getPriorityLabel(priority: string) {
  return priority.toUpperCase();
}

function resolveLaneLabel(task: TaskSummary, section: TaskWorkflowSection) {
  const lane = section.lanes.find((entry) => entry.laneId === task.currentLaneId);
  if (lane) {
    return lane.laneName;
  }
  return task.currentLaneId ?? "—";
}

export function WorkflowTaskBoardSection({
  section,
  agents,
  roles,
  displayMode,
  showDoneTasks,
  onOpenTask,
}: WorkflowTaskBoardSectionProps) {
  const visibleLanes = section.lanes.filter((lane) => lane.tasks.length > 0);
  const visibleTasks = showDoneTasks
    ? section.doneTasks
    : section.lanes.flatMap((lane) => lane.tasks);

  if (showDoneTasks && section.doneTasks.length === 0) {
    return null;
  }

  if (!showDoneTasks && visibleLanes.length === 0) {
    return null;
  }

  return (
    <section className="task-board-section task-board-section--workflow" data-role="workflow-task-section">
      <div className="task-board-section__header">
        <div>
          <p className="eyebrow">Workflow</p>
          <h3>{section.workflowName}</h3>
        </div>
        <span className="status-badge status-badge--neutral">{visibleTasks.length}</span>
      </div>

      {displayMode === "table" ? (
        <div className="task-table-wrap">
          <table className="task-table" data-role="task-table">
            <thead>
              <tr>
                <th>Name</th>
                <th>Priority</th>
                <th>Status</th>
                <th>Workflow</th>
                <th>Lane</th>
                <th>Assignee</th>
                <th>Comments</th>
              </tr>
            </thead>
            <tbody>
              {visibleTasks.map((task) => (
                <tr
                  className="task-table__row"
                  data-priority={String(task.priority).toLowerCase()}
                  data-role="task-table-row"
                  data-task-id={task.id}
                  key={task.id}
                  tabIndex={0}
                  onClick={() => onOpenTask(task.id)}
                  onKeyDown={(event) => {
                    if (event.key === "Enter" || event.key === " ") {
                      event.preventDefault();
                      onOpenTask(task.id);
                    }
                  }}
                >
                  <td>
                    <div className="task-table__open">
                      <strong>{task.number}</strong>
                      <span>{task.title}</span>
                    </div>
                  </td>
                  <td>{getPriorityLabel(task.priority)}</td>
                  <td>
                    <TaskSummaryStatusBadges task={task} />
                  </td>
                  <td>{section.workflowName}</td>
                  <td>{resolveLaneLabel(task, section)}</td>
                  <td>{resolveTaskAssigneeLabel(task, agents, roles)}</td>
                  <td>
                    <div className="task-table__comments-cell">
                      <span>{task.commentCount}</span>
                      {task.unreadCommentCount > 0 ? (
                        <span
                          className="status-badge status-badge--warning status-badge--compact"
                          data-role="task-table-unread-comments-badge"
                          title={`${task.unreadCommentCount} unread comment${task.unreadCommentCount === 1 ? "" : "s"}`}
                        >
                          {task.unreadCommentCount} unread
                        </span>
                      ) : null}
                    </div>
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : showDoneTasks ? (
        <div className="task-draft-grid" data-role="workflow-done-grid">
          {section.doneTasks.map((task) => (
            <TaskCompactCard
              assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
              key={task.id}
              task={task}
              onOpen={onOpenTask}
            />
          ))}
        </div>
      ) : (
        <div className="task-board-scroll">
          <div className="task-lane-board">
            {section.lanes.map((lane) => (
              <section className="task-lane-column" data-lane-id={lane.laneId} key={lane.laneId}>
                <div className="task-lane-column__header">
                  <strong>{lane.laneName}</strong>
                  <span>{lane.tasks.length}</span>
                </div>
                <div className="task-lane-column__list" data-role="workflow-lane-task-list" data-lane-id={lane.laneId}>
                  {lane.tasks.map((task) => (
                    <TaskCompactCard
                      assigneeLabel={resolveTaskAssigneeLabel(task, agents, roles)}
                      key={task.id}
                      task={task}
                      onOpen={onOpenTask}
                    />
                  ))}
                </div>
              </section>
            ))}
          </div>
        </div>
      )}
    </section>
  );
}
