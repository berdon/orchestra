import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import hljs from "highlight.js";

import type { AgentSummary, RoleSummary, TaskComment, TaskCommentInput, TaskFileReference, TaskSummary } from "../types";
import { buildTaskCommentThreads, type TaskCommentThread } from "../lib/taskCommentThreads";
import { recordInputPerfRender } from "../lib/testInputPerformance";
import { formatTaskCommentLineLabel, isTaskCommentAnchoredToReference, taskCommentTouchesLine } from "../lib/taskComments";
import { TaskCommentComposer } from "./TaskCommentComposer";
import { TaskCommentMessage } from "./TaskCommentMessage";

interface FileCommentAnchor {
  repositoryId: string;
  relativePath: string;
  absolutePath?: string | null;
  lineStart: number;
  lineEnd: number;
  columnStart?: number | null;
  columnEnd?: number | null;
  selectedText?: string | null;
}

interface FloatingCommentState {
  anchor: FileCommentAnchor;
  top: number;
  left: number;
  message: string;
}

interface OpenFileCommentDraftDetail {
  anchor: FileCommentAnchor;
  top?: number;
  left?: number;
}

interface ThreadPopoverState {
  lineNumber: number;
  threads: TaskCommentThread[];
  top: number;
  left: number;
}

interface CommentableFileViewerProps {
  taskId: string;
  currentTaskTags: string[];
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  reference: TaskFileReference;
  fileReferences: TaskFileReference[];
  content: string;
  language: string;
  comments: TaskComment[];
  commentAuthor: string;
  commentInterruptAgent: boolean;
  onCommentInterruptChange: (interruptAgent: boolean) => void;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
  onUpdateComment: (commentId: string, message: string) => Promise<boolean>;
  onDeleteComment: (commentId: string) => Promise<boolean>;
  onOpenFileReference: (reference: TaskFileReference) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/\"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function highlightLine(code: string, language: string) {
  if (!code.length) {
    return "&nbsp;";
  }

  try {
    if (language && hljs.getLanguage(language)) {
      return hljs.highlight(code, { language, ignoreIllegals: true }).value || "&nbsp;";
    }
    return hljs.highlightAuto(code).value || "&nbsp;";
  } catch {
    return escapeHtml(code);
  }
}

function clampOverlayPosition(container: HTMLElement, top: number, left: number, width = 360) {
  return {
    top: Math.max(8, top),
    left: Math.max(8, Math.min(left, Math.max(container.clientWidth - width - 8, 8))),
  };
}

function normalizeFileCommentAnchor(anchor: FileCommentAnchor): FileCommentAnchor {
  if (!anchor.selectedText?.trim()) {
    return anchor;
  }

  return {
    ...anchor,
    columnStart: null,
    columnEnd: null,
    selectedText: null,
  };
}

function buildFileCommentThreads(comments: TaskComment[], reference: TaskFileReference) {
  return buildTaskCommentThreads(comments)
    .filter(({ comment }) => isTaskCommentAnchoredToReference(comment, reference));
}

function lineCommentCounts(threads: TaskCommentThread[]) {
  const counts = new Map<number, number>();
  for (const thread of threads) {
    const start = thread.comment.lineStart ?? 0;
    const end = thread.comment.lineEnd ?? start;
    for (let line = start; line <= end; line += 1) {
      counts.set(line, (counts.get(line) ?? 0) + 1);
    }
  }
  return counts;
}

export const CommentableFileViewer = memo(function CommentableFileViewer({
  taskId,
  currentTaskTags,
  tasks,
  agents,
  roles,
  reference,
  fileReferences,
  content,
  language,
  comments,
  commentAuthor,
  commentInterruptAgent,
  onCommentInterruptChange,
  onAddComment,
  onUpdateComment,
  onDeleteComment,
  onOpenFileReference,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
}: CommentableFileViewerProps) {
  recordInputPerfRender("default-file-viewer");
  const overlayRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const floatingCommentMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const [floatingComment, setFloatingComment] = useState<FloatingCommentState | null>(null);
  const [floatingCommentFocusToken, setFloatingCommentFocusToken] = useState(0);
  const [threadPopover, setThreadPopover] = useState<ThreadPopoverState | null>(null);
  const [replyTargetCommentId, setReplyTargetCommentId] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState("");
  const [isMinimized, setIsMinimized] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);

  const lines = useMemo(
    () => content.replace(/\r\n/g, "\n").split("\n").map((line, index) => ({
      number: index + 1,
      html: highlightLine(line, language),
    })),
    [content, language],
  );
  const fileCommentThreads = useMemo(() => buildFileCommentThreads(comments, reference), [comments, reference]);
  const commentCountsByLine = useMemo(() => lineCommentCounts(fileCommentThreads), [fileCommentThreads]);

  useEffect(() => {
    setFloatingComment(null);
    setThreadPopover(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
    setEditingCommentId(null);
    setEditingMessage("");
  }, [content, reference.absolutePath, reference.id]);

  useEffect(() => {
    if (!floatingComment || floatingCommentFocusToken === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const messageField = floatingCommentMessageRef.current;
      if (!messageField) {
        return;
      }
      try {
        messageField.focus({ preventScroll: true });
      } catch {
        messageField.focus();
      }
    });

    return () => {
      window.cancelAnimationFrame(frame);
    };
  }, [Boolean(floatingComment), floatingCommentFocusToken]);

  useEffect(() => {
    const openFileCommentDraft = (event: Event) => {
      const customEvent = event as CustomEvent<OpenFileCommentDraftDetail>;
      const detail = customEvent.detail;
      const overlay = overlayRef.current;
      if (!overlay || !detail?.anchor) {
        return;
      }
      const position = clampOverlayPosition(overlay, detail.top ?? 72, detail.left ?? 220);
      openFloatingComment(normalizeFileCommentAnchor(detail.anchor), position.top, position.left);
    };

    const closeOnOutsidePointer = (event: Event) => {
      const target = event.target;
      if (!(target instanceof Node)) {
        return;
      }
      const overlay = overlayRef.current;
      if (!overlay?.contains(target)) {
        closeOverlays();
        return;
      }
      if ((target as HTMLElement).closest('.file-content-viewer__comment-popover, .file-content-viewer__thread-popover')) {
        return;
      }
      closeOverlays();
    };

    document.addEventListener("orchestra:open-file-comment-draft", openFileCommentDraft as EventListener);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    (window as typeof window & { __orchestraOpenFileCommentDraft?: (detail: OpenFileCommentDraftDetail) => void }).__orchestraOpenFileCommentDraft = (detail) => {
      openFileCommentDraft(new CustomEvent("orchestra:open-file-comment-draft", { detail }));
    };

    return () => {
      document.removeEventListener("orchestra:open-file-comment-draft", openFileCommentDraft as EventListener);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      delete (window as typeof window & { __orchestraOpenFileCommentDraft?: (detail: OpenFileCommentDraftDetail) => void }).__orchestraOpenFileCommentDraft;
    };
  }, []);

  function closeOverlays() {
    setFloatingComment(null);
    setThreadPopover(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
    setEditingCommentId(null);
    setEditingMessage("");
  }

  function handleScrollToBottom() {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }
    viewport.scrollTop = viewport.scrollHeight;
  }

  function openFloatingComment(anchor: FileCommentAnchor, top: number, left: number) {
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }
    const position = clampOverlayPosition(overlay, top, left);
    setThreadPopover(null);
    setFloatingComment({
      anchor: normalizeFileCommentAnchor(anchor),
      top: position.top,
      left: position.left,
      message: "",
    });
    setFloatingCommentFocusToken((current) => current + 1);
    setReplyTargetCommentId(null);
    setReplyMessage("");
  }

  const openThreadPopoverForLine = useCallback((lineNumber: number, top: number, left: number) => {
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }
    const matchingThreads = fileCommentThreads.filter((thread) => taskCommentTouchesLine(thread.comment, lineNumber));
    if (!matchingThreads.length) {
      return;
    }

    const position = clampOverlayPosition(overlay, top, left);
    setFloatingComment(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
    setThreadPopover({
      lineNumber,
      threads: matchingThreads,
      top: position.top,
      left: position.left,
    });
  }, [fileCommentThreads]);

  const handleLineCommentClick = useCallback((lineNumber: number, event: ReactMouseEvent<HTMLButtonElement>) => {
    event.preventDefault();
    event.stopPropagation();
    const overlay = overlayRef.current;
    if (!overlay) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const overlayRect = overlay.getBoundingClientRect();
    const top = buttonRect.top - overlayRect.top - 12;
    const left = buttonRect.right - overlayRect.left + 12;
    const hasExistingComments = (commentCountsByLine.get(lineNumber) ?? 0) > 0;

    if (hasExistingComments) {
      openThreadPopoverForLine(lineNumber, top, left);
      return;
    }

    openFloatingComment(
      {
        repositoryId: reference.repositoryId,
        relativePath: reference.relativePath,
        absolutePath: reference.absolutePath ?? null,
        lineStart: lineNumber,
        lineEnd: lineNumber,
        columnStart: null,
        columnEnd: null,
        selectedText: null,
      },
      top,
      left,
    );
  }, [commentCountsByLine, openFloatingComment, openThreadPopoverForLine, reference.absolutePath, reference.relativePath, reference.repositoryId]);

  async function submitFloatingComment() {
    if (!floatingComment || !floatingComment.message.trim()) {
      return;
    }

    const created = await onAddComment({
      author: commentAuthor,
      interruptAgent: commentInterruptAgent,
      message: floatingComment.message,
      parentCommentId: null,
      repositoryId: floatingComment.anchor.repositoryId,
      relativePath: floatingComment.anchor.relativePath,
      absolutePath: floatingComment.anchor.absolutePath ?? null,
      lineStart: floatingComment.anchor.lineStart,
      lineEnd: floatingComment.anchor.lineEnd,
      columnStart: floatingComment.anchor.columnStart ?? null,
      columnEnd: floatingComment.anchor.columnEnd ?? null,
      selectedText: null,
    });

    if (created) {
      closeOverlays();
      window.getSelection()?.removeAllRanges();
    }
  }

  async function submitReply(parentCommentId: string) {
    if (!replyMessage.trim()) {
      return;
    }

    const created = await onAddComment({
      author: commentAuthor,
      interruptAgent: commentInterruptAgent,
      message: replyMessage,
      parentCommentId,
      repositoryId: null,
      relativePath: null,
      absolutePath: null,
      lineStart: null,
      lineEnd: null,
      columnStart: null,
      columnEnd: null,
      selectedText: null,
    });

    if (created) {
      setReplyTargetCommentId(null);
      setReplyMessage("");
    }
  }

  async function submitEdit(commentId: string) {
    if (!editingMessage.trim()) {
      return;
    }
    const updated = await onUpdateComment(commentId, editingMessage);
    if (updated) {
      setEditingCommentId(null);
      setEditingMessage("");
    }
  }

  async function handleDelete(commentId: string) {
    const deleted = await onDeleteComment(commentId);
    if (deleted) {
      setEditingCommentId(null);
      setEditingMessage("");
      setReplyTargetCommentId(null);
      setReplyMessage("");
    }
  }

  const renderedLines = useMemo(
    () => lines.map((line) => {
      const commentCount = commentCountsByLine.get(line.number) ?? 0;
      return (
        <div
          className={commentCount > 0 ? "file-content-viewer__line file-content-viewer__line--commented" : "file-content-viewer__line"}
          data-file-line-row
          data-line-number={String(line.number)}
          key={line.number}
        >
          <div className="file-content-viewer__line-gutter">
            <button
              className={commentCount > 0 ? "file-content-viewer__line-comment-button file-content-viewer__line-comment-button--active" : "file-content-viewer__line-comment-button"}
              data-role="default-file-line-comment-button"
              data-line-number={String(line.number)}
              type="button"
              onClick={(event) => handleLineCommentClick(line.number, event)}
            >
              💬
              {commentCount > 0 ? <span className="file-content-viewer__line-comment-count">{commentCount}</span> : null}
            </button>
            <span className="file-content-viewer__line-number">{line.number}</span>
          </div>
          <div className="file-content-viewer__line-content-wrap">
            <div
              className={wrapLines ? "file-content-viewer__line-content file-content-viewer__line-content--wrapped" : "file-content-viewer__line-content file-content-viewer__line-content--nowrap"}
              data-file-line-content
              dangerouslySetInnerHTML={{ __html: line.html }}
            />
          </div>
        </div>
      );
    }),
    [commentCountsByLine, handleLineCommentClick, lines, wrapLines],
  );

  return (
    <div className="file-content-viewer">
      <div className="file-content-viewer__header">
        <strong>File preview</strong>
        <div className="action-cluster action-cluster--wrap">
          <button
            className="secondary-button"
            data-role="default-file-scroll-bottom"
            type="button"
            onClick={handleScrollToBottom}
          >
            Bottom
          </button>
          <button
            className="transcript-wrap-toggle"
            data-role="default-file-wrap-toggle"
            data-wrap-mode={wrapLines ? "wrap" : "nowrap"}
            type="button"
            aria-pressed={wrapLines}
            aria-label={wrapLines ? "Disable file line wrapping" : "Enable file line wrapping"}
            title={wrapLines ? "Disable file line wrapping" : "Enable file line wrapping"}
            onClick={() => setWrapLines((current) => !current)}
          >
            <span aria-hidden="true">{wrapLines ? "↩" : "↔"}</span>
            <span>{wrapLines ? "Wrap" : "No wrap"}</span>
          </button>
          <button
            className="secondary-button"
            data-role="default-file-viewer-toggle"
            type="button"
            onClick={() => setIsMinimized((current) => !current)}
          >
            {isMinimized ? "Expand" : "Minimize"}
          </button>
        </div>
      </div>

      <div
        className={[
          "file-content-viewer__shell",
          isMinimized ? "file-content-viewer__shell--minimized" : null,
        ].filter(Boolean).join(" ")}
        ref={overlayRef}
      >
        <div
          className={isMinimized ? "file-content-viewer__viewport file-content-viewer__viewport--minimized" : "file-content-viewer__viewport"}
          data-role="default-file-code-viewer"
          data-wrap-mode={wrapLines ? "wrap" : "nowrap"}
          ref={viewportRef}
        >
          {renderedLines}
        </div>

        {floatingComment ? (
          <div
            className="file-content-viewer__comment-popover"
            data-role="default-file-comment-popover"
            style={{ top: `${floatingComment.top}px`, left: `${floatingComment.left}px` }}
          >
            <div className="file-content-viewer__comment-meta">
              <strong>
                {floatingComment.anchor.lineStart === floatingComment.anchor.lineEnd
                  ? `Line ${floatingComment.anchor.lineStart}`
                  : `Lines ${floatingComment.anchor.lineStart}-${floatingComment.anchor.lineEnd}`}
              </strong>
            </div>
            <TaskCommentComposer
              taskId={taskId}
              tasks={tasks}
              agents={agents}
              roles={roles}
              currentTaskTags={currentTaskTags}
              className="task-comment-composer"
              interruptChecked={commentInterruptAgent}
              interruptDataRole="default-file-comment-interrupt"
              message={floatingComment.message}
              messageDataRole="default-file-comment-message"
              messageLabel="Comment"
              mentionListDataRole="default-file-comment-mention-list"
              mentionOptionDataRole="default-file-comment-mention-option"
              messageRef={floatingCommentMessageRef}
              onInterruptChange={onCommentInterruptChange}
              onMessageChange={(message) => setFloatingComment((current) => current ? { ...current, message } : current)}
              onSubmit={() => void submitFloatingComment()}
              rows={3}
              submitDataRole="add-default-file-comment"
              submitLabel="Add comment"
              cancelDataRole="cancel-default-file-comment"
              cancelLabel="Cancel"
              onCancel={closeOverlays}
            />
          </div>
        ) : null}

        {threadPopover ? (
          <div
            className="file-content-viewer__thread-popover"
            data-role="default-file-thread-popover"
            style={{ top: `${threadPopover.top}px`, left: `${threadPopover.left}px` }}
          >
            <div className="file-content-viewer__comment-meta">
              <strong>Comments on line {threadPopover.lineNumber}</strong>
              <button className="secondary-button" type="button" onClick={closeOverlays}>Close</button>
            </div>
            <div className="file-content-viewer__thread-list">
              {threadPopover.threads.map(({ comment, replies }) => (
                <article className="file-content-viewer__thread-card" key={comment.id}>
                  <div className="transcript-event__meta">
                    <span>{comment.author}</span>
                    <div className="transcript-event__meta-group">
                      {formatTaskCommentLineLabel(comment) ? <span className="status-badge status-badge--accent">{formatTaskCommentLineLabel(comment)}</span> : null}
                      <time dateTime={comment.updatedAt}>{new Date(comment.updatedAt).toLocaleString()}</time>
                    </div>
                  </div>
                  {editingCommentId === comment.id ? (
                    <label className="field-group">
                      <span className="field-group__label">Edit comment</span>
                      <textarea
                        className="text-area"
                        data-role="default-file-edit-message"
                        rows={3}
                        value={editingMessage}
                        onChange={(event) => setEditingMessage(event.target.value)}
                      />
                    </label>
                  ) : (
                    <TaskCommentMessage
                      dataRole="task-comment-mention-link"
                      fileReferences={fileReferences}
                      tasks={tasks}
                      agents={agents}
                      roles={roles}
                      message={comment.message}
                      onOpenFileReference={onOpenFileReference}
                      onOpenTask={onOpenTask}
                      onOpenAgent={onOpenAgent}
                      onOpenRole={onOpenRole}
                    />
                  )}
                  {replies.length ? (
                    <div className="file-content-viewer__thread-replies">
                      {replies.map((reply) => (
                        <article className="file-content-viewer__thread-reply" key={reply.id}>
                          <div className="transcript-event__meta">
                            <span>{reply.author}</span>
                            <time dateTime={reply.updatedAt}>{new Date(reply.updatedAt).toLocaleString()}</time>
                          </div>
                          {editingCommentId === reply.id ? (
                            <label className="field-group">
                              <span className="field-group__label">Edit reply</span>
                              <textarea
                                className="text-area"
                                data-role="default-file-edit-message"
                                rows={3}
                                value={editingMessage}
                                onChange={(event) => setEditingMessage(event.target.value)}
                              />
                            </label>
                          ) : (
                            <TaskCommentMessage
                              dataRole="task-comment-mention-link"
                              fileReferences={fileReferences}
                              tasks={tasks}
                              agents={agents}
                              roles={roles}
                              message={reply.message}
                              onOpenFileReference={onOpenFileReference}
                              onOpenTask={onOpenTask}
                              onOpenAgent={onOpenAgent}
                              onOpenRole={onOpenRole}
                            />
                          )}
                          <div className="file-content-viewer__thread-actions">
                            {editingCommentId === reply.id ? (
                              <>
                                <button className="secondary-button" data-role="default-file-save-edit" type="button" onClick={() => void submitEdit(reply.id)}>Save</button>
                                <button className="secondary-button" type="button" onClick={() => {
                                  setEditingCommentId(null);
                                  setEditingMessage("");
                                }}>Cancel</button>
                              </>
                            ) : (
                              <>
                                <button
                                  className="secondary-button file-content-viewer__icon-button"
                                  data-role="default-file-edit-comment"
                                  type="button"
                                  title="Edit reply"
                                  onClick={() => {
                                    setEditingCommentId(reply.id);
                                    setEditingMessage(reply.message);
                                  }}
                                >
                                  ✏️
                                </button>
                                <button
                                  className="secondary-button secondary-button--danger file-content-viewer__icon-button"
                                  data-role="default-file-delete-comment"
                                  type="button"
                                  title="Delete reply"
                                  onClick={() => void handleDelete(reply.id)}
                                >
                                  🗑
                                </button>
                              </>
                            )}
                          </div>
                        </article>
                      ))}
                    </div>
                  ) : null}
                  {replyTargetCommentId === comment.id ? (
                    <TaskCommentComposer
                      taskId={taskId}
                      tasks={tasks}
                      agents={agents}
                      roles={roles}
                      currentTaskTags={currentTaskTags}
                      className="file-content-viewer__reply-composer"
                      message={replyMessage}
                      messageDataRole="default-file-reply-message"
                      messageLabel="Reply"
                      mentionListDataRole="default-file-reply-mention-list"
                      mentionOptionDataRole="default-file-reply-mention-option"
                      onMessageChange={setReplyMessage}
                      onSubmit={() => void submitReply(comment.id)}
                      rows={3}
                      submitDataRole="add-default-file-reply"
                      submitLabel="Add reply"
                      onCancel={() => {
                        setReplyTargetCommentId(null);
                        setReplyMessage("");
                      }}
                    />
                  ) : null}
                  <div className="file-content-viewer__thread-actions">
                    {editingCommentId === comment.id ? (
                      <>
                        <button className="secondary-button" data-role="default-file-save-edit" type="button" onClick={() => void submitEdit(comment.id)}>Save</button>
                        <button className="secondary-button" type="button" onClick={() => {
                          setEditingCommentId(null);
                          setEditingMessage("");
                        }}>Cancel</button>
                      </>
                    ) : (
                      <>
                        <button
                          className="secondary-button file-content-viewer__icon-button"
                          data-role="default-file-open-reply"
                          type="button"
                          title="Reply"
                          onClick={() => {
                            setReplyTargetCommentId(comment.id);
                            setReplyMessage("");
                          }}
                        >
                          ↩
                        </button>
                        <button
                          className="secondary-button file-content-viewer__icon-button"
                          data-role="default-file-edit-comment"
                          type="button"
                          title="Edit comment"
                          onClick={() => {
                            setEditingCommentId(comment.id);
                            setEditingMessage(comment.message);
                          }}
                        >
                          ✏️
                        </button>
                        <button
                          className="secondary-button secondary-button--danger file-content-viewer__icon-button"
                          data-role="default-file-delete-comment"
                          type="button"
                          title="Delete comment"
                          onClick={() => void handleDelete(comment.id)}
                        >
                          🗑
                        </button>
                      </>
                    )}
                  </div>
                </article>
              ))}
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
});
