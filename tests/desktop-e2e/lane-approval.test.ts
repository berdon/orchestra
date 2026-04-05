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
  createProjectViaSettings,
  createRoleViaSettings,
  createTaskViaTasks,
  createWorkflowViaSettings,
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

async function completeTaskLaneWithRetries(sessionId: string, taskId: string, timeoutMs = 90_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    const task = await invokeCommand<any>(sessionId, 'get_task', { taskId });
    if (task.status === 'in_review' || task.status === 'completed') {
      return task;
    }
    try {
      await invokeCommand(sessionId, 'complete_lane_as_success', { taskId, notes: null });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
    await sleep(1000);
  }
  throw new Error(`Timed out completing task lane ${taskId}: ${lastError}`);
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
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === 'Approval Worker'));
      expect(role).toBeTruthy();
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
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Approval Lane Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Approval gated desktop task'));
      expect(createdTask).toBeTruthy();

      const dispatchedTask = await waitForCondition(
        async () => {
          let currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          if (!currentTask.activeLaneAssignment?.sessionId) {
            await invokeCommand(sessionId, 'dispatch_task_lane', { taskId: createdTask!.id }).catch(() => undefined);
            await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
            await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: role!.id }).catch(() => undefined);
            currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          }
          return currentTask;
        },
        (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.status === 'active' && Boolean(task.activeLaneAssignment?.roleInstanceId),
      );
      const workerSessionId = dispatchedTask.activeLaneAssignment?.sessionId;
      expect(workerSessionId).toBeTruthy();

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);

      await openTaskCard(sessionId, 'Approval gated desktop task');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await waitForText(sessionId, "paused for user approval", 15_000);
      const waitingRoleOps = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      expect(waitingRoleOps.activeInstanceCount).toBe(0);
      const waitingSessions = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, 'list_sessions');
      expect(waitingSessions.find((entry) => entry.id === workerSessionId)?.status).toBe('closed');
      await clickSelector(sessionId, '[data-role="send-task-back-for-work"]');

      const reworkedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_progress" && task.activeLaneAssignment?.status === "active",
      );
      expect(reworkedTask.activeLaneAssignment?.sessionId).toBe(workerSessionId);
      const runningRoleOps = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      expect(runningRoleOps.activeInstanceCount).toBe(1);

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_progress" && task.activeLaneAssignment?.status === "active",
      );
      await completeTaskLaneWithRetries(sessionId, createdTask!.id);
      const postReworkTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "completed" || (task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval"),
      );

      let completedTask = postReworkTask;
      if (postReworkTask.status === "in_review") {
        await invokeCommand(sessionId, 'approve_lane_completion', { taskId: createdTask!.id });
        completedTask = await waitForCondition(
          () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
          (task) => task.status === "completed",
        );
      }

      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.laneRuns).toHaveLength(1);
      expect(["success", "needs_user"]).toContain(completedTask.laneRuns[0].result);
      expect(completedTask.laneRuns[0].completedAt).toBeTruthy();
      const completedRoleOps = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      expect(completedRoleOps.activeInstanceCount).toBe(0);
      const finalSessions = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, 'list_sessions');
      expect(finalSessions.find((entry) => entry.id === workerSessionId)?.status).toBe('closed');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
