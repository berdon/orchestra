import { describe, expect, test } from "vitest";

import { applyTaskListQuery, getTaskTags } from "../src/lib/taskListQuery";
import type { TaskSummary } from "../src/types";

function makeTask(overrides: Partial<TaskSummary>): TaskSummary {
  return {
    id: overrides.id ?? "task-1",
    projectId: "orchestra",
    number: overrides.number ?? "ORC-1",
    title: overrides.title ?? "Task",
    description: overrides.description ?? null,
    type: overrides.type ?? "task",
    status: overrides.status ?? "ready",
    priority: overrides.priority ?? "P2",
    workflowId: overrides.workflowId ?? "workflow-1",
    currentLaneId: overrides.currentLaneId ?? "lane-1",
    assigneeType: overrides.assigneeType ?? "unassigned",
    assigneeId: overrides.assigneeId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
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
    readyForDispatch: overrides.readyForDispatch ?? false,
    tags: overrides.tags,
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

describe("taskListQuery", () => {
  test("normalizes task tags into a sorted unique list", () => {
    expect(getTaskTags({ tags: ["backend", " urgent ", "backend"] })).toEqual(["backend", "urgent"]);
    expect(getTaskTags({ tags: undefined })).toEqual([]);
  });

  test("filters tasks by exact tag match with any/all semantics and sorts by tags", () => {
    const tasks = [
      makeTask({ id: "frontend", number: "ORC-2", title: "Frontend", tags: ["frontend"] }),
      makeTask({ id: "mixed", number: "ORC-3", title: "Mixed", tags: ["backend", "urgent"] }),
      makeTask({ id: "backend", number: "ORC-1", title: "Backend", tags: ["backend"] }),
      makeTask({ id: "untagged", number: "ORC-4", title: "Untagged", tags: [] }),
    ];

    expect(applyTaskListQuery(tasks, {
      tags: [" backend ", "URGENT", "urgent"],
      tagMatch: "all",
      sort: { field: "tags", direction: "asc" },
    }).map((task) => task.id)).toEqual(["mixed"]);

    expect(applyTaskListQuery(tasks, {
      tags: ["backend", "FRONTEND"],
      tagMatch: "any",
      sort: { field: "tags", direction: "asc" },
    }).map((task) => task.id)).toEqual(["backend", "mixed", "frontend"]);
  });

  test("keeps untagged tasks last for tag sorting in both directions", () => {
    const tasks = [
      makeTask({ id: "backend", number: "ORC-1", title: "Backend", tags: ["backend"] }),
      makeTask({ id: "mixed", number: "ORC-2", title: "Mixed", tags: ["backend", "urgent"] }),
      makeTask({ id: "api", number: "ORC-3", title: "API", tags: ["api"] }),
      makeTask({ id: "untagged", number: "ORC-4", title: "Untagged", tags: [] }),
    ];

    expect(applyTaskListQuery(tasks, {
      sort: { field: "tags", direction: "asc" },
    }).map((task) => task.id)).toEqual(["api", "backend", "mixed", "untagged"]);

    expect(applyTaskListQuery(tasks, {
      sort: { field: "tags", direction: "desc" },
    }).map((task) => task.id)).toEqual(["mixed", "backend", "api", "untagged"]);
  });
});
