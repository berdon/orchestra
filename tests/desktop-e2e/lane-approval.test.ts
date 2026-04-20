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

async function cycleIdleSessionSubscription(sessionId: string, workerSessionId: string, timeoutMs = 60_000) {
  const idleRecord = await waitForCondition(
    () => invokeCommand<any>(sessionId, 'get_session_record', { sessionId: workerSessionId }),
    (record) => record.status === 'idle',
    timeoutMs,
  );
  expect(idleRecord.id).toBe(workerSessionId);

  const subscribedRecord = await invokeCommand<any>(sessionId, 'subscribe_session', { sessionId: workerSessionId });
  expect(subscribedRecord.id).toBe(workerSessionId);

  const unsubscribedRecord = await invokeCommand<any>(sessionId, 'unsubscribe_session', { sessionId: workerSessionId });
  expect(unsubscribedRecord.id).toBe(workerSessionId);

  const responsiveRecord = await invokeCommand<any>(sessionId, 'get_session_record', { sessionId: workerSessionId });
  expect(responsiveRecord.id).toBe(workerSessionId);
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

      const taskBeforeApprovalPause = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => ['active', 'queued', 'awaiting_user_approval'].includes(task.activeLaneAssignment?.status ?? ''),
      );
      if (taskBeforeApprovalPause.activeLaneAssignment?.status === 'active') {
        await completeTaskLaneWithRetries(sessionId, createdTask!.id);
      }

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
      expect(['active', 'idle']).toContain(waitingSessions.find((entry) => entry.id === workerSessionId)?.status);
      await cycleIdleSessionSubscription(sessionId, workerSessionId!);
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
      expect(['active', 'idle']).toContain(waitingSessions.find((entry) => entry.id === workerSessionId)?.status);
      await cycleIdleSessionSubscription(sessionId, workerSessionId!);

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

  it.skipIf(!isDesktopE2E)("keeps a paused idle worker session responsive when sending a direct message after unsubscribe", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");

      await createProjectViaSettings(sessionId, "Intervention Message Project", "Desktop end-to-end paused-session messaging regression test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Intervention Message Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Intervention Message Project");
      await createRoleViaSettings(sessionId, {
        name: "Intervention Message Worker",
        capacity: "1",
        description: "Implements work that pauses for user intervention before a direct message is sent.",
      });
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === 'Intervention Message Worker'));
      expect(role).toBeTruthy();
      await createWorkflowViaSettings(sessionId, {
        name: "Intervention Message Flow",
        description: "Worker pauses for user intervention and should remain messageable after unsubscribe.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: "intervention-message-worker",
            entryPromptTemplate: "Implement the task and ask for user intervention if needed.",
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: "Paused worker message task",
        description: "Verify a paused idle worker session can still receive a direct message after unsubscribe.",
        repositoryName: "Intervention Message Repo",
        workflowName: "Intervention Message Flow",
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Intervention Message Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Paused worker message task'));
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
        notes: 'Pause so the desktop regression can send a direct session message.',
      });

      await waitForCondition(
        () => invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask!.id }),
        (task) => task.status === 'in_review' && task.activeLaneAssignment?.status === 'awaiting_user_intervention',
      );
      await cycleIdleSessionSubscription(sessionId, workerSessionId!);

      const beforeMessage = await invokeCommand<any>(sessionId, 'get_session_record', { sessionId: workerSessionId! });
      const directMessageRunId = `paused-message-${Date.now()}`;
      const queuedMessage = await invokeCommand<{ sessionId: string; runId: string; message: string }>(sessionId, 'send_session_message', {
        sessionId: workerSessionId,
        message: 'Stay paused for review. Do not take any task actions yet. Reply with a short acknowledgement only.',
        runId: directMessageRunId,
      });
      expect(queuedMessage.sessionId).toBe(workerSessionId);
      expect(queuedMessage.runId).toBe(directMessageRunId);

      const responsiveTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask!.id });
      expect(responsiveTask.status).toBe('in_review');
      expect(responsiveTask.activeLaneAssignment?.status).toBe('awaiting_user_intervention');
      expect(responsiveTask.activeLaneAssignment?.sessionId).toBe(workerSessionId);

      const responsiveSession = await invokeCommand<any>(sessionId, 'get_session_record', { sessionId: workerSessionId! });
      expect(responsiveSession.id).toBe(workerSessionId);
      expect(new Date(responsiveSession.updatedAt).getTime()).toBeGreaterThanOrEqual(new Date(beforeMessage.updatedAt).getTime());

      const logs = await invokeCommand<Array<{ target?: string; message?: string }>>(sessionId, 'get_logs');
      expect(logs.some((entry) => entry.target === 'sessions.message.start' && String(entry.message ?? '').includes(workerSessionId!))).toBe(true);
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
      const implementAgent = await invokeCommand<{ slug: string }>(sessionId, 'create_agent', {
        input: {
          name: 'Relane Implement Agent',
          description: 'Handles the first approval-gated lane.',
          systemPrompt: 'When dispatched, complete the lane and stop for review.',
          provider: 'openai-codex',
          model: 'gpt-5.3-codex-spark',
          thinkingLevel: 'off',
          policyIds: ['policy-supervisor'],
        },
      });
      const reviewAgent = await invokeCommand<{ slug: string }>(sessionId, 'create_agent', {
        input: {
          name: 'Relane Review Agent',
          description: 'Handles the relaned follow-up lane.',
          systemPrompt: 'When dispatched, finish the relaned lane successfully.',
          provider: 'openai-codex',
          model: 'gpt-5.3-codex-spark',
          thinkingLevel: 'off',
          policyIds: ['policy-supervisor'],
        },
      });
      await invokeCommand(sessionId, 'create_workflow', {
        input: {
          name: 'Relane Flow',
          description: 'Worker success can be redirected into a different lane.',
          lanes: [
            {
              name: 'Implement',
              key: 'implement',
              assignedEntityType: 'agent',
              assignedEntityId: implementAgent.slug,
              entryPromptTemplate: 'Implement the task and stop for review.',
              requireUserApprovalOnSuccess: true,
              successTransitionType: 'end',
              failureTransitionType: 'end',
            },
            {
              name: 'Review pass',
              key: 'review-pass',
              assignedEntityType: 'agent',
              assignedEntityId: reviewAgent.slug,
              entryPromptTemplate: 'Take over the redirected task and finish it.',
              successTransitionType: 'end',
              failureTransitionType: 'end',
            },
          ],
        },
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
            currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          }
          return currentTask;
        },
        (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.status === 'active',
      );
      const initialWorkerSessionId = dispatchedTask.activeLaneAssignment?.sessionId ?? null;

      const taskBeforeApprovalPause = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => ['active', 'awaiting_user_approval'].includes(task.activeLaneAssignment?.status ?? ''),
      );
      if (taskBeforeApprovalPause.activeLaneAssignment?.status === 'active') {
        await completeTaskLaneWithRetries(sessionId, createdTask!.id);
      }

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
        async () => {
          let task = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          return task;
        },
        (task) => task.status === 'in_progress' && Boolean(task.activeLaneAssignment),
      );
      expect(relanedTask.currentLaneId).toBeTruthy();
      expect(relanedTask.activeLaneAssignment?.laneId).toBeTruthy();
      expect(['queued', 'active']).toContain(relanedTask.activeLaneAssignment?.status);
      if (initialWorkerSessionId && relanedTask.activeLaneAssignment?.sessionId) {
        expect(relanedTask.activeLaneAssignment.sessionId).not.toBe(initialWorkerSessionId);
      }
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
