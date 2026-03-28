import { TaskCommentMentionsTextarea } from "./TaskCommentMentionsTextarea";

interface TaskCommentComposerProps {
  taskId: string;
  message: string;
  onMessageChange: (message: string) => void;
  onSubmit: () => void;
  submitLabel: string;
  submitDataRole: string;
  messageLabel: string;
  messageDataRole: string;
  mentionListDataRole: string;
  mentionOptionDataRole: string;
  rows?: number;
  className?: string;
  compactMeta?: boolean;
  author?: string;
  authorLabel?: string;
  authorDataRole?: string;
  onAuthorChange?: (author: string) => void;
  interruptChecked?: boolean;
  interruptDataRole?: string;
  interruptLabel?: string;
  onInterruptChange?: (checked: boolean) => void;
  cancelLabel?: string;
  cancelDataRole?: string;
  onCancel?: () => void;
}

export function TaskCommentComposer({
  taskId,
  message,
  onMessageChange,
  onSubmit,
  submitLabel,
  submitDataRole,
  messageLabel,
  messageDataRole,
  mentionListDataRole,
  mentionOptionDataRole,
  rows = 4,
  className = "task-comment-composer",
  compactMeta = false,
  author,
  authorLabel = "Author",
  authorDataRole,
  onAuthorChange,
  interruptChecked,
  interruptDataRole,
  interruptLabel = "Interrupt current worker now",
  onInterruptChange,
  cancelLabel,
  cancelDataRole,
  onCancel,
}: TaskCommentComposerProps) {
  const hasMetaControls = Boolean((authorDataRole && onAuthorChange) || (interruptDataRole && onInterruptChange));

  return (
    <div className={className}>
      {hasMetaControls ? (
        <div className={compactMeta ? "task-comment-composer__grid task-comment-composer__grid--compact" : "task-comment-composer__grid"}>
          {authorDataRole && onAuthorChange ? (
            <label className="field-group">
              <span className="field-group__label">{authorLabel}</span>
              <input className="text-input" data-role={authorDataRole} value={author ?? ""} onChange={(event) => onAuthorChange(event.target.value)} />
            </label>
          ) : null}
          {interruptDataRole && onInterruptChange ? (
            <label className="checkbox-row task-comment-composer__interrupt">
              <input data-role={interruptDataRole} type="checkbox" checked={Boolean(interruptChecked)} onChange={(event) => onInterruptChange(event.target.checked)} />
              {interruptLabel}
            </label>
          ) : null}
        </div>
      ) : null}

      <label className="field-group">
        <span className="field-group__label">{messageLabel}</span>
        <TaskCommentMentionsTextarea
          taskId={taskId}
          value={message}
          rows={rows}
          dataRole={messageDataRole}
          listDataRole={mentionListDataRole}
          optionDataRole={mentionOptionDataRole}
          onChange={onMessageChange}
        />
      </label>

      <div className="task-comment-composer__actions">
        <button className="primary-button" data-role={submitDataRole} type="button" onClick={onSubmit}>
          {submitLabel}
        </button>
        {onCancel ? (
          <button className="secondary-button" data-role={cancelDataRole} type="button" onClick={onCancel}>
            {cancelLabel ?? "Cancel"}
          </button>
        ) : null}
      </div>
    </div>
  );
}
