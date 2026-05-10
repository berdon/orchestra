import { useEffect, useMemo, useRef, useState } from "react";

import type {
  AgentSummary,
  RoleSummary,
  TaskComment,
  TaskCommentInput,
  TaskFileReference,
  TaskPullRequestFile,
  TaskSummary,
} from "../types";
import { buildTaskCommentThreads, type TaskCommentThread } from "../lib/taskCommentThreads";
import { TaskCommentComposer } from "./TaskCommentComposer";
import { TaskCommentMessage } from "./TaskCommentMessage";

export interface ParsedDiffLine {
  kind: "context" | "add" | "del" | "meta";
  content: string;
  oldLineNumber: number | null;
  newLineNumber: number | null;
  key: string;
}

export interface ParsedDiffHunk {
  header: string;
  oldStart: number;
  oldCount: number;
  newStart: number;
  newCount: number;
  lines: ParsedDiffLine[];
}

interface ParsedSplitDiffRow {
  key: string;
  oldLine: ParsedDiffLine | null;
  newLine: ParsedDiffLine | null;
  metaLine?: ParsedDiffLine | null;
}

interface ParsedDiffGap {
  key: string;
  oldCount: number;
  oldStart: number | null;
  oldEnd: number | null;
  newCount: number;
  newStart: number | null;
  newEnd: number | null;
}

interface RenderedDiffLineState {
  side: "old" | "new";
  line: ParsedDiffLine | null;
  lineKey: string | null;
  lineNumber: number | null;
  kind: ParsedDiffLine["kind"] | "empty";
  marker: string;
  commentable: boolean;
  lineThreads: TaskCommentThread[];
  isDraftOpen: boolean;
}

interface TaskDiffViewerProps {
  taskId: string;
  tasks: TaskSummary[];
  agents: AgentSummary[];
  roles: RoleSummary[];
  file: TaskPullRequestFile;
  fileReferences: TaskFileReference[];
  comments: TaskComment[];
  commentAuthor: string;
  onAddComment: (draft: TaskCommentInput) => Promise<boolean>;
  onOpenFileReference: (reference: TaskFileReference) => void;
  onOpenTask: (taskId: string) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
}

interface DraftState {
  anchor: TaskCommentInput;
  side: "old" | "new";
  lineKey: string;
}

function lineKey(side: "old" | "new", lineNumber: number | null) {
  return lineNumber == null ? null : `${side}:${lineNumber}`;
}

function resolveLineThreadKey(line: ParsedDiffLine) {
  return line.kind === "del"
    ? lineKey("old", line.oldLineNumber)
    : lineKey("new", line.newLineNumber) ?? lineKey("old", line.oldLineNumber);
}

function isCommentableDiffLine(line: ParsedDiffLine) {
  return line.kind === "add" || line.kind === "del";
}

function buildSplitDiffRows(hunk: ParsedDiffHunk): ParsedSplitDiffRow[] {
  const rows: ParsedSplitDiffRow[] = [];

  for (let index = 0; index < hunk.lines.length;) {
    const line = hunk.lines[index];
    if (line.kind === "meta") {
      rows.push({ key: `meta:${hunk.header}:${line.key}`, oldLine: null, newLine: null, metaLine: line });
      index += 1;
      continue;
    }
    if (line.kind === "context") {
      rows.push({ key: `ctx:${hunk.header}:${line.key}`, oldLine: line, newLine: line });
      index += 1;
      continue;
    }

    const deleted: ParsedDiffLine[] = [];
    const added: ParsedDiffLine[] = [];
    while (index < hunk.lines.length) {
      const candidate = hunk.lines[index];
      if (candidate.kind === "del") {
        deleted.push(candidate);
        index += 1;
        continue;
      }
      if (candidate.kind === "add") {
        added.push(candidate);
        index += 1;
        continue;
      }
      break;
    }

    const rowCount = Math.max(deleted.length, added.length);
    for (let rowIndex = 0; rowIndex < rowCount; rowIndex += 1) {
      const oldLine = deleted[rowIndex] ?? null;
      const newLine = added[rowIndex] ?? null;
      rows.push({
        key: `chg:${hunk.header}:${oldLine?.key ?? ""}:${newLine?.key ?? ""}:${rowIndex}`,
        oldLine,
        newLine,
      });
    }
  }

  return rows;
}

function buildHunkGap(previous: ParsedDiffHunk, next: ParsedDiffHunk): ParsedDiffGap | null {
  const previousOldEnd = previous.oldStart + previous.oldCount - 1;
  const previousNewEnd = previous.newStart + previous.newCount - 1;
  const oldStart = previous.oldCount === 0 ? previous.oldStart : previousOldEnd + 1;
  const newStart = previous.newCount === 0 ? previous.newStart : previousNewEnd + 1;
  const oldEnd = next.oldStart - 1;
  const newEnd = next.newStart - 1;
  const oldCount = oldEnd >= oldStart ? oldEnd - oldStart + 1 : 0;
  const newCount = newEnd >= newStart ? newEnd - newStart + 1 : 0;

  if (Math.max(oldCount, newCount) <= 0) {
    return null;
  }

  return {
    key: `gap:${previous.header}:${next.header}`,
    oldCount,
    oldStart: oldCount ? oldStart : null,
    oldEnd: oldCount ? oldEnd : null,
    newCount,
    newStart: newCount ? newStart : null,
    newEnd: newCount ? newEnd : null,
  };
}

function formatGapRange(label: string, start: number | null, end: number | null) {
  if (start == null || end == null) {
    return null;
  }
  return start === end ? `${label} ${start}` : `${label} ${start}-${end}`;
}

function formatGapLabel(gap: ParsedDiffGap) {
  const skippedCount = Math.max(gap.oldCount, gap.newCount);
  const label = skippedCount === 1 ? "Skipped 1 unchanged line" : `Skipped ${skippedCount} unchanged lines`;
  const details = [
    formatGapRange("Base", gap.oldStart, gap.oldEnd),
    formatGapRange("Current", gap.newStart, gap.newEnd),
  ].filter(Boolean);
  return details.length ? `${label} · ${details.join(" · ")}` : label;
}

export function parseUnifiedDiff(patch?: string | null): ParsedDiffHunk[] {
  if (!patch?.trim()) {
    return [];
  }

  const hunks: ParsedDiffHunk[] = [];
  let currentHunk: ParsedDiffHunk | null = null;
  let oldLine = 0;
  let newLine = 0;
  let metaIndex = 0;

  for (const rawLine of patch.split(/\r?\n/)) {
    const hunkMatch = rawLine.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/);
    if (hunkMatch) {
      currentHunk = {
        header: rawLine,
        oldStart: Number(hunkMatch[1]),
        oldCount: Number(hunkMatch[2] ?? "1"),
        newStart: Number(hunkMatch[3]),
        newCount: Number(hunkMatch[4] ?? "1"),
        lines: [],
      };
      hunks.push(currentHunk);
      oldLine = currentHunk.oldStart;
      newLine = currentHunk.newStart;
      continue;
    }
    if (!currentHunk) {
      continue;
    }
    if (rawLine.startsWith("+")) {
      currentHunk.lines.push({
        kind: "add",
        content: rawLine.slice(1),
        oldLineNumber: null,
        newLineNumber: newLine,
        key: `new:${newLine}`,
      });
      newLine += 1;
      continue;
    }
    if (rawLine.startsWith("-") && !rawLine.startsWith("---")) {
      currentHunk.lines.push({
        kind: "del",
        content: rawLine.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: null,
        key: `old:${oldLine}`,
      });
      oldLine += 1;
      continue;
    }
    if (rawLine.startsWith(" ")) {
      currentHunk.lines.push({
        kind: "context",
        content: rawLine.slice(1),
        oldLineNumber: oldLine,
        newLineNumber: newLine,
        key: `ctx:${oldLine}:${newLine}`,
      });
      oldLine += 1;
      newLine += 1;
      continue;
    }
    currentHunk.lines.push({
      kind: "meta",
      content: rawLine,
      oldLineNumber: null,
      newLineNumber: null,
      key: `meta:${metaIndex}`,
    });
    metaIndex += 1;
  }

  return hunks;
}

function commentMatchesFile(comment: TaskComment, file: TaskPullRequestFile) {
  const diffAnchor = comment.diffAnchor;
  if (diffAnchor?.kind === "task_pr") {
    if (diffAnchor.repositoryId !== file.repositoryId) {
      return false;
    }
    return [diffAnchor.oldPath, diffAnchor.newPath, comment.relativePath]
      .filter(Boolean)
      .some((path) => path === file.oldPath || path === file.newPath || path === file.displayPath);
  }

  return comment.repositoryId === file.repositoryId
    && Boolean(comment.relativePath)
    && [file.oldPath, file.newPath, file.displayPath].includes(comment.relativePath ?? null);
}

function threadTouchesRenderedLine(thread: TaskCommentThread, renderedLineKeys: Set<string>) {
  const diffAnchor = thread.comment.diffAnchor;
  if (diffAnchor?.kind === "task_pr") {
    const side = diffAnchor.side;
    const start = side === "old" ? diffAnchor.oldLineStart : diffAnchor.newLineStart;
    const end = (side === "old" ? diffAnchor.oldLineEnd : diffAnchor.newLineEnd) ?? start;
    if (!start) {
      return false;
    }
    for (let line = start; line <= (end ?? start); line += 1) {
      const key = lineKey(side, line);
      if (key && renderedLineKeys.has(key)) {
        return true;
      }
    }
    return false;
  }

  const start = thread.comment.lineStart ?? 0;
  const end = thread.comment.lineEnd ?? start;
  for (let line = start; line <= end; line += 1) {
    const key = lineKey("new", line);
    if (key && renderedLineKeys.has(key)) {
      return true;
    }
  }
  return false;
}

function threadTouchesLine(thread: TaskCommentThread, line: ParsedDiffLine) {
  const diffAnchor = thread.comment.diffAnchor;
  if (diffAnchor?.kind === "task_pr") {
    const side = diffAnchor.side;
    const targetLine = side === "old" ? line.oldLineNumber : line.newLineNumber;
    const start = side === "old" ? diffAnchor.oldLineStart : diffAnchor.newLineStart;
    const end = (side === "old" ? diffAnchor.oldLineEnd : diffAnchor.newLineEnd) ?? start;
    return targetLine != null && start != null && targetLine >= start && targetLine <= (end ?? start);
  }

  const targetLine = line.newLineNumber;
  const start = thread.comment.lineStart ?? 0;
  const end = thread.comment.lineEnd ?? start;
  return targetLine != null && targetLine >= start && targetLine <= end;
}

function formatThreadLabel(thread: TaskCommentThread) {
  const diffAnchor = thread.comment.diffAnchor;
  if (diffAnchor?.kind === "task_pr") {
    const side = diffAnchor.side === "old" ? "Old" : "New";
    const start = diffAnchor.side === "old" ? diffAnchor.oldLineStart : diffAnchor.newLineStart;
    const end = (diffAnchor.side === "old" ? diffAnchor.oldLineEnd : diffAnchor.newLineEnd) ?? start;
    if (!start) {
      return `${side} side`;
    }
    return end && end !== start ? `${side} lines ${start}-${end}` : `${side} line ${start}`;
  }
  if (!thread.comment.lineStart) {
    return "Comment";
  }
  return thread.comment.lineEnd && thread.comment.lineEnd !== thread.comment.lineStart
    ? `Lines ${thread.comment.lineStart}-${thread.comment.lineEnd}`
    : `Line ${thread.comment.lineStart}`;
}

export function TaskDiffViewer({
  taskId,
  tasks,
  agents,
  roles,
  file,
  fileReferences,
  comments,
  commentAuthor,
  onAddComment,
  onOpenFileReference,
  onOpenTask,
  onOpenAgent,
  onOpenRole,
}: TaskDiffViewerProps) {
  const hunks = useMemo(() => parseUnifiedDiff(file.patch), [file.patch]);
  const draftMessageRef = useRef<HTMLTextAreaElement | null>(null);
  const threads = useMemo(
    () => buildTaskCommentThreads(comments).filter((thread) => commentMatchesFile(thread.comment, file)),
    [comments, file],
  );
  const renderedLineKeys = useMemo(() => {
    const keys = new Set<string>();
    for (const hunk of hunks) {
      for (const line of hunk.lines) {
        const oldKey = lineKey("old", line.oldLineNumber);
        const newKey = lineKey("new", line.newLineNumber);
        if (oldKey) keys.add(oldKey);
        if (newKey) keys.add(newKey);
      }
    }
    return keys;
  }, [hunks]);
  const [draftState, setDraftState] = useState<DraftState | null>(null);
  const [draftFocusToken, setDraftFocusToken] = useState(0);

  useEffect(() => {
    setDraftState((current) => current ? { ...current, anchor: { ...current.anchor, author: commentAuthor } } : current);
  }, [commentAuthor]);

  useEffect(() => {
    setDraftState(null);
  }, [file.displayPath]);

  useEffect(() => {
    if (!draftState || draftFocusToken === 0) {
      return;
    }

    const frame = window.requestAnimationFrame(() => {
      const messageField = draftMessageRef.current;
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
  }, [Boolean(draftState), draftFocusToken]);

  const currentThreads = useMemo(
    () => threads.filter((thread) => threadTouchesRenderedLine(thread, renderedLineKeys)),
    [renderedLineKeys, threads],
  );
  const outdatedThreads = useMemo(
    () => threads.filter((thread) => !threadTouchesRenderedLine(thread, renderedLineKeys)),
    [renderedLineKeys, threads],
  );
  const threadsByLine = useMemo(() => {
    const next = new Map<string, TaskCommentThread[]>();
    for (const thread of currentThreads) {
      for (const hunk of hunks) {
        for (const line of hunk.lines) {
          if (!threadTouchesLine(thread, line)) {
            continue;
          }
          const key = line.kind === "del"
            ? lineKey("old", line.oldLineNumber)
            : lineKey("new", line.newLineNumber) ?? lineKey("old", line.oldLineNumber);
          if (!key) {
            continue;
          }
          const entries = next.get(key) ?? [];
          entries.push(thread);
          next.set(key, entries);
        }
      }
    }
    return next;
  }, [currentThreads, hunks]);

  async function submitDraft() {
    if (!draftState) {
      return;
    }
    const success = await onAddComment(draftState.anchor);
    if (success) {
      setDraftState(null);
    }
  }

  function openDraft(line: ParsedDiffLine) {
    if (!isCommentableDiffLine(line)) {
      return;
    }
    const side = line.kind === "del" || line.newLineNumber == null ? "old" : "new";
    const lineStart = side === "old" ? line.oldLineNumber : line.newLineNumber;
    const nextLineKey = resolveLineThreadKey(line);
    if (!lineStart || !nextLineKey) {
      return;
    }
    if (draftState?.lineKey === nextLineKey) {
      setDraftState(null);
      return;
    }

    setDraftState({
      side,
      lineKey: nextLineKey,
      anchor: {
        author: commentAuthor,
        message: "",
        interruptAgent: false,
        repositoryId: file.repositoryId,
        relativePath: file.newPath ?? file.oldPath ?? file.displayPath,
        lineStart,
        lineEnd: lineStart,
        selectedText: line.content,
        diffAnchor: {
          kind: "task_pr",
          repositoryId: file.repositoryId,
          oldPath: file.oldPath ?? null,
          newPath: file.newPath ?? null,
          side,
          oldLineStart: side === "old" ? line.oldLineNumber : null,
          oldLineEnd: side === "old" ? line.oldLineNumber : null,
          newLineStart: side === "new" ? line.newLineNumber : null,
          newLineEnd: side === "new" ? line.newLineNumber : null,
        },
      },
    });
    setDraftFocusToken((current) => current + 1);
  }

  function getRenderedLineState(side: "old" | "new", line: ParsedDiffLine | null): RenderedDiffLineState {
    const nextLineKey = side === "old" ? lineKey("old", line?.oldLineNumber ?? null) : lineKey("new", line?.newLineNumber ?? null);
    return {
      side,
      line,
      lineKey: nextLineKey,
      lineNumber: side === "old" ? line?.oldLineNumber ?? null : line?.newLineNumber ?? null,
      kind: line?.kind ?? "empty",
      marker: line?.kind === "add" ? "+" : line?.kind === "del" ? "-" : " ",
      commentable: (side === "old" && line?.kind === "del") || (side === "new" && line?.kind === "add"),
      lineThreads: nextLineKey ? (threadsByLine.get(nextLineKey) ?? []) : [],
      isDraftOpen: nextLineKey != null && draftState?.lineKey === nextLineKey,
    };
  }

  function renderCommentThread(thread: TaskCommentThread) {
    return (
      <article className="transcript-event transcript-event--system task-comment-thread__parent" key={thread.comment.id}>
        <div className="transcript-event__meta">
          <span>{thread.comment.author}</span>
          <div className="transcript-event__meta-group">
            <span className="status-badge status-badge--accent">{formatThreadLabel(thread)}</span>
            <time dateTime={thread.comment.updatedAt}>{new Date(thread.comment.updatedAt).toLocaleString()}</time>
          </div>
        </div>
        <TaskCommentMessage
          dataRole="task-pr-comment-message-link"
          fileReferences={fileReferences}
          tasks={tasks}
          agents={agents}
          roles={roles}
          message={thread.comment.message}
          onOpenFileReference={onOpenFileReference}
          onOpenTask={onOpenTask}
          onOpenAgent={onOpenAgent}
          onOpenRole={onOpenRole}
        />
        {thread.comment.selectedText ? <pre className="task-comment-thread__quote">{thread.comment.selectedText}</pre> : null}
        {thread.replies.length ? (
          <div className="task-comment-thread__replies">
            {thread.replies.map((reply) => (
              <article className="transcript-event transcript-event--system task-comment-thread__reply" key={reply.id}>
                <div className="transcript-event__meta">
                  <span>{reply.author}</span>
                  <time dateTime={reply.updatedAt}>{new Date(reply.updatedAt).toLocaleString()}</time>
                </div>
                <TaskCommentMessage
                  dataRole="task-pr-comment-message-link"
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
              </article>
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  function renderLineCells(state: RenderedDiffLineState, rowKey: string) {
    return (
      <>
        <div
          className={[
            "task-pr-diff-cell",
            "task-pr-diff-cell--gutter",
            `task-pr-diff-cell--${state.side}`,
            `task-pr-diff-cell--${state.kind}`,
            state.lineThreads.length ? "task-pr-diff-cell--commented" : null,
            state.isDraftOpen ? "task-pr-diff-cell--draft-open" : null,
          ].filter(Boolean).join(" ")}
          key={`${rowKey}:${state.side}:gutter`}
        >
          <span className="task-pr-diff-cell__marker" aria-hidden="true">{state.marker}</span>
          <span className="task-pr-diff-cell__line-number">{state.lineNumber ?? ""}</span>
          {state.commentable && state.line ? (
            <button
              aria-label={`Add review comment on ${state.side} line ${state.lineNumber}`}
              className={state.lineThreads.length || state.isDraftOpen
                ? "task-pr-diff-line__comment-button task-pr-diff-line__comment-button--active"
                : "task-pr-diff-line__comment-button"}
              data-role="task-pr-comment-line"
              type="button"
              onClick={() => openDraft(state.line!)}
            >
              💬
              {state.lineThreads.length ? <span className="task-pr-diff-line__comment-count">{state.lineThreads.length}</span> : null}
            </button>
          ) : <span className="task-pr-diff-cell__comment-spacer" aria-hidden="true" />}
        </div>
        <div
          className={[
            "task-pr-diff-cell",
            "task-pr-diff-cell--code",
            `task-pr-diff-cell--${state.side}`,
            `task-pr-diff-cell--${state.kind}`,
            state.lineThreads.length ? "task-pr-diff-cell--commented" : null,
            state.isDraftOpen ? "task-pr-diff-cell--draft-open" : null,
          ].filter(Boolean).join(" ")}
          key={`${rowKey}:${state.side}:code`}
        >
          <pre className="task-pr-diff-cell__code"><code>{state.line?.content || " "}</code></pre>
        </div>
      </>
    );
  }

  function renderSupplementalRow(rowKey: string, states: RenderedDiffLineState[]) {
    const activeStates = states.filter((state) => state.lineThreads.length || state.isDraftOpen);
    if (!activeStates.length) {
      return null;
    }

    return (
      <div className="task-pr-diff-detail-row" data-role="task-pr-diff-detail-row" key={`${rowKey}:detail`}>
        <div className="task-pr-diff-detail-row__content">
          {activeStates.map((state) => (
            <section className="task-pr-diff-detail-row__section" key={`${rowKey}:${state.side}:detail`}>
              <div className="task-pr-diff-detail-row__section-header">
                <span className={`status-badge status-badge--${state.side === "old" ? "warning" : "accent"}`}>
                  {state.side === "old" ? "Base" : "Current"}
                </span>
                {state.lineNumber != null ? <span className="muted-copy">Line {state.lineNumber}</span> : null}
              </div>
              {state.lineThreads.length ? (
                <div className="task-section-list" data-role="task-pr-line-comments">
                  {state.lineThreads.map((thread) => renderCommentThread(thread))}
                </div>
              ) : null}
              {state.isDraftOpen ? (
                <TaskCommentComposer
                  author={draftState?.anchor.author ?? commentAuthor}
                  authorDataRole="task-pr-comment-author"
                  className="task-comment-reply-composer task-pr-diff-line__composer"
                  tasks={tasks}
                  agents={agents}
                  roles={roles}
                  message={draftState?.anchor.message ?? ""}
                  messageDataRole="task-pr-comment-message"
                  messageLabel={`Comment on ${state.side} line ${draftState?.anchor.lineStart ?? state.lineNumber ?? ""}`}
                  mentionListDataRole="task-pr-comment-mention-list"
                  mentionOptionDataRole="task-pr-comment-mention-option"
                  messageRef={draftMessageRef}
                  onAuthorChange={(author) => setDraftState((current) => current ? { ...current, anchor: { ...current.anchor, author } } : current)}
                  onInterruptChange={(interruptAgent) => setDraftState((current) => current ? { ...current, anchor: { ...current.anchor, interruptAgent } } : current)}
                  onMessageChange={(message) => setDraftState((current) => current ? { ...current, anchor: { ...current.anchor, message } } : current)}
                  onSubmit={() => void submitDraft()}
                  rows={3}
                  submitDataRole="add-task-pr-comment"
                  submitLabel="Add review comment"
                  cancelDataRole="cancel-task-pr-comment"
                  cancelLabel="Cancel"
                  onCancel={() => setDraftState(null)}
                  taskId={taskId}
                  interruptChecked={draftState?.anchor.interruptAgent ?? false}
                  interruptDataRole="task-pr-comment-interrupt"
                />
              ) : null}
            </section>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="task-history-card" data-role="task-pr-diff-viewer">
      <div className="workflow-section__header">
        <div>
          <strong>{file.displayPath}</strong>
          <p className="muted-copy">{file.repositoryName} · {file.changeType} · {file.origin} · +{file.additions} / -{file.deletions}</p>
        </div>
        <div className="action-cluster action-cluster--wrap">
          <span className={`status-badge status-badge--${file.origin === "mixed" ? "warning" : file.origin === "uncommitted" ? "accent" : "success"}`}>{file.origin}</span>
          <span className="status-badge status-badge--neutral">{file.changeType}</span>
        </div>
      </div>

      {!hunks.length ? (
        <p className="supporting-copy" data-role="task-pr-diff-empty-state">
          {file.isBinary ? "Binary or metadata-only change." : "No renderable patch is available for this file."}
        </p>
      ) : (
        <div className="task-section-list" data-role="task-pr-diff-hunks">
          <section className="file-content-viewer" key={file.displayPath}>
            <div className="task-pr-diff-split-shell">
              <div className="task-pr-diff-surface">
                <div className="task-pr-diff-surface__header">
                  <div className="task-pr-diff-surface__header-cell">Base</div>
                  <div className="task-pr-diff-surface__header-cell">Current</div>
                </div>
                {hunks.map((hunk, hunkIndex) => {
                  const rows = buildSplitDiffRows(hunk);
                  const gap = hunkIndex > 0 ? buildHunkGap(hunks[hunkIndex - 1], hunk) : null;

                  return (
                    <div className="task-pr-diff-hunk" key={`${file.displayPath}-${hunkIndex}`}>
                      {gap ? (
                        <div className="task-pr-diff-gap" data-role="task-pr-diff-gap">
                          <span className="task-pr-diff-gap__rule" aria-hidden="true" />
                          <span className="task-pr-diff-gap__label">{formatGapLabel(gap)}</span>
                          <span className="task-pr-diff-gap__rule" aria-hidden="true" />
                        </div>
                      ) : null}
                      <div className="task-pr-diff-hunk-header" data-role="task-pr-diff-hunk-header">
                        <span className="task-pr-diff-hunk-header__label">{hunk.header}</span>
                      </div>
                      {rows.map((row) => {
                        if (row.metaLine) {
                          return (
                            <div className="task-pr-diff-meta-row" key={row.key}>
                              <pre className="task-pr-diff-meta-row__code"><code>{row.metaLine.content}</code></pre>
                            </div>
                          );
                        }

                        const oldState = getRenderedLineState("old", row.oldLine);
                        const newState = getRenderedLineState("new", row.newLine);
                        return (
                          <div className="task-pr-diff-row-group" key={row.key}>
                            <div className="task-pr-diff-code-row" data-role="task-pr-diff-code-row">
                              {renderLineCells(oldState, row.key)}
                              {renderLineCells(newState, row.key)}
                            </div>
                            {renderSupplementalRow(row.key, [oldState, newState])}
                          </div>
                        );
                      })}
                    </div>
                  );
                })}
              </div>
            </div>
          </section>
        </div>
      )}

      {outdatedThreads.length ? (
        <div className="task-section-list" data-role="task-pr-outdated-comments">
          <p className="eyebrow">Outdated comments</p>
          {outdatedThreads.map((thread) => (
            <article className="transcript-event transcript-event--system task-comment-thread__parent" key={thread.comment.id}>
              <div className="transcript-event__meta">
                <span>{thread.comment.author}</span>
                <div className="transcript-event__meta-group">
                  <span className="status-badge status-badge--warning">Outdated</span>
                  <span className="status-badge status-badge--neutral">{formatThreadLabel(thread)}</span>
                </div>
              </div>
              <TaskCommentMessage
                dataRole="task-pr-comment-message-link"
                fileReferences={fileReferences}
                tasks={tasks}
                agents={agents}
                roles={roles}
                message={thread.comment.message}
                onOpenFileReference={onOpenFileReference}
                onOpenTask={onOpenTask}
                onOpenAgent={onOpenAgent}
                onOpenRole={onOpenRole}
              />
            </article>
          ))}
        </div>
      ) : null}
    </div>
  );
}
