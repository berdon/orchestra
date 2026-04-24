import type { KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from "react";

import { getTaskTags } from "../../lib/taskListQuery";
import type { TaskSummary } from "../../types";

interface TaskTagListProps {
  task: Pick<TaskSummary, "tags">;
  maxVisible: number;
  emptyPlaceholder?: string;
  className?: string;
  onTagClick?: (tag: string) => void;
}

export function TaskTagList({ task, maxVisible, emptyPlaceholder, className, onTagClick }: TaskTagListProps) {
  const tags = getTaskTags(task);

  if (tags.length === 0) {
    if (!emptyPlaceholder) {
      return null;
    }
    return <span className={className ? `task-tag-list task-tag-list--empty ${className}` : "task-tag-list task-tag-list--empty"}>{emptyPlaceholder}</span>;
  }

  const visibleTags = tags.slice(0, maxVisible);
  const overflowCount = tags.length - visibleTags.length;
  const fullLabel = tags.map((tag) => `#${tag}`).join(", ");
  const classes = className ? `task-tag-list ${className}` : "task-tag-list";

  function handleTagClick(event: ReactMouseEvent<HTMLButtonElement>, tag: string) {
    event.preventDefault();
    event.stopPropagation();
    onTagClick?.(tag);
  }

  function handleTagKeyDown(event: ReactKeyboardEvent<HTMLButtonElement>) {
    if (event.key === "Enter" || event.key === " ") {
      event.stopPropagation();
    }
  }

  return (
    <div className={classes} data-role="task-tag-list" title={fullLabel} aria-label={`Tags: ${fullLabel}`}>
      {visibleTags.map((tag) => onTagClick ? (
        <button
          aria-label={`Show tasks tagged ${tag}`}
          className="task-tag-list__chip task-tag-list__chip--interactive"
          data-role="task-tag-chip"
          data-tag-value={tag}
          key={tag}
          type="button"
          onClick={(event) => handleTagClick(event, tag)}
          onKeyDown={handleTagKeyDown}
        >
          #{tag}
        </button>
      ) : (
        <span className="task-tag-list__chip" data-role="task-tag-chip" data-tag-value={tag} key={tag}>
          #{tag}
        </span>
      ))}
      {overflowCount > 0 ? (
        <span className="task-tag-list__chip task-tag-list__chip--overflow" data-role="task-tag-overflow">
          +{overflowCount}
        </span>
      ) : null}
    </div>
  );
}
