import { describe, expect, test } from "vitest";

import { buildTaskBoardModel, isDraftTask } from "../src/pages/tasks/taskBoardModel";
import type { TaskSummary, WorkflowDefinition } from "../src/types";

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
    workflowId: overrides.workflowId ?? null,
    currentLaneId: overrides.currentLaneId ?? null,
    assigneeType: overrides.assigneeType ?? "unassigned",
    assigneeId: overrides.assigneeId ?? null,
    parentTaskId: overrides.parentTaskId ?? null,
    archived: overrides.archived ?? false,
    commentCount: overrides.commentCount ?? 0,
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
    createdAt: overrides.createdAt ?? new Date().toISOString(),
    updatedAt: overrides.updatedAt ?? new Date().toISOString(),
  };
}

const workflow: WorkflowDefinition = {
  id: "workflow-1",
  slug: "development",
  name: "Development",
  description: null,
  archived: false,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
  lanes: [
    {
      id: "lane-plan",
      key: "plan",
      name: "Plan",
      description: null,
      order: 0,
      assignedEntityType: "user",
      assignedEntityId: null,
      entryPromptTemplate: null,
      successTransitionType: "lane",
      successTargetLaneId: "lane-implement",
      failureTransitionType: "end",
      failureTargetLaneId: null,
    },
    {
      id: "lane-implement",
      key: "implement",
      name: "Implement",
      description: null,
      order: 1,
      assignedEntityType: "role",
      assignedEntityId: "developer",
      entryPromptTemplate: null,
      successTransitionType: "end",
      successTargetLaneId: null,
      failureTransitionType: "end",
      failureTargetLaneId: null,
    },
  ],
};

describe("taskBoardModel", () => {
  test("treats draft or workflow-less tasks as drafts", () => {
    expect(isDraftTask(makeTask({ status: "draft", workflowId: "workflow-1" }))).toBe(true);
    expect(isDraftTask(makeTask({ status: "ready", workflowId: null }))).toBe(true);
    expect(isDraftTask(makeTask({ status: "ready", workflowId: "workflow-1" }))).toBe(false);
  });

  test("groups tasks into workflow lanes and done column", () => {
    const board = buildTaskBoardModel(
      [
        makeTask({ id: "draft", status: "draft", workflowId: null }),
        makeTask({ id: "plan", workflowId: "workflow-1", currentLaneId: "lane-plan", status: "ready" }),
        makeTask({ id: "impl", workflowId: "workflow-1", currentLaneId: "lane-implement", status: "in_progress" }),
        makeTask({ id: "done", workflowId: "workflow-1", currentLaneId: null, status: "completed" }),
      ],
      { [workflow.id]: workflow },
    );

    expect(board.draftTasks).toHaveLength(1);
    expect(board.workflowSections).toHaveLength(1);
    expect(board.workflowSections[0].lanes[0].tasks.map((task) => task.id)).toEqual(["plan"]);
    expect(board.workflowSections[0].lanes[1].tasks.map((task) => task.id)).toEqual(["impl"]);
    expect(board.workflowSections[0].doneTasks.map((task) => task.id)).toEqual(["done"]);
  });
});
