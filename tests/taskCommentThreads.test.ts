import { describe, expect, it } from "vitest";

import { buildTaskCommentThreads, sortTaskCommentThreadsByLatestActivityDesc } from "../src/lib/taskCommentThreads";
import type { TaskComment } from "../src/types";

function createComment(overrides: Partial<TaskComment> & Pick<TaskComment, "id" | "message" | "createdAt" | "updatedAt">): TaskComment {
  return {
    id: overrides.id,
    taskId: overrides.taskId ?? "task-1",
    parentCommentId: overrides.parentCommentId ?? null,
    author: overrides.author ?? "Reviewer",
    originType: overrides.originType ?? "user",
    originId: overrides.originId ?? null,
    message: overrides.message,
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
    createdAt: overrides.createdAt,
    updatedAt: overrides.updatedAt,
  };
}

describe("task comment thread helpers", () => {
  it("groups replies under their top-level parent and keeps replies chronological", () => {
    const comments = [
      createComment({ id: "parent", message: "Parent", createdAt: "2026-04-21T10:00:00.000Z", updatedAt: "2026-04-21T10:00:00.000Z" }),
      createComment({ id: "reply-2", parentCommentId: "parent", message: "Second reply", createdAt: "2026-04-21T10:02:00.000Z", updatedAt: "2026-04-21T10:05:00.000Z" }),
      createComment({ id: "reply-1", parentCommentId: "parent", message: "First reply", createdAt: "2026-04-21T10:01:00.000Z", updatedAt: "2026-04-21T10:01:00.000Z" }),
    ];

    const threads = buildTaskCommentThreads(comments);

    expect(threads).toHaveLength(1);
    expect(threads[0]?.comment.id).toBe("parent");
    expect(threads[0]?.replies.map((reply) => reply.id)).toEqual(["reply-1", "reply-2"]);
    expect(threads[0]?.latestActivityAt).toBe("2026-04-21T10:05:00.000Z");
  });

  it("sorts task threads by latest reply activity instead of only the parent timestamp", () => {
    const comments = [
      createComment({ id: "older-parent", message: "Older parent", createdAt: "2026-04-21T09:00:00.000Z", updatedAt: "2026-04-21T09:00:00.000Z" }),
      createComment({ id: "newer-parent", message: "Newer standalone", createdAt: "2026-04-21T10:00:00.000Z", updatedAt: "2026-04-21T10:00:00.000Z" }),
      createComment({ id: "older-reply", parentCommentId: "older-parent", message: "Recent reply", createdAt: "2026-04-21T11:00:00.000Z", updatedAt: "2026-04-21T11:00:00.000Z" }),
    ];

    const threads = sortTaskCommentThreadsByLatestActivityDesc(buildTaskCommentThreads(comments));

    expect(threads.map((thread) => thread.comment.id)).toEqual(["older-parent", "newer-parent"]);
    expect(threads[0]?.latestActivityAt).toBe("2026-04-21T11:00:00.000Z");
  });
});
