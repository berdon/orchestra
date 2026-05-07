import { describe, expect, test } from "vitest";

import { buildTaskDependencyTree, collectTaskDependencyTreeNeighborIds } from "../src/pages/tasks/taskDependencyTree";
import type { TaskDependency, TaskDetail, TaskSummary } from "../src/types";

const timestamp = new Date().toISOString();

function makeSummary(overrides: Partial<TaskSummary> & Pick<TaskSummary, "id" | "number" | "title">): TaskSummary {
  return {
    id: overrides.id,
    projectId: overrides.projectId ?? "orchestra",
    number: overrides.number,
    title: overrides.title,
    description: overrides.description ?? null,
    type: overrides.type ?? "task",
    status: overrides.status ?? "ready",
    priority: overrides.priority ?? "P2",
    workflowId: overrides.workflowId ?? null,
    currentLaneId: overrides.currentLaneId ?? null,
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
    activeLaneAssignmentStatus: overrides.activeLaneAssignmentStatus ?? null,
    readyForDispatch: overrides.readyForDispatch ?? false,
    tags: overrides.tags ?? [],
    createdAt: overrides.createdAt ?? timestamp,
    updatedAt: overrides.updatedAt ?? timestamp,
  };
}

function makeTask(overrides: Partial<TaskDetail> & Pick<TaskDetail, "id" | "number" | "title">): TaskDetail {
  return {
    ...makeSummary(overrides),
    repositoryId: overrides.repositoryId ?? null,
    repositoryIds: overrides.repositoryIds ?? [],
    whipMaxAttempts: overrides.whipMaxAttempts,
    parent: overrides.parent ?? null,
    lineage: overrides.lineage ?? [],
    children: overrides.children ?? [],
    blockedBy: overrides.blockedBy ?? [],
    blocking: overrides.blocking ?? [],
    attachments: overrides.attachments ?? [],
    taskRepositories: overrides.taskRepositories ?? [],
    fileReferences: overrides.fileReferences ?? [],
    comments: overrides.comments ?? [],
    todos: overrides.todos ?? [],
    laneRuns: overrides.laneRuns ?? [],
    laneSummaries: overrides.laneSummaries ?? [],
    activeLaneAssignment: overrides.activeLaneAssignment ?? null,
  };
}

function makeDependency(id: string, blocker: TaskSummary, blocked: TaskSummary): TaskDependency {
  return {
    id,
    blockerTaskId: blocker.id,
    blockedTaskId: blocked.id,
    blocker,
    blocked,
    createdAt: timestamp,
  };
}

describe("taskDependencyTree", () => {
  test("builds nested blocker chains with stable sibling ordering", () => {
    const root = makeSummary({ id: "root", number: "ORC-20", title: "Root task" });
    const blockerTen = makeSummary({ id: "blocker-10", number: "ORC-10", title: "Tenth blocker" });
    const blockerTwo = makeSummary({ id: "blocker-2", number: "ORC-2", title: "Second blocker" });
    const blockerOne = makeSummary({ id: "blocker-1", number: "ORC-1", title: "First blocker" });

    const tree = buildTaskDependencyTree(root.id, {
      [root.id]: makeTask({
        ...root,
        blockedBy: [
          makeDependency("dependency-ten", blockerTen, root),
          makeDependency("dependency-two", blockerTwo, root),
        ],
      }),
      [blockerTen.id]: makeTask({ ...blockerTen }),
      [blockerTwo.id]: makeTask({
        ...blockerTwo,
        blockedBy: [makeDependency("dependency-one", blockerOne, blockerTwo)],
      }),
      [blockerOne.id]: makeTask({ ...blockerOne }),
    });

    expect(tree?.branches.map((branch) => branch.type)).toEqual(["blocked_by"]);
    expect(tree?.branches[0]?.nodes.map((node) => node.task.number)).toEqual(["ORC-2", "ORC-10"]);
    expect(tree?.branches[0]?.nodes[0]?.branches[0]?.nodes[0]?.task.number).toBe("ORC-1");
  });

  test("includes child-task and downstream blocking branches in branch order", () => {
    const root = makeSummary({ id: "root", number: "ORC-3", title: "Selected task" });
    const blocker = makeSummary({ id: "blocker", number: "ORC-2", title: "Blocker" });
    const child = makeSummary({ id: "child", number: "ORC-4", title: "Child task", parentTaskId: root.id });
    const blocked = makeSummary({ id: "blocked", number: "ORC-5", title: "Blocked task" });

    const tree = buildTaskDependencyTree(root.id, {
      [root.id]: makeTask({
        ...root,
        blockedBy: [makeDependency("dependency-in", blocker, root)],
        children: [child],
        blocking: [makeDependency("dependency-out", root, blocked)],
      }),
      [blocker.id]: makeTask({ ...blocker }),
      [child.id]: makeTask({ ...child, parent: root }),
      [blocked.id]: makeTask({ ...blocked }),
    });

    expect(tree?.branches.map((branch) => branch.type)).toEqual(["blocked_by", "subtasks", "blocking"]);
    expect(tree?.branches[1]?.nodes[0]?.task.number).toBe("ORC-4");
    expect(tree?.branches[2]?.nodes[0]?.task.number).toBe("ORC-5");
  });

  test("renders repeated tasks as references after their first expanded occurrence", () => {
    const root = makeSummary({ id: "root", number: "ORC-3", title: "Selected task" });
    const shared = makeSummary({ id: "shared", number: "ORC-4", title: "Shared task", parentTaskId: root.id });

    const tree = buildTaskDependencyTree(root.id, {
      [root.id]: makeTask({
        ...root,
        children: [shared],
        blocking: [makeDependency("dependency-out", root, shared)],
      }),
      [shared.id]: makeTask({ ...shared, parent: root }),
    });

    expect(tree?.branches.map((branch) => branch.type)).toEqual(["subtasks", "blocking"]);
    expect(tree?.branches[0]?.nodes[0]?.reference).toBe(false);
    expect(tree?.branches[1]?.nodes[0]?.reference).toBe(true);
  });

  test("collects parent, lineage, child, and dependency neighbors for recursive loading", () => {
    const ancestor = makeSummary({ id: "ancestor", number: "ORC-1", title: "Ancestor" });
    const parent = makeSummary({ id: "parent", number: "ORC-2", title: "Parent" });
    const root = makeSummary({ id: "root", number: "ORC-3", title: "Root task", parentTaskId: parent.id });
    const child = makeSummary({ id: "child", number: "ORC-4", title: "Child task", parentTaskId: root.id });
    const blocker = makeSummary({ id: "blocker", number: "ORC-5", title: "Blocker" });
    const blocked = makeSummary({ id: "blocked", number: "ORC-6", title: "Blocked task" });

    const neighborIds = collectTaskDependencyTreeNeighborIds(makeTask({
      ...root,
      parent,
      lineage: [ancestor, parent],
      children: [child],
      blockedBy: [makeDependency("dependency-in", blocker, root)],
      blocking: [makeDependency("dependency-out", root, blocked)],
    }));

    expect(neighborIds).toEqual([ancestor.id, parent.id, child.id, blocker.id, blocked.id]);
  });
});
