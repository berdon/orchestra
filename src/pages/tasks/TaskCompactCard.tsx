import type { KeyboardEvent as ReactKeyboardEvent } from "react";

import { shouldShowUnreadCommentAttention } from "../../lib/taskUnreadCommentVisibility";
import type { TaskSummary } from "../../types";
import { TaskTagList } from "./TaskTagList";
import { TaskSummaryStatusBadges } from "./taskStatusBadges";

interface TaskCompactCardProps {
  task: TaskSummary;
  assigneeLabel: string;
  onOpen: (taskId: string) => void;
  onOpenTag?: (tag: string) => void;
}

export function TaskCompactCard({ task, assigneeLabel, onOpen, onOpenTag }: TaskCompactCardProps) {
  const workflowMissing = !task.workflowId;

  function handleKeyDown(event: ReactKeyboardEvent<HTMLDivElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(task.id);
    }
  }

  return (
    <div
      aria-label={`Open task ${task.number}: ${task.title}`}
      className={workflowMissing ? "task-compact-card task-overview-card task-overview-card--warning" : "task-compact-card task-overview-card"}
      data-role="task-card"
      data-task-id={task.id}
      data-missing-workflow={workflowMissing ? "true" : "false"}
      role="button"
      tabIndex={0}
      onClick={() => onOpen(task.id)}
      onKeyDown={handleKeyDown}
    >
      <div className="task-compact-card__header">
        <span className="task-compact-card__number">{task.number}</span>
        <TaskSummaryStatusBadges task={task} />
      </div>
      <strong className="task-compact-card__title" title={task.title}>
        {task.title}
      </strong>
      {workflowMissing ? (
        <div className="task-compact-card__warning" data-role="task-card-missing-workflow-warning">
          <span className="status-badge status-badge--warning status-badge--compact" data-role="task-card-missing-workflow-badge">No workflow</span>
          <span>Assign a workflow to place this task in lanes.</span>
        </div>
      ) : null}
      <TaskTagList className="task-compact-card__tags" maxVisible={2} onTagClick={onOpenTag} task={task} />
      <div className="task-compact-card__meta">
        <span title={assigneeLabel}>{assigneeLabel}</span>
        {shouldShowUnreadCommentAttention(task) ? (
          <span
            className="status-badge status-badge--warning status-badge--compact"
            data-role="task-card-unread-comments-badge"
            title={`${task.unreadCommentCount} unread comment${task.unreadCommentCount === 1 ? "" : "s"}`}
          >
            {task.unreadCommentCount} unread
          </span>
        ) : null}
      </div>
    </div>
  );
}
