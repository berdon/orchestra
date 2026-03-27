import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  invokeCommand,
  selectValue,
  sleep,
  waitForSelectOption,
  waitForText,
} from "./driver";

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

describe("desktop approval-gated workflow lanes", () => {
  it.skipIf(!isDesktopE2E)("holds worker success for approval and resumes the same session for rework", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Approval Lane Project",
          description: "Desktop end-to-end approval lane flow test.",
        },
      });

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Approval Lane Repo",
          repositoryPath: repositoryRoot,
          defaultBranch: "main",
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(1_000);

      const developer = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Approval Worker",
          description: "Implements work that needs review approval.",
          systemPrompt: null,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });

      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Approval Flow",
          description: "Worker success pauses for user approval.",
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: developer.slug,
              entryPromptTemplate: "Implement the task and stop at review.",
              requireUserApprovalOnSuccess: true,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "user_intervention",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const createdTask = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Approval gated desktop task",
          description: "Verify approval/rework flow against the desktop runtime.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository.id,
          parentTaskId: null,
          archived: false,
        },
      });

      let dispatchedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => Boolean(task.activeLaneAssignment?.sessionId) || task.readyForDispatch === true,
      );
      if (!dispatchedTask.activeLaneAssignment?.sessionId) {
        const dispatchDeadline = Date.now() + 20_000;
        let lastError = "dispatch_task_lane did not complete before timeout";
        while (Date.now() < dispatchDeadline) {
          try {
            dispatchedTask = await invokeCommand<any>(sessionId, "dispatch_task_lane", { taskId: createdTask.id });
            if (dispatchedTask.activeLaneAssignment?.sessionId) {
              break;
            }
          } catch (error) {
            lastError = error instanceof Error ? error.message : String(error);
            if (!lastError.includes("already processing a message")) {
              throw error;
            }
          }

          dispatchedTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id });
          if (dispatchedTask.activeLaneAssignment?.sessionId) {
            break;
          }
          await sleep(500);
        }

        if (!dispatchedTask.activeLaneAssignment?.sessionId) {
          throw new Error(lastError);
        }
      }
      const workerSessionId = dispatchedTask.activeLaneAssignment?.sessionId;
      expect(workerSessionId).toBeTruthy();

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Tasks");
      await clickByText(sessionId, "button", createdTask.title);
      await waitForText(sessionId, createdTask.title);
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');

      await invokeCommand<any>(sessionId, "complete_lane_as_success", {
        taskId: createdTask.id,
        notes: "Ready for approval in desktop e2e.",
      });

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await waitForText(sessionId, "paused for user approval", 15_000);
      await clickSelector(sessionId, '[data-role="send-task-back-for-work"]');

      const reworkedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "in_progress" && task.activeLaneAssignment?.status === "active",
      );
      expect(reworkedTask.activeLaneAssignment?.sessionId).toBe(workerSessionId);

      await invokeCommand<any>(sessionId, "complete_lane_as_success", {
        taskId: createdTask.id,
        notes: "Ready for approval again in desktop e2e.",
      });
      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );

      await clickSelector(sessionId, '[data-role="approve-task-lane"]');
      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (task) => task.status === "completed" && task.activeLaneAssignment == null,
      );

      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.laneRuns).toHaveLength(1);
      expect(completedTask.laneRuns[0].result).toBe("success");
      expect(completedTask.laneRuns[0].completedAt).toBeTruthy();
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
