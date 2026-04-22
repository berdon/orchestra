import { describe, expect, test } from "vitest";

import { countVisibleUnreadTaskComments, shouldShowUnreadCommentAttention } from "../src/lib/taskUnreadCommentVisibility";
import type { TaskSummary } from "../src/types";

function makeTask(overrides: Partial<TaskSummary> = {}): TaskSummary {
  return {
    id: overrides.id ?? "task-1",
    projectId: overrides.projectId ?? "orchestra",
    number: overrides.number ?? "ORC-1",
    title: overrides.title ?? "Task",
    description: overrides.description ?? null,
    type: overrides.type ?? "task",
    status: overrides.status ?? "ready",
    priority: overrides.priority ?? "P2",
    workflowId: overrides.workflowId ?? null,
    currentLaneId: overrides.currentLaneId ?? null,
    assigneeType: overrides.assigneeType ?? "unassigned",
    assigneeId: overrides.assigneeId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    whipMaxAttempts: overrides.whipMaxAttempts,
    archived: overrides.archived ?? false,
    commentCount: overrides.commentCount ?? 0,
    unreadCommentCount: overrides.unreadCommentCount ?? 0,
    laneRunCount: overrides.laneRunCount ?? 0,
    childCount: overrides.childCount ?? 0,
    completedChildCount: overrides.completedChildCount ?? 0,
    inProgressChildCount: overrides.inProgressChildCount ?? 0,
    blockedChildCount: overrides.blockedChildCount ?? 0,
    blockedByCount: overrides.blockedByCount ?? 0,
    blockingCount: overrides.blockingCount ?? 0,
    attachmentCount: overrides.attachmentCount ?? 0,
    dependencyBlocked: overrides.dependencyBlocked ?? false,
    activeLaneAssignmentStatus: overrides.activeLaneAssignmentStatus ?? null,
    readyForDispatch: overrides.readyForDispatch ?? false,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe("taskUnreadCommentVisibility", () => {
  test("shows unread attention for non-terminal tasks with unread comments", () => {
    expect(shouldShowUnreadCommentAttention(makeTask({ status: "in_progress", unreadCommentCount: 2 }))).toBe(true);
    expect(shouldShowUnreadCommentAttention(makeTask({ status: "blocked", unreadCommentCount: 1 }))).toBe(true);
    expect(shouldShowUnreadCommentAttention(makeTask({ status: "in_review", unreadCommentCount: 3 }))).toBe(true);
  });

  test("hides unread attention for terminal tasks and zero unread counts", () => {
    expect(shouldShowUnreadCommentAttention(makeTask({ status: "completed", unreadCommentCount: 2 }))).toBe(false);
    expect(shouldShowUnreadCommentAttention(makeTask({ status: "canceled", unreadCommentCount: 4 }))).toBe(false);
    expect(shouldShowUnreadCommentAttention(makeTask({ status: "ready", unreadCommentCount: 0 }))).toBe(false);
  });

  test("counts only visible unread attention across a task list", () => {
    const tasks = [
      makeTask({ status: "in_review", unreadCommentCount: 2 }),
      makeTask({ id: "task-2", status: "completed", unreadCommentCount: 5 }),
      makeTask({ id: "task-3", status: "canceled", unreadCommentCount: 3 }),
      makeTask({ id: "task-4", status: "blocked", unreadCommentCount: 1 }),
      makeTask({ id: "task-5", status: "ready", unreadCommentCount: 0 }),
    ];

    expect(countVisibleUnreadTaskComments(tasks)).toBe(3);
  });
});
