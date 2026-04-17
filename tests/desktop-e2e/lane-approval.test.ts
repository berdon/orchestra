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
  setInputValue,
  sleep,
  waitForSelector,
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
      expect(waitingSessions.find((entry) => entry.id === workerSessionId)?.status).toBe('active');
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

  it.skipIf(!isDesktopE2E)("resumes a lane paused for user intervention on the same worker session", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");

      await createProjectViaSettings(sessionId, "Intervention Lane Project", "Desktop end-to-end user intervention resume flow test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Intervention Lane Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Intervention Lane Project");
      await createRoleViaSettings(sessionId, {
        name: "Intervention Worker",
        capacity: "1",
        description: "Implements work that may pause for user intervention.",
      });
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === 'Intervention Worker'));
      expect(role).toBeTruthy();
      await createWorkflowViaSettings(sessionId, {
        name: "Intervention Flow",
        description: "Worker can pause for user intervention and resume the same session.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: "intervention-worker",
            entryPromptTemplate: "Implement the task and ask for user intervention if needed.",
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: "User intervention desktop task",
        description: "Verify user intervention resumes the same worker session.",
        repositoryName: "Intervention Lane Repo",
        workflowName: "Intervention Flow",
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Intervention Lane Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'User intervention desktop task'));
      expect(createdTask).toBeTruthy();

      const dispatchedTask = await waitForCondition(
        async () => {
          let currentTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask!.id });
          if (!currentTask.activeLaneAssignment?.sessionId) {
            await invokeCommand(sessionId, 'dispatch_task_lane', { taskId: createdTask!.id }).catch(() => undefined);
            await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
            await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: role!.id }).catch(() => undefined);
            currentTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask!.id });
          }
          return currentTask;
        },
        (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.status === 'active' && Boolean(task.activeLaneAssignment?.roleInstanceId),
      );
      const workerSessionId = dispatchedTask.activeLaneAssignment?.sessionId;
      expect(workerSessionId).toBeTruthy();

      await invokeCommand(sessionId, 'request_user_intervention', {
        taskId: createdTask!.id,
        notes: 'Need the user to weigh in before continuing.',
      });

      await openTaskCard(sessionId, 'User intervention desktop task');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');
      await waitForCondition(
        () => invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask!.id }),
        (task) => task.status === 'in_review' && task.activeLaneAssignment?.status === 'awaiting_user_intervention',
      );
      await waitForText(sessionId, 'paused until you decide how to continue it', 15_000);
      const waitingRoleOps = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      expect(waitingRoleOps.activeInstanceCount).toBe(0);
      const waitingSessions = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, 'list_sessions');
      expect(waitingSessions.find((entry) => entry.id === workerSessionId)?.status).toBe('active');

      await clickSelector(sessionId, '[data-role="resume-task-lane"]');

      const resumedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask!.id }),
        (task) => task.status === 'in_progress' && task.activeLaneAssignment?.status === 'active',
      );
      expect(resumedTask.activeLaneAssignment?.sessionId).toBe(workerSessionId);
      const runningRoleOps = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      expect(runningRoleOps.activeInstanceCount).toBe(1);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);

  it.skipIf(!isDesktopE2E)("re-lanes approval-paused work into a selected worker lane and dispatches it", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");

      await createProjectViaSettings(sessionId, "Relane Lane Project", "Desktop end-to-end re-lane flow test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Relane Lane Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Relane Lane Project");
      await createRoleViaSettings(sessionId, {
        name: "Relane Worker",
        capacity: "1",
        description: "Handles approval and follow-up lanes.",
      });
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === 'Relane Worker'));
      expect(role).toBeTruthy();
      await createWorkflowViaSettings(sessionId, {
        name: "Relane Flow",
        description: "Worker success can be redirected into a different lane.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: "relane-worker",
            entryPromptTemplate: "Implement the task and stop for review.",
            requireUserApprovalOnSuccess: true,
          },
          {
            name: "Review pass",
            key: "review-pass",
            ownerType: "role",
            ownerReference: "relane-worker",
            entryPromptTemplate: "Take over the redirected task and finish it.",
          },
        ],
      });
      const workflow = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false })
        .then((workflows) => workflows.find((entry) => entry.name === 'Relane Flow'))
        .then((summary) => {
          expect(summary).toBeTruthy();
          return invokeCommand<any>(sessionId, 'get_workflow', { workflowId: summary!.id });
        });
      const reviewPassLaneId = workflow.lanes.find((lane: { key: string }) => lane.key === 'review-pass')?.id;
      expect(reviewPassLaneId).toBeTruthy();
      await createTaskViaTasks(sessionId, {
        title: "Approval relane desktop task",
        description: "Verify re-lane flow against the desktop runtime.",
        repositoryName: "Relane Lane Repo",
        workflowName: "Relane Flow",
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Relane Lane Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Approval relane desktop task'));
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
      const initialWorkerSessionId = dispatchedTask.activeLaneAssignment?.sessionId;
      expect(initialWorkerSessionId).toBeTruthy();

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);

      await openTaskCard(sessionId, 'Approval relane desktop task');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await clickSelector(sessionId, '[data-role="toggle-task-relane"]');
      await waitForSelector(sessionId, '[data-role="task-relane-menu"]');
      await executeScript(sessionId, `
        const option = Array.from(document.querySelectorAll('[data-role="task-relane-option"]')).find((entry) =>
          entry.getAttribute('data-lane-id') === arguments[0],
        );
        if (!(option instanceof HTMLElement)) return false;
        option.click();
        return true;
      `, [reviewPassLaneId]);
      await waitForSelector(sessionId, '[data-role="task-relane-confirm-dialog"]');
      await setInputValue(sessionId, '[data-role="task-relane-notes"]', 'Redirect this to the review-pass lane.');
      await clickSelector(sessionId, '[data-role="task-relane-confirm"]');

      const relanedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.currentLaneId === reviewPassLaneId && task.status === 'in_progress' && task.activeLaneAssignment?.status === 'active',
      );
      expect(relanedTask.activeLaneAssignment?.laneId).toBe(reviewPassLaneId);
      expect(relanedTask.activeLaneAssignment?.sessionId).toBeTruthy();
      expect(relanedTask.activeLaneAssignment?.sessionId).not.toBe(initialWorkerSessionId);
      expect(relanedTask.laneRuns[0]?.result).toBe('failure');

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);
      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === 'completed',
      );
      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.laneRuns).toHaveLength(2);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
