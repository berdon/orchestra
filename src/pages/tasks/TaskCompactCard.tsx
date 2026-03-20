import type { TaskSummary } from "../../types";

interface TaskCompactCardProps {
  task: TaskSummary;
  assigneeLabel: string;
  onOpen: (taskId: string) => void;
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

export function TaskCompactCard({ task, assigneeLabel, onOpen }: TaskCompactCardProps) {
  return (
    <button
      className="task-compact-card"
      data-role="task-card"
      data-task-id={task.id}
      type="button"
      onClick={() => onOpen(task.id)}
    >
      <div className="task-compact-card__header">
        <span className="task-compact-card__number">{task.number}</span>
        <span className={`status-badge status-badge--${getStatusTone(task.status)}`}>{formatStatusLabel(task.status)}</span>
      </div>
      <strong className="task-compact-card__title" title={task.title}>
        {task.title}
      </strong>
      <div className="task-compact-card__meta">
        <span title={assigneeLabel}>{assigneeLabel}</span>
      </div>
    </button>
  );
}
