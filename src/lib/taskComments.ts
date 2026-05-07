import type { TaskComment, TaskCommentAnchor, TaskCommentDomAnchor, TaskCommentFileAnchor, TaskFileReference } from "../types";

export function getTaskCommentAnchor(comment: TaskComment): TaskCommentAnchor | null {
  if (comment.anchor) {
    return comment.anchor;
  }

  if (!comment.repositoryId || !comment.relativePath || !comment.lineStart) {
    return null;
  }

  return {
    kind: "file",
    repositoryId: comment.repositoryId,
    relativePath: comment.relativePath,
    lineStart: comment.lineStart,
    lineEnd: comment.lineEnd ?? comment.lineStart,
    columnStart: comment.columnStart ?? null,
    columnEnd: comment.columnEnd ?? null,
    selectedText: comment.selectedText ?? null,
    commitHash: comment.anchorCommitHash ?? null,
    hasUncommittedChanges: comment.anchorHasUncommittedChanges ?? null,
  } satisfies TaskCommentFileAnchor;
}

export function formatTaskCommentAnchorLabel(comment: TaskComment) {
  const anchor = getTaskCommentAnchor(comment);
  if (!anchor) {
    return null;
  }

  if (anchor.kind === "file") {
    const lineLabel = anchor.lineStart === anchor.lineEnd
      ? `line ${anchor.lineStart}`
      : `lines ${anchor.lineStart}-${anchor.lineEnd}`;
    return `${anchor.relativePath} · ${lineLabel}`;
  }

  const target = formatDomAnchorTarget(anchor);
  const pageLabel = anchor.pageTitle?.trim() || anchor.url;
  return `${pageLabel} · ${target}`;
}

export function isTaskCommentAnchoredToReference(comment: TaskComment, reference: TaskFileReference | null) {
  if (!reference) {
    return false;
  }

  const anchor = getTaskCommentAnchor(comment);
  return anchor?.kind === "file"
    && anchor.repositoryId === reference.repositoryId
    && anchor.relativePath === reference.relativePath;
}

export function taskCommentTouchesLine(comment: TaskComment, lineNumber: number) {
  const anchor = getTaskCommentAnchor(comment);
  if (!anchor || anchor.kind !== "file") {
    return false;
  }

  return lineNumber >= anchor.lineStart && lineNumber <= anchor.lineEnd;
}

export function formatTaskCommentLineLabel(comment: TaskComment) {
  const anchor = getTaskCommentAnchor(comment);
  if (!anchor || anchor.kind !== "file") {
    return null;
  }

  return anchor.lineStart === anchor.lineEnd
    ? `Line ${anchor.lineStart}`
    : `Lines ${anchor.lineStart}-${anchor.lineEnd}`;
}

export function formatDomAnchorTarget(anchor: TaskCommentDomAnchor) {
  const tagName = anchor.snapshot.tagName.toLowerCase();
  if (anchor.snapshot.id?.trim()) {
    return `<${tagName}#${anchor.snapshot.id.trim()}>`;
  }
  const testId = anchor.locator.testId?.trim();
  if (testId) {
    return `<${tagName}[data-testid="${testId}"]>`;
  }
  const textPreview = anchor.snapshot.textPreview?.trim() || anchor.locator.textSnippet?.trim();
  if (textPreview) {
    return `${tagName} · ${textPreview.slice(0, 48)}`;
  }
  return `<${tagName}>`;
}
