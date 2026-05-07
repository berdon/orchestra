import { describe, expect, it } from "vitest";

import { formatTaskCommentAnchorLabel, getTaskCommentAnchor } from "../src/lib/taskComments";
import type { TaskComment } from "../src/types";

function createComment(overrides: Partial<TaskComment>): TaskComment {
  return {
    id: overrides.id ?? "task-comment-1",
    taskId: overrides.taskId ?? "task-1",
    parentCommentId: overrides.parentCommentId ?? null,
    author: overrides.author ?? "Reviewer",
    originType: overrides.originType ?? "user",
    originId: overrides.originId ?? null,
    message: overrides.message ?? "Comment",
    interruptAgent: overrides.interruptAgent ?? false,
    repositoryId: overrides.repositoryId ?? null,
    relativePath: overrides.relativePath ?? null,
    lineStart: overrides.lineStart ?? null,
    lineEnd: overrides.lineEnd ?? null,
    columnStart: overrides.columnStart ?? null,
    columnEnd: overrides.columnEnd ?? null,
    selectedText: overrides.selectedText ?? null,
    anchorCommitHash: overrides.anchorCommitHash ?? null,
    anchorHasUncommittedChanges: overrides.anchorHasUncommittedChanges ?? null,
    anchor: overrides.anchor ?? null,
    createdAt: overrides.createdAt ?? "2026-05-06T10:00:00.000Z",
    updatedAt: overrides.updatedAt ?? "2026-05-06T10:00:00.000Z",
  };
}

describe("task comment anchor helpers", () => {
  it("formats legacy file anchors", () => {
    const comment = createComment({
      repositoryId: "repo-1",
      relativePath: "docs/design.md",
      lineStart: 4,
      lineEnd: 6,
    });

    expect(formatTaskCommentAnchorLabel(comment)).toBe("docs/design.md · lines 4-6");
    expect(getTaskCommentAnchor(comment)?.kind).toBe("file");
  });

  it("formats DOM anchors with page and element context", () => {
    const comment = createComment({
      anchor: {
        kind: "dom",
        browserSessionId: "task-browser-session-1",
        url: "http://127.0.0.1:4173/",
        pageTitle: "Harness page",
        domRevision: 7,
        locator: {
          cssPath: "main > button.cta",
          testId: "checkout-submit",
          ordinalPath: [{ tag: "button", index: 0 }],
        },
        snapshot: {
          tagName: "button",
          id: "submit-order",
          classList: ["cta"],
          textPreview: "Submit order",
          attributes: { type: "button" },
          outerHtmlSnippet: "<button>Submit order</button>",
        },
      },
    });

    expect(formatTaskCommentAnchorLabel(comment)).toBe("Harness page · <button#submit-order>");
  });
});
