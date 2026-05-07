import { memo, useCallback, useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent, type PointerEvent as ReactPointerEvent } from "react";
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

interface SelectionCommentAction {
  anchor: FileCommentAnchor;
  top: number;
  left: number;
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

function lineRowFromNode(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  if (node instanceof HTMLElement) {
    return node.closest("[data-file-line-row]") as HTMLElement | null;
  }
  return node.parentElement?.closest("[data-file-line-row]") as HTMLElement | null;
}

function lineContentFromRow(row: HTMLElement | null) {
  return row?.querySelector("[data-file-line-content]") as HTMLElement | null;
}

function lineNumberFromRow(row: HTMLElement | null) {
  const value = row?.getAttribute("data-line-number") ?? "";
  const parsed = Number(value);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : null;
}

function textOffsetWithin(container: HTMLElement, node: Node, offset: number) {
  try {
    const range = document.createRange();
    range.setStart(container, 0);
    range.setEnd(node, offset);
    return range.toString().length;
  } catch {
    return null;
  }
}

function clampOverlayPosition(container: HTMLElement, top: number, left: number, width = 360) {
  return {
    top: Math.max(8, top),
    left: Math.max(8, Math.min(left, Math.max(container.clientWidth - width - 8, 8))),
  };
}

function buildSelectionCommentAction(
  viewport: HTMLElement,
  overlay: HTMLElement,
  reference: TaskFileReference,
  selection: Selection,
): SelectionCommentAction | null {
  if (!selection.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed || !viewport.contains(range.commonAncestorContainer)) {
    return null;
  }

  const startRow = lineRowFromNode(range.startContainer);
  const endRow = lineRowFromNode(range.endContainer);
  const startContent = lineContentFromRow(startRow);
  const endContent = lineContentFromRow(endRow);
  const startLine = lineNumberFromRow(startRow);
  const endLine = lineNumberFromRow(endRow);
  if (!startContent || !endContent || !startLine || !endLine) {
    return null;
  }

  const startOffset = textOffsetWithin(startContent, range.startContainer, range.startOffset);
  const endOffset = textOffsetWithin(endContent, range.endContainer, range.endOffset);
  if (startOffset == null || endOffset == null) {
    return null;
  }

  const selectedText = selection.toString();
  if (!selectedText.trim()) {
    return null;
  }

  const rangeRect = range.getBoundingClientRect();
  const overlayRect = overlay.getBoundingClientRect();
  const position = clampOverlayPosition(
    overlay,
    rangeRect.top - overlayRect.top - 44,
    rangeRect.right - overlayRect.left + 8,
    200,
  );

  return {
    anchor: {
      repositoryId: reference.repositoryId,
      relativePath: reference.relativePath,
      absolutePath: reference.absolutePath ?? null,
      lineStart: startLine,
      lineEnd: endLine,
      columnStart: startOffset + 1,
      columnEnd: Math.max(startLine === endLine ? startOffset + 1 : 1, endOffset),
      selectedText,
    },
    ...position,
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

function buildThreadsByLine(threads: TaskCommentThread[]) {
  const byLine = new Map<number, TaskCommentThread[]>();
  for (const thread of threads) {
    const start = thread.comment.lineStart ?? 0;
    const end = thread.comment.lineEnd ?? start;
    for (let line = start; line <= end; line += 1) {
      const entries = byLine.get(line) ?? [];
      entries.push(thread);
      byLine.set(line, entries);
    }
  }
  return byLine;
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
  const selectionSyncFrameRef = useRef<number | null>(null);
  const selectionInteractionModeRef = useRef<"pointer" | "keyboard" | null>(null);
  const [selectionAction, setSelectionAction] = useState<SelectionCommentAction | null>(null);
  const [floatingComment, setFloatingComment] = useState<FloatingCommentState | null>(null);
  const [threadPopover, setThreadPopover] = useState<ThreadPopoverState | null>(null);
  const [replyTargetCommentId, setReplyTargetCommentId] = useState<string | null>(null);
  const [replyMessage, setReplyMessage] = useState("");
  const [editingCommentId, setEditingCommentId] = useState<string | null>(null);
  const [editingMessage, setEditingMessage] = useState("");
  const [isMinimized, setIsMinimized] = useState(false);
  const [wrapLines, setWrapLines] = useState(true);
  const [selectionInteractionActive, setSelectionInteractionActive] = useState(false);

  const lines = useMemo(
    () => content.replace(/\r\n/g, "\n").split("\n").map((line, index) => ({
      number: index + 1,
      html: highlightLine(line, language),
    })),
    [content, language],
  );
  const fileCommentThreads = useMemo(() => buildFileCommentThreads(comments, reference), [comments, reference]);
  const commentCountsByLine = useMemo(() => lineCommentCounts(fileCommentThreads), [fileCommentThreads]);
  const commentThreadsByLine = useMemo(() => buildThreadsByLine(fileCommentThreads), [fileCommentThreads]);

  const cancelPendingSelectionSync = useCallback(() => {
    if (selectionSyncFrameRef.current !== null) {
      window.cancelAnimationFrame(selectionSyncFrameRef.current);
      selectionSyncFrameRef.current = null;
    }
  }, []);

  const setSelectionInteractionMode = useCallback((mode: "pointer" | "keyboard" | null) => {
    selectionInteractionModeRef.current = mode;
    setSelectionInteractionActive(mode !== null);
    if (mode) {
      setSelectionAction(null);
    }
  }, []);

  const scheduleSelectionSync = useCallback((force = false) => {
    cancelPendingSelectionSync();
    selectionSyncFrameRef.current = window.requestAnimationFrame(() => {
      selectionSyncFrameRef.current = null;
      const selection = window.getSelection();
      const overlay = overlayRef.current;
      const viewport = viewportRef.current;
      if (!overlay || !viewport || !selection || selection.isCollapsed || !viewport.contains(selection.anchorNode)) {
        setSelectionAction(null);
        return;
      }
      if (!force && selectionInteractionModeRef.current) {
        return;
      }
      setSelectionAction(buildSelectionCommentAction(viewport, overlay, reference, selection));
    });
  }, [cancelPendingSelectionSync, reference]);

  useEffect(() => {
    setSelectionInteractionMode(null);
    setSelectionAction(null);
    setFloatingComment(null);
    setThreadPopover(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
    setEditingCommentId(null);
    setEditingMessage("");
    cancelPendingSelectionSync();
  }, [cancelPendingSelectionSync, content, reference.absolutePath, reference.id, setSelectionInteractionMode]);

  useEffect(() => {
    const openSelectionComment = () => {
      window.requestAnimationFrame(() => {
        openSelectionCommentFromCurrentSelection();
      });
    };

    const openFileCommentDraft = (event: Event) => {
      const customEvent = event as CustomEvent<OpenFileCommentDraftDetail>;
      const detail = customEvent.detail;
      const overlay = overlayRef.current;
      if (!overlay || !detail?.anchor) {
        return;
      }
      const position = clampOverlayPosition(overlay, detail.top ?? 72, detail.left ?? 220);
      openFloatingComment(detail.anchor, position.top, position.left);
    };

    const syncSelectionAction = () => {
      scheduleSelectionSync();
    };

    const finalizeSelectionInteraction = () => {
      if (selectionInteractionModeRef.current) {
        setSelectionInteractionMode(null);
      }
      scheduleSelectionSync(true);
    };

    const beginKeyboardSelectionInteraction = (event: KeyboardEvent) => {
      if (!event.shiftKey) {
        return;
      }
      if (![
        "ArrowUp",
        "ArrowDown",
        "ArrowLeft",
        "ArrowRight",
        "Home",
        "End",
        "PageUp",
        "PageDown",
      ].includes(event.key)) {
        return;
      }
      const viewport = viewportRef.current;
      const selection = window.getSelection();
      if (!viewport || !selection?.anchorNode || !viewport.contains(selection.anchorNode)) {
        return;
      }
      setSelectionInteractionMode("keyboard");
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
      if ((target as HTMLElement).closest('.file-content-viewer__comment-popover, .file-content-viewer__thread-popover, [data-role="default-file-selection-comment-button"]')) {
        return;
      }
      closeOverlays();
    };

    document.addEventListener("selectionchange", syncSelectionAction);
    document.addEventListener("mouseup", finalizeSelectionInteraction);
    document.addEventListener("keydown", beginKeyboardSelectionInteraction);
    document.addEventListener("keyup", finalizeSelectionInteraction);
    document.addEventListener("orchestra:open-selected-file-comment", openSelectionComment as EventListener);
    document.addEventListener("orchestra:open-file-comment-draft", openFileCommentDraft as EventListener);
    document.addEventListener("pointerdown", closeOnOutsidePointer);
    (window as typeof window & { __orchestraOpenFileCommentDraft?: (detail: OpenFileCommentDraftDetail) => void }).__orchestraOpenFileCommentDraft = (detail) => {
      openFileCommentDraft(new CustomEvent("orchestra:open-file-comment-draft", { detail }));
    };

    return () => {
      cancelPendingSelectionSync();
      document.removeEventListener("selectionchange", syncSelectionAction);
      document.removeEventListener("mouseup", finalizeSelectionInteraction);
      document.removeEventListener("keydown", beginKeyboardSelectionInteraction);
      document.removeEventListener("keyup", finalizeSelectionInteraction);
      document.removeEventListener("orchestra:open-selected-file-comment", openSelectionComment as EventListener);
      document.removeEventListener("orchestra:open-file-comment-draft", openFileCommentDraft as EventListener);
      document.removeEventListener("pointerdown", closeOnOutsidePointer);
      delete (window as typeof window & { __orchestraOpenFileCommentDraft?: (detail: OpenFileCommentDraftDetail) => void }).__orchestraOpenFileCommentDraft;
    };
  }, [cancelPendingSelectionSync, reference, scheduleSelectionSync, setSelectionInteractionMode]);

  function closeOverlays() {
    setSelectionInteractionMode(null);
    setSelectionAction(null);
    setFloatingComment(null);
    setThreadPopover(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
    setEditingCommentId(null);
    setEditingMessage("");
  }

  function handleViewportPointerDown(event: ReactPointerEvent<HTMLDivElement>) {
    if (event.button !== 0) {
      return;
    }
    setSelectionInteractionMode("pointer");
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
      anchor,
      top: position.top,
      left: position.left,
      message: "",
    });
    setSelectionAction(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
  }

  function openSelectionCommentFromCurrentSelection() {
    const overlay = overlayRef.current;
    const viewport = viewportRef.current;
    const selection = window.getSelection();
    if (!overlay || !viewport || !selection) {
      return false;
    }

    const next = buildSelectionCommentAction(viewport, overlay, reference, selection);
    if (!next) {
      return false;
    }

    setSelectionAction(next);
    openFloatingComment(next.anchor, next.top, next.left);
    return true;
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
    setSelectionAction(null);
    setReplyTargetCommentId(null);
    setReplyMessage("");
    setThreadPopover({
      lineNumber,
      threads: matchingThreads,
      top: position.top,
      left: position.left,
    });
  }, [fileCommentThreads]);

  function handleSelectionCommentClick() {
    if (selectionAction) {
      openFloatingComment(selectionAction.anchor, selectionAction.top, selectionAction.left);
      return;
    }

    openSelectionCommentFromCurrentSelection();
  }

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
      selectedText: floatingComment.anchor.selectedText ?? null,
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
      const lineThreads = commentThreadsByLine.get(line.number) ?? [];
      const selectedTextThreads = lineThreads.filter((thread) => Boolean(thread.comment.selectedText && thread.comment.columnStart && thread.comment.columnEnd));
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
            {selectedTextThreads.map(({ comment }) => {
              const start = Math.max(1, comment.columnStart ?? 1);
              const end = Math.max(start, comment.columnEnd ?? start);
              const width = Math.max(1, end - start + 1);
              return (
                <button
                  key={comment.id}
                  className="file-content-viewer__selected-comment-anchor"
                  data-role="default-file-selected-comment-anchor"
                  style={{ left: `${start - 1}ch`, width: `${width}ch` }}
                  title={comment.message}
                  type="button"
                  onClick={(event) => {
                    event.preventDefault();
                    event.stopPropagation();
                    const overlay = overlayRef.current;
                    const target = event.currentTarget.getBoundingClientRect();
                    const overlayRect = overlay?.getBoundingClientRect();
                    if (!overlay || !overlayRect) {
                      return;
                    }
                    openThreadPopoverForLine(line.number, target.top - overlayRect.top + 24, target.right - overlayRect.left + 12);
                  }}
                >
                  <span className="file-content-viewer__selected-comment-highlight" />
                  <span className="file-content-viewer__selected-comment-icon">💬</span>
                </button>
              );
            })}
          </div>
        </div>
      );
    }),
    [commentCountsByLine, commentThreadsByLine, handleLineCommentClick, lines, openThreadPopoverForLine, wrapLines],
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
          selectionInteractionActive ? "file-content-viewer__shell--selection-active" : null,
        ].filter(Boolean).join(" ")}
        ref={overlayRef}
      >
        <div
          className={isMinimized ? "file-content-viewer__viewport file-content-viewer__viewport--minimized" : "file-content-viewer__viewport"}
          data-role="default-file-code-viewer"
          data-wrap-mode={wrapLines ? "wrap" : "nowrap"}
          onPointerDown={handleViewportPointerDown}
          ref={viewportRef}
        >
          {renderedLines}
        </div>

        {selectionAction ? (
          <button
            className="file-content-viewer__floating-button"
            data-role="default-file-selection-comment-button"
            style={{ top: `${selectionAction.top}px`, left: `${selectionAction.left}px` }}
            type="button"
            onClick={handleSelectionCommentClick}
          >
            💬 Comment
          </button>
        ) : null}

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
              {floatingComment.anchor.selectedText ? <span className="status-badge status-badge--accent">Selection</span> : null}
            </div>
            {floatingComment.anchor.selectedText ? (
              <pre className="file-content-viewer__selection-preview">{floatingComment.anchor.selectedText}</pre>
            ) : null}
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
                  {comment.selectedText ? <pre className="file-content-viewer__selection-preview">{comment.selectedText}</pre> : null}
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
