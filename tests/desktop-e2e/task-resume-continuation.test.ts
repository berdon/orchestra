import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  sleep,
  waitForText,
} from "./driver";
import { openTaskCard, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(500);
  }

  throw new Error(
    `Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`,
  );
}

function assistantMessages(record: any) {
  return (record?.events ?? []).filter(
    (event: { kind?: string; message?: string | null }) =>
      event.kind === "assistant" && Boolean((event.message ?? "").trim()),
  );
}

async function waitForAssistantReply(
  sessionId: string,
  workerSessionId: string,
  minimumAssistantMessages: number,
  expectedSubstring: string,
  timeoutMs = 30_000,
) {
  return waitForCondition(
    () =>
      invokeCommand<any>(sessionId, "get_session_record", {
        sessionId: workerSessionId,
      }),
    (record) => {
      const messages = assistantMessages(record);
      return (
        messages.length >= minimumAssistantMessages &&
        messages.some((message: { message?: string | null }) =>
          String(message.message ?? "").includes(expectedSubstring),
        )
      );
    },
    timeoutMs,
  );
}

async function dispatchTaskToActiveSession(
  sessionId: string,
  taskId: string,
  roleId: string,
) {
  return waitForCondition(
    async () => {
      let currentTask = await invokeCommand<any>(sessionId, "get_task", {
        taskId,
      });
      if (
        !currentTask.activeLaneAssignment?.sessionId ||
        currentTask.activeLaneAssignment?.status !== "active"
      ) {
        await invokeCommand(sessionId, "dispatch_task_lane", { taskId }).catch(
          () => undefined,
        );
        currentTask = await invokeCommand<any>(sessionId, "get_task", {
          taskId,
        });
        if (
          !currentTask.activeLaneAssignment?.sessionId ||
          currentTask.activeLaneAssignment?.status !== "active"
        ) {
          await invokeCommand(sessionId, "run_dispatcher_tick").catch(
            () => undefined,
          );
          await invokeCommand(sessionId, "dispatch_role_queue", {
            roleId,
          }).catch(() => undefined);
          currentTask = await invokeCommand<any>(sessionId, "get_task", {
            taskId,
          });
        }
      }
      return currentTask;
    },
    (task) =>
      Boolean(task.activeLaneAssignment?.sessionId) &&
      task.activeLaneAssignment?.status === "active",
  );
}

async function completeTaskLaneWithRetries(
  sessionId: string,
  taskId: string,
  timeoutMs = 60_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const task = await invokeCommand<any>(sessionId, "get_task", { taskId });
    if (task.status === "in_review" || task.status === "completed") {
      return task;
    }
    try {
      await invokeCommand(sessionId, "complete_lane_as_success", {
        taskId,
        summary: "Completed the lane and handed it off for approval.",
        notes: null,
      });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await invokeCommand(sessionId, "run_dispatcher_tick").catch(
      () => undefined,
    );
    await sleep(1000);
  }
  throw new Error(`Timed out completing task lane ${taskId}: ${lastError}`);
}

async function updateTaskStatus(
  sessionId: string,
  taskId: string,
  status: string,
) {
  const task = await invokeCommand<any>(sessionId, "get_task", { taskId });
  return invokeCommand(sessionId, "update_task", {
    taskId,
    input: {
      title: task.title,
      description: task.description,
      type: task.type,
      status,
      priority: task.priority,
      workflowId: task.workflowId,
      currentLaneId: task.currentLaneId,
      repositoryId: task.repositoryId,
      repositoryIds: task.repositoryIds,
      assigneeType: task.assigneeType,
      assigneeId: task.assigneeId,
      parentTaskId: task.parentTaskId,
      archived: task.archived,
      tags: task.tags,
      whipMaxAttempts: task.whipMaxAttempts,
    },
  });
}

describe("desktop task resume continuation", () => {
  it.skipIf(!isDesktopE2E)(
    "resumes actual session work after Needs Work, blocked Resume, and manual whip",
    async () => {
      expect(testHome).toBeTruthy();

      const sessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(sessionId);

        const repositoryRoot = join(
          testHome!,
          "workspace",
          "task-resume-continuation-repo",
          "repository",
        );

        const project = await invokeCommand<{ id: string }>(
          sessionId,
          "create_project",
          {
            input: {
              name: "Resume Continuation Project",
              taskPrefix: "RCP",
              description:
                "Desktop regression coverage for task resume continuation.",
            },
          },
        );
        const repository = await invokeCommand<{ id: string }>(
          sessionId,
          "create_repository",
          {
            projectId: project.id,
            input: {
              name: "Resume Continuation Repo",
              repositoryPath: repositoryRoot,
              defaultBranch: "main",
            },
          },
        );
        await invokeCommand(sessionId, "set_project_default_repository", {
          projectId: project.id,
          repositoryId: repository.id,
        });
        await switchProject(sessionId, "Resume Continuation Project");
        const role = await invokeCommand<{ id: string; slug: string }>(
          sessionId,
          "create_role",
          {
            input: {
              name: "Resume Continuation Worker",
              description:
                "Handles paused review and blocked resume regression work.",
              systemPrompt:
                "Reply to the task prompt and keep working until the user changes the lane state.",
              capacity: 2,
            },
          },
        );
        const workflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Resume Continuation Flow",
              description:
                "Single role lane used to validate resumed work continuation.",
              lanes: [
                {
                  id: "lane-implement",
                  key: "implement",
                  name: "Implement",
                  order: 0,
                  assignedEntityType: "role",
                  assignedEntityId: role.slug,
                  entryPromptTemplate:
                    "Implement the task and keep moving until Orchestra tells you otherwise.",
                  useSeparateWorktree: false,
                  requireUserApprovalOnSuccess: true,
                  needsWorkTargetLaneId: null,
                  successTransitionType: "end",
                  successTargetLaneId: null,
                  failureTransitionType: "end",
                  failureTargetLaneId: null,
                },
              ],
            },
          },
        );

        const reviewTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "Review return continuation task",
            description:
              "Verify review Needs Work resumes real session activity.",
            type: "task",
            status: "ready",
            priority: "P2",
            workflowId: workflow.id,
            currentLaneId: "lane-implement",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });

        const dispatchedReviewTask = await dispatchTaskToActiveSession(
          sessionId,
          reviewTask.id,
          role.id,
        );
        const reviewSessionId =
          dispatchedReviewTask.activeLaneAssignment?.sessionId;
        expect(reviewSessionId).toBeTruthy();

        const initialReviewRecord = await waitForAssistantReply(
          sessionId,
          reviewSessionId!,
          1,
          "Verify review Needs Work resumes real session activity.",
        );
        const initialReviewAssistantCount =
          assistantMessages(initialReviewRecord).length;

        await openTaskCard(sessionId, "Review return continuation task");
        await clickByText(sessionId, "[role=tab]", "Runtime");
        await waitForText(sessionId, "Lane execution");

        await completeTaskLaneWithRetries(sessionId, reviewTask.id);
        await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: reviewTask.id,
            }),
          (task) =>
            task.status === "in_review" &&
            task.activeLaneAssignment?.status === "awaiting_user_approval",
        );
        await waitForText(sessionId, "paused for user approval", 15_000);

        await clickSelector(sessionId, '[data-role="send-task-back-for-work"]');
        const resumedReviewTask = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: reviewTask.id,
            }),
          (task) =>
            task.status === "in_progress" &&
            task.activeLaneAssignment?.status === "active",
        );
        expect(resumedReviewTask.activeLaneAssignment?.sessionId).toBe(
          reviewSessionId,
        );

        const reviewResumeRecord = await waitForAssistantReply(
          sessionId,
          reviewSessionId!,
          initialReviewAssistantCount + 1,
          "The user has requested more work be done on this lane.",
        );
        const reviewResumeAssistantCount =
          assistantMessages(reviewResumeRecord).length;

        const reviewWhipTask = await invokeCommand<any>(
          sessionId,
          "manual_task_whip",
          { taskId: reviewTask.id },
        );
        expect(
          reviewWhipTask.activeLaneAssignment?.whipCount ?? 0,
        ).toBeGreaterThanOrEqual(1);

        const reviewWhipRecord = await waitForAssistantReply(
          sessionId,
          reviewSessionId!,
          reviewResumeAssistantCount + 1,
          "Keep working until you are done",
        );
        expect(assistantMessages(reviewWhipRecord).length).toBeGreaterThan(
          reviewResumeAssistantCount,
        );

        const blockedTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "Blocked resume continuation task",
            description:
              "Verify blocked Resume restarts real session activity.",
            type: "task",
            status: "ready",
            priority: "P2",
            workflowId: workflow.id,
            currentLaneId: "lane-implement",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });

        const dispatchedBlockedTask = await dispatchTaskToActiveSession(
          sessionId,
          blockedTask.id,
          role.id,
        );
        const blockedSessionId =
          dispatchedBlockedTask.activeLaneAssignment?.sessionId;
        expect(blockedSessionId).toBeTruthy();

        const initialBlockedRecord = await waitForAssistantReply(
          sessionId,
          blockedSessionId!,
          1,
          "Verify blocked Resume restarts real session activity.",
        );
        const initialBlockedAssistantCount =
          assistantMessages(initialBlockedRecord).length;

        await updateTaskStatus(sessionId, blockedTask.id, "blocked");
        const pausedBlockedTask = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: blockedTask.id,
            }),
          (task) =>
            task.status === "blocked" &&
            task.activeLaneAssignment?.status === "paused_by_user",
        );
        expect(pausedBlockedTask.activeLaneAssignment?.sessionId).toBe(
          blockedSessionId,
        );

        await openTaskCard(sessionId, "Blocked resume continuation task");
        await clickByText(sessionId, "[role=tab]", "Runtime");
        await waitForText(sessionId, "Lane execution");
        await clickSelector(sessionId, '[data-role="resume-task-lane"]');

        const resumedBlockedTask = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: blockedTask.id,
            }),
          (task) =>
            task.status === "in_progress" &&
            task.activeLaneAssignment?.status === "active",
        );
        expect(resumedBlockedTask.activeLaneAssignment?.sessionId).toBe(
          blockedSessionId,
        );

        const blockedResumeRecord = await waitForAssistantReply(
          sessionId,
          blockedSessionId!,
          initialBlockedAssistantCount + 1,
          "The user has requested more work be done on this lane.",
        );
        expect(assistantMessages(blockedResumeRecord).length).toBeGreaterThan(
          initialBlockedAssistantCount,
        );
      } finally {
        await deleteWebdriverSession(sessionId);
      }
    },
    240_000,
  );
});
