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
import {
  addRepositoryViaSettings,
  completeTaskSuccessViaUi,
  createProjectViaSettings,
  createRoleViaSettings,
  createTaskViaTasks,
  createWorkflowViaSettings,
  dispatchTaskViaUi,
  openTaskCard,
  switchProject,
} from "./ui-flows";

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

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");

      await createProjectViaSettings(sessionId, "Approval Lane Project", "Desktop end-to-end approval lane flow test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Approval Lane Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Approval Lane Project");
      await createRoleViaSettings(sessionId, {
        name: "Approval Worker",
        capacity: "1",
        description: "Implements work that needs review approval.",
      });
      await createWorkflowViaSettings(sessionId, {
        name: "Approval Flow",
        description: "Worker success pauses for user approval.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: "approval-worker",
            entryPromptTemplate: "Implement the task and stop at review.",
            requireUserApprovalOnSuccess: true,
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: "Approval gated desktop task",
        description: "Verify approval/rework flow against the desktop runtime.",
        repositoryName: "Approval Lane Repo",
        workflowName: "Approval Flow",
        publish: true,
      });
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Approval gated desktop task'));
      expect(createdTask).toBeTruthy();

      await openTaskCard(sessionId, 'Approval gated desktop task');
      await dispatchTaskViaUi(sessionId);
      const dispatchedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => Boolean(task.activeLaneAssignment?.sessionId),
      );
      const workerSessionId = dispatchedTask.activeLaneAssignment?.sessionId;
      expect(workerSessionId).toBeTruthy();

      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');

      await completeTaskSuccessViaUi(sessionId);

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await waitForText(sessionId, "paused for user approval", 15_000);
      await clickSelector(sessionId, '[data-role="send-task-back-for-work"]');

      const reworkedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_progress" && task.activeLaneAssignment?.status === "active",
      );
      expect(reworkedTask.activeLaneAssignment?.sessionId).toBe(workerSessionId);

      await completeTaskSuccessViaUi(sessionId);
      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );

      await clickSelector(sessionId, '[data-role="approve-task-lane"]');
      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
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
