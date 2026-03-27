import { useEffect, useMemo, useRef, useState, type MouseEvent as ReactMouseEvent } from "react";
import hljs from "highlight.js";

import type { TaskCommentInput, TaskFileReference } from "../types";

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

interface CommentableFileViewerProps {
  reference: TaskFileReference;
  content: string;
  language: string;
  commentDraft: TaskCommentInput;
  onCommentDraftChange: (draft: TaskCommentInput) => void;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
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

function clampPopoverPosition(container: HTMLElement, top: number, left: number) {
  return {
    top: Math.max(8, top),
    left: Math.max(8, Math.min(left, Math.max(container.scrollWidth - 280, 8))),
  };
}

function buildSelectionCommentAction(
  container: HTMLElement,
  reference: TaskFileReference,
  selection: Selection,
): SelectionCommentAction | null {
  if (!selection.rangeCount) {
    return null;
  }

  const range = selection.getRangeAt(0);
  if (range.collapsed || !container.contains(range.commonAncestorContainer)) {
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
  const containerRect = container.getBoundingClientRect();
  const position = clampPopoverPosition(
    container,
    rangeRect.top - containerRect.top + container.scrollTop - 42,
    rangeRect.right - containerRect.left + container.scrollLeft + 8,
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

export function CommentableFileViewer({
  reference,
  content,
  language,
  commentDraft,
  onCommentDraftChange,
  onAddComment,
}: CommentableFileViewerProps) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [selectionAction, setSelectionAction] = useState<SelectionCommentAction | null>(null);
  const [floatingComment, setFloatingComment] = useState<FloatingCommentState | null>(null);

  const lines = useMemo(
    () => content.replace(/\r\n/g, "\n").split("\n").map((line, index) => ({
      number: index + 1,
      html: highlightLine(line, language),
    })),
    [content, language],
  );

  useEffect(() => {
    setSelectionAction(null);
    setFloatingComment(null);
  }, [content, reference.absolutePath, reference.id]);

  useEffect(() => {
    function syncSelectionAction() {
      const selection = window.getSelection();
      const container = containerRef.current;
      if (!container || !selection || selection.isCollapsed || !container.contains(selection.anchorNode)) {
        setSelectionAction(null);
        return;
      }

      setSelectionAction(buildSelectionCommentAction(container, reference, selection));
    }

    const syncSelectionActionDeferred = () => {
      window.requestAnimationFrame(syncSelectionAction);
    };

    const openSelectionComment = () => {
      window.requestAnimationFrame(() => {
        openSelectionCommentFromCurrentSelection();
      });
    };

    const openFileCommentDraft = (event: Event) => {
      const customEvent = event as CustomEvent<OpenFileCommentDraftDetail>;
      const detail = customEvent.detail;
      if (!detail?.anchor) {
        return;
      }
      const container = containerRef.current;
      if (!container) {
        return;
      }
      const top = detail.top ?? container.scrollTop + 24;
      const left = detail.left ?? container.scrollLeft + 120;
      openFloatingComment(detail.anchor, top, left);
    };

    document.addEventListener("selectionchange", syncSelectionAction);
    document.addEventListener("mouseup", syncSelectionActionDeferred);
    document.addEventListener("orchestra:open-selected-file-comment", openSelectionComment as EventListener);
    document.addEventListener("orchestra:open-file-comment-draft", openFileCommentDraft as EventListener);
    (window as typeof window & { __orchestraOpenFileCommentDraft?: (detail: OpenFileCommentDraftDetail) => void }).__orchestraOpenFileCommentDraft = (detail) => {
      openFileCommentDraft(new CustomEvent("orchestra:open-file-comment-draft", { detail }));
    };
    return () => {
      document.removeEventListener("selectionchange", syncSelectionAction);
      document.removeEventListener("mouseup", syncSelectionActionDeferred);
      document.removeEventListener("orchestra:open-selected-file-comment", openSelectionComment as EventListener);
      document.removeEventListener("orchestra:open-file-comment-draft", openFileCommentDraft as EventListener);
      delete (window as typeof window & { __orchestraOpenFileCommentDraft?: (detail: OpenFileCommentDraftDetail) => void }).__orchestraOpenFileCommentDraft;
    };
  }, [reference]);

  function handleMouseUp() {
    window.requestAnimationFrame(() => {
      const container = containerRef.current;
      const selection = window.getSelection();
      if (!container || !selection) {
        setSelectionAction(null);
        return;
      }

      const next = buildSelectionCommentAction(container, reference, selection);
      setSelectionAction(next);
    });
  }

  function openFloatingComment(anchor: FileCommentAnchor, top: number, left: number) {
    const container = containerRef.current;
    if (!container) {
      return;
    }
    const position = clampPopoverPosition(container, top, left);
    setFloatingComment({
      anchor,
      top: position.top,
      left: position.left,
      message: "",
    });
    setSelectionAction(null);
  }

  function openSelectionCommentFromCurrentSelection() {
    const container = containerRef.current;
    const selection = window.getSelection();
    if (!container || !selection) {
      return false;
    }

    const next = buildSelectionCommentAction(container, reference, selection);
    if (!next) {
      return false;
    }

    setSelectionAction(next);
    openFloatingComment(next.anchor, next.top, next.left);
    return true;
  }

  function handleSelectionCommentClick() {
    if (selectionAction) {
      openFloatingComment(selectionAction.anchor, selectionAction.top, selectionAction.left);
      return;
    }

    openSelectionCommentFromCurrentSelection();
  }

  function handleLineCommentClick(lineNumber: number, event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault();
    event.stopPropagation();
    const container = containerRef.current;
    if (!container) {
      return;
    }

    window.getSelection()?.removeAllRanges();
    const buttonRect = event.currentTarget.getBoundingClientRect();
    const containerRect = container.getBoundingClientRect();
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
      buttonRect.top - containerRect.top + container.scrollTop - 12,
      buttonRect.right - containerRect.left + container.scrollLeft + 12,
    );
  }

  async function submitFloatingComment() {
    if (!floatingComment || !floatingComment.message.trim()) {
      return;
    }

    const created = await onAddComment({
      ...commentDraft,
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
      setFloatingComment(null);
      window.getSelection()?.removeAllRanges();
    }
  }

  return (
    <div className="file-content-viewer">
      <div
        className="file-content-viewer__code file-content-viewer__code--interactive"
        data-role="default-file-code-viewer"
        onMouseUp={handleMouseUp}
        ref={containerRef}
      >
        {lines.map((line) => (
          <div className="file-content-viewer__line" data-file-line-row data-line-number={String(line.number)} key={line.number}>
            <div className="file-content-viewer__line-gutter">
              <button
                className="file-content-viewer__line-comment-button"
                data-role="default-file-line-comment-button"
                data-line-number={String(line.number)}
                type="button"
                onClick={(event) => handleLineCommentClick(line.number, event)}
              >
                💬
              </button>
              <span className="file-content-viewer__line-number">{line.number}</span>
            </div>
            <div
              className="file-content-viewer__line-content"
              data-file-line-content
              dangerouslySetInnerHTML={{ __html: line.html }}
            />
          </div>
        ))}

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
            <label className="field-group">
              <span className="field-group__label">Author</span>
              <input
                className="text-input"
                data-role="default-file-comment-author"
                value={commentDraft.author}
                onChange={(event) => onCommentDraftChange({ ...commentDraft, author: event.target.value })}
              />
            </label>
            <label className="checkbox-row task-comment-composer__interrupt">
              <input
                data-role="default-file-comment-interrupt"
                type="checkbox"
                checked={commentDraft.interruptAgent}
                onChange={(event) => onCommentDraftChange({ ...commentDraft, interruptAgent: event.target.checked })}
              />
              Interrupt current worker now
            </label>
            <label className="field-group">
              <span className="field-group__label">Comment</span>
              <textarea
                className="text-area"
                data-role="default-file-comment-message"
                rows={3}
                value={floatingComment.message}
                onChange={(event) => setFloatingComment((current) => current ? { ...current, message: event.target.value } : current)}
              />
            </label>
            <div className="task-comment-composer__actions">
              <button className="primary-button" data-role="add-default-file-comment" type="button" onClick={() => void submitFloatingComment()}>
                Add comment
              </button>
              <button className="secondary-button" data-role="cancel-default-file-comment" type="button" onClick={() => setFloatingComment(null)}>
                Cancel
              </button>
            </div>
          </div>
        ) : null}
      </div>
    </div>
  );
}
