import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  waitForText,
} from "./driver";
import { openTaskCard, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(500);
  }

  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function completeTaskLaneWithRetries(sessionId: string, taskId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const task = await invokeCommand<any>(sessionId, "get_task", { taskId });
    if (task.status === "in_review" || task.status === "completed") {
      return task;
    }
    try {
      await invokeCommand(sessionId, "complete_lane_as_success", { taskId, summary: "Completed the review lane successfully.", notes: null });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
    await sleep(1000);
  }
  throw new Error(`Timed out completing task lane ${taskId}: ${lastError}`);
}

async function expectTaskDetailHeaderActions(
  sessionId: string,
  expected: { approve: boolean; needsWork: boolean; pause: boolean; resume?: boolean },
  timeoutMs = 30_000,
) {
  await waitForCondition(
    () => executeScript<{ approve: boolean; needsWork: boolean; pause: boolean; resume: boolean }>(sessionId, `
      const isVisible = (selector) => {
        const element = document.querySelector(selector);
        return element instanceof HTMLElement && element.offsetParent !== null;
      };
      return {
        approve: isVisible('[data-role="approve-task-lane"], [data-role="complete-task-success"]'),
        needsWork: isVisible('[data-role="send-task-back-for-work"], [data-role="complete-task-failure"]'),
        pause: isVisible('[data-role="pause-task-runtime"]'),
        resume: isVisible('[data-role="resume-task-lane"]'),
      };
    `),
    (value) => value.approve === expected.approve
      && value.needsWork === expected.needsWork
      && value.pause === expected.pause
      && value.resume === (expected.resume ?? false),
    timeoutMs,
  );
}

describe("desktop review action regression", () => {
  it.skipIf(!isDesktopE2E)("shows approve / needs work for approval-paused review work and keeps the approval flow green", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "review-action-regression-repo", "repository");

      const project = await invokeCommand<{ id: string }>(sessionId, "create_project", {
        input: {
          name: "Review Action Regression Project",
          taskPrefix: "RAR",
          description: "Desktop review action regression coverage.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Review Action Regression Repo",
          repositoryPath: repositoryRoot,
          defaultBranch: "main",
        },
      });
      await invokeCommand(sessionId, "set_project_default_repository", {
        projectId: project.id,
        repositoryId: repository.id,
      });
      await switchProject(sessionId, "Review Action Regression Project");
      const role = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Review Action Worker",
          description: "Implements work that pauses for approval.",
          systemPrompt: "Implement the task and stop for review.",
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Review Action Flow",
          description: "Worker success pauses for user approval.",
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Implement the task and stop for review.",
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
      });
      const createdTask = await invokeCommand<any>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Review action regression task",
          description: "Verify desktop approval-paused review actions stay on approve / needs work.",
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

      await waitForCondition(
        async () => {
          let currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id });
          if (!currentTask.activeLaneAssignment?.sessionId) {
            await invokeCommand(sessionId, "dispatch_task_lane", { taskId: createdTask.id }).catch(() => undefined);
            await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
            await invokeCommand(sessionId, "dispatch_role_queue", { roleId: role.id }).catch(() => undefined);
            currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id });
          }
          return currentTask;
        },
        (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.status === "active",
      );

      await openTaskCard(sessionId, "Review action regression task");
      await clickByText(sessionId, "[role=tab]", "Runtime");
      await waitForText(sessionId, "Lane execution");
      await expectTaskDetailHeaderActions(sessionId, {
        approve: false,
        needsWork: false,
        pause: true,
      });

      await completeTaskLaneWithRetries(sessionId, createdTask.id);
      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await waitForText(sessionId, "paused for user approval", 15_000);
      await expectTaskDetailHeaderActions(sessionId, {
        approve: true,
        needsWork: true,
        pause: false,
        resume: false,
      });

      await clickSelector(sessionId, '[data-role="send-task-back-for-work"]');
      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "in_progress" && task.activeLaneAssignment?.status === "active",
      );
      await expectTaskDetailHeaderActions(sessionId, {
        approve: false,
        needsWork: false,
        pause: true,
        resume: false,
      });

      await completeTaskLaneWithRetries(sessionId, createdTask.id);
      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await expectTaskDetailHeaderActions(sessionId, {
        approve: true,
        needsWork: true,
        pause: false,
        resume: false,
      });

      await clickSelector(sessionId, '[data-role="approve-task-lane"]');
      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "completed",
      );
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
