import { describe, expect, it, vi } from "vitest";

import { buildTaskDetailHeaderActions } from "../src/pages/tasks/taskDetailHeaderActions";
import type { TaskDetail } from "../src/types";

function buildTask(overrides: Partial<TaskDetail> = {}): TaskDetail {
  return {
    id: "task-1",
    number: "ORC-1",
    title: "Task",
    description: null,
    status: "in_progress",
    priority: "P2",
    type: "task",
    assigneeType: "role",
    assigneeId: "worker",
    workflowId: "workflow-1",
    currentLaneId: "lane-1",
    repositoryId: null,
    repositoryIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    updatedAt: "2026-01-01T00:00:00.000Z",
    archived: false,
    tags: [],
    dependencyBlocked: false,
    readyForDispatch: false,
    attachmentCount: 0,
    attachments: [],
    commentCount: 0,
    comments: [],
    childCount: 0,
    completedChildCount: 0,
    inProgressChildCount: 0,
    blockedChildCount: 0,
    children: [],
    laneRunCount: 0,
    laneRuns: [],
    laneSummaries: [],
    activeLaneAssignment: {
      id: "assignment-1",
      taskId: "task-1",
      workflowId: "workflow-1",
      laneId: "lane-1",
      laneName: "Implement",
      workerType: "role",
      workerId: "worker",
      workerName: "Worker",
      status: "active",
      sessionId: "session-1",
      sessionTitle: "Session",
      runtimeCwd: "/tmp",
      roleQueueEntryId: null,
      roleInstanceId: null,
      prompt: null,
      pendingOutcome: null,
      completionSummary: null,
      completionNotes: null,
      whipCount: 0,
      lastWhipAt: null,
      startedAt: "2026-01-01T00:00:00.000Z",
      completedAt: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      updatedAt: "2026-01-01T00:00:00.000Z",
    },
    blockedByCount: 0,
    blockedBy: [],
    blockingCount: 0,
    blocking: [],
    parentTaskId: null,
    parent: null,
    lineage: [],
    todos: [],
    taskRepositories: [],
    fileReferences: [],
    unreadCommentCount: 0,
    whipMaxAttempts: 10,
    projectId: "project-1",
    ...overrides,
  } as TaskDetail;
}

describe("buildTaskDetailHeaderActions", () => {
  it("uses the dedicated needs-work handler instead of completion summary flow for approval-paused work", () => {
    const onSendBackForWork = vi.fn();
    const onComplete = vi.fn();
    const actions = buildTaskDetailHeaderActions({
      task: buildTask(),
      canPublish: false,
      effectiveActiveLaneAssignmentStatus: "awaiting_user_approval",
      onPublish: vi.fn(),
      onDispatch: vi.fn(),
      onApproveCompletion: vi.fn(),
      onSendBackForWork,
      onResetTask: vi.fn(),
      onComplete,
      onPauseRuntime: vi.fn(),
      onWhipTask: vi.fn(),
    });

    const action = actions.find((entry) => entry.dataRole === "send-task-back-for-work");
    expect(action?.tooltip).toContain("without closing the task or asking for a new lane summary");

    action?.onClick();

    expect(onSendBackForWork).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("uses the dedicated resume handler instead of completion summary flow for user-intervention resumes", () => {
    const onSendBackForWork = vi.fn();
    const onComplete = vi.fn();
    const actions = buildTaskDetailHeaderActions({
      task: buildTask(),
      canPublish: false,
      effectiveActiveLaneAssignmentStatus: "awaiting_user_intervention",
      onPublish: vi.fn(),
      onDispatch: vi.fn(),
      onApproveCompletion: vi.fn(),
      onSendBackForWork,
      onResetTask: vi.fn(),
      onComplete,
      onPauseRuntime: vi.fn(),
      onWhipTask: vi.fn(),
    });

    const action = actions.find((entry) => entry.dataRole === "resume-task-lane");
    expect(action?.tooltip).toContain("without asking for a new lane summary");

    action?.onClick();

    expect(onSendBackForWork).toHaveBeenCalledTimes(1);
    expect(onComplete).not.toHaveBeenCalled();
  });

  it("still routes user-owned review-lane needs-work actions through the summary-required completion flow", () => {
    const onComplete = vi.fn();
    const actions = buildTaskDetailHeaderActions({
      task: buildTask({
        status: "in_review",
        assigneeType: "user",
        assigneeId: null,
        activeLaneAssignment: null,
      }),
      canPublish: false,
      effectiveActiveLaneAssignmentStatus: null,
      onPublish: vi.fn(),
      onDispatch: vi.fn(),
      onApproveCompletion: vi.fn(),
      onSendBackForWork: vi.fn(),
      onResetTask: vi.fn(),
      onComplete,
      onPauseRuntime: vi.fn(),
      onWhipTask: vi.fn(),
    });

    actions.find((entry) => entry.dataRole === "complete-task-failure")?.onClick();

    expect(onComplete).toHaveBeenCalledWith("failure");
  });
});
