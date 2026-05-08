import { useEffect, useMemo, useState } from "react";

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
  lines: ParsedDiffLine[];
}

interface ParsedSplitDiffRow {
  key: string;
  oldLine: ParsedDiffLine | null;
  newLine: ParsedDiffLine | null;
  metaLine?: ParsedDiffLine | null;
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
      currentHunk = { header: rawLine, lines: [] };
      hunks.push(currentHunk);
      oldLine = Number(hunkMatch[1]);
      newLine = Number(hunkMatch[3]);
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

  useEffect(() => {
    setDraftState((current) => current ? { ...current, anchor: { ...current.anchor, author: commentAuthor } } : current);
  }, [commentAuthor]);

  useEffect(() => {
    setDraftState(null);
  }, [file.displayPath]);

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
    setDraftState((current) => {
      if (current?.lineKey === nextLineKey) {
        return null;
      }
      return {
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
      };
    });
  }

  function renderDiffPane(side: "old" | "new", line: ParsedDiffLine | null, rowKey: string) {
    const key = side === "old" ? lineKey("old", line?.oldLineNumber ?? null) : lineKey("new", line?.newLineNumber ?? null);
    const lineThreads = key ? (threadsByLine.get(key) ?? []) : [];
    const commentable = (side === "old" && line?.kind === "del") || (side === "new" && line?.kind === "add");
    const isDraftOpen = draftState?.lineKey === key;
    const paneKind = line?.kind ?? "empty";
    const paneLineNumber = side === "old" ? line?.oldLineNumber : line?.newLineNumber;

    return (
      <div
        className={[
          "task-pr-diff-pane",
          `task-pr-diff-pane--${paneKind}`,
          lineThreads.length ? "task-pr-diff-pane--commented" : null,
          isDraftOpen ? "task-pr-diff-pane--draft-open" : null,
        ].filter(Boolean).join(" ")}
        data-role="task-pr-diff-line"
        key={`${rowKey}:${side}`}
      >
        <div className="task-pr-diff-pane__header">
          <div className="task-pr-diff-pane__line-number muted-copy">{paneLineNumber ?? ""}</div>
          {commentable && line ? (
            <button
              aria-label={`Add review comment on ${side} line ${paneLineNumber}`}
              className={lineThreads.length || isDraftOpen
                ? "task-pr-diff-line__comment-button task-pr-diff-line__comment-button--active"
                : "task-pr-diff-line__comment-button"}
              data-role="task-pr-comment-line"
              type="button"
              onClick={() => openDraft(line!)}
            >
              💬
              {lineThreads.length ? <span className="task-pr-diff-line__comment-count">{lineThreads.length}</span> : null}
            </button>
          ) : null}
        </div>
        <pre className="file-content-viewer__code task-pr-diff-pane__code"><code>{line?.content || " "}</code></pre>
        {lineThreads.length ? (
          <div className="task-section-list task-pr-diff-pane__threads" data-role="task-pr-line-comments">
            {lineThreads.map((thread) => (
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
            ))}
          </div>
        ) : null}
        {isDraftOpen ? (
          <TaskCommentComposer
            author={draftState.anchor.author}
            authorDataRole="task-pr-comment-author"
            className="task-comment-reply-composer task-pr-diff-line__composer"
            tasks={tasks}
            agents={agents}
            roles={roles}
            message={draftState.anchor.message}
            messageDataRole="task-pr-comment-message"
            messageLabel={`Comment on ${draftState.side} line ${draftState.anchor.lineStart}`}
            mentionListDataRole="task-pr-comment-mention-list"
            mentionOptionDataRole="task-pr-comment-mention-option"
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
            interruptChecked={draftState.anchor.interruptAgent}
            interruptDataRole="task-pr-comment-interrupt"
          />
        ) : null}
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
          {hunks.map((hunk, hunkIndex) => {
            const rows = buildSplitDiffRows(hunk);
            return (
              <section className="file-content-viewer" key={`${file.displayPath}-${hunkIndex}`}>
                <div className="file-content-viewer__header">
                  <span className="field-group__label">{hunk.header}</span>
                </div>
                <div className="task-pr-diff-split-shell">
                  <div className="task-pr-diff-split-table">
                    <div className="task-pr-diff-split-table__header">
                      <div className="task-pr-diff-split-table__header-cell">Base</div>
                      <div className="task-pr-diff-split-table__header-cell">Current</div>
                    </div>
                    <div className="task-section-list">
                      {rows.map((row) => row.metaLine ? (
                        <div className="task-pr-diff-row task-pr-diff-row--meta" key={row.key}>
                          <pre className="file-content-viewer__code task-pr-diff-row__meta-code"><code>{row.metaLine.content}</code></pre>
                        </div>
                      ) : (
                        <div className="task-pr-diff-row" key={row.key}>
                          {renderDiffPane("old", row.oldLine, row.key)}
                          {renderDiffPane("new", row.newLine, row.key)}
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              </section>
            );
          })}
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
