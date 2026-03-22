import type { AgentSummary, RoleSummary, TaskSummary } from "../../types";
import { TaskCompactCard } from "./TaskCompactCard";
import type { TaskBoardViewMode } from "./TasksOverviewPage";
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

function formatStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

function getStatusTone(status: string) {
  switch (status) {
    case "completed":
      return "success";
    case "blocked":
      return "error";
    case "in_review":
      return "warning";
    case "in_progress":
      return "accent";
    default:
      return "neutral";
  }
}

function getPriorityLabel(priority: string) {
  return priority.toUpperCase();
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
    <section className="task-board-section" data-role="workflow-task-section">
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
                >
                  <td>
                    <button className="task-table__open" type="button" onClick={() => onOpenTask(task.id)}>
                      <strong>{task.number}</strong>
                      <span>{task.title}</span>
                    </button>
                  </td>
                  <td>{getPriorityLabel(task.priority)}</td>
                  <td>
                    <span className={`status-badge status-badge--${getStatusTone(task.status)}`}>{formatStatusLabel(task.status)}</span>
                  </td>
                  <td>{section.workflowName}</td>
                  <td>{resolveTaskAssigneeLabel(task, agents, roles)}</td>
                  <td>{task.commentCount}</td>
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
              <section className="task-lane-column" key={lane.laneId}>
                <div className="task-lane-column__header">
                  <strong>{lane.laneName}</strong>
                  <span>{lane.tasks.length}</span>
                </div>
                <div className="task-lane-column__list">
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
