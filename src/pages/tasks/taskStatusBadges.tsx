import type { TaskSummary } from "../../types";

type StatusBadgeTone = "success" | "error" | "warning" | "accent" | "neutral";

interface TaskSummaryStatusBadgesProps {
  task: TaskSummary;
  assignmentCompact?: boolean;
  className?: string;
}

export function formatTaskStatusLabel(status: string) {
  return status.replace(/_/g, " ");
}

export function getTaskStatusTone(status: string): StatusBadgeTone {
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

function getTaskListAssignmentBadge(status?: string | null): { label: string; tone: StatusBadgeTone } | null {
  if (status !== "queued") {
    return null;
  }

  return {
    label: formatTaskStatusLabel(status),
    tone: "warning",
  };
}

export function TaskSummaryStatusBadges({ task, assignmentCompact = true, className }: TaskSummaryStatusBadgesProps) {
  const assignmentBadge = getTaskListAssignmentBadge(task.activeLaneAssignmentStatus);
  const badgesClassName = ["task-status-badges", className].filter(Boolean).join(" ");

  return (
    <div className={badgesClassName} data-role="task-status-badges">
      <span
        className={`status-badge status-badge--${getTaskStatusTone(task.status)}`}
        data-role="task-lifecycle-status-badge"
        data-task-status={task.status}
      >
        {formatTaskStatusLabel(task.status)}
      </span>
      {assignmentBadge ? (
        <span
          className={`status-badge status-badge--${assignmentBadge.tone}${assignmentCompact ? " status-badge--compact" : ""}`}
          data-role="task-assignment-status-badge"
          data-assignment-status={task.activeLaneAssignmentStatus ?? ""}
        >
          {assignmentBadge.label}
        </span>
      ) : null}
    </div>
  );
}
