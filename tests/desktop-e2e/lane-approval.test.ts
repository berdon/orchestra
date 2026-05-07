import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  clickNthSelector,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  getSelectOptions,
  invokeCommand,
  selectValue,
  setCheckbox,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import {
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
      await invokeCommand(sessionId, 'complete_lane_as_success', { taskId, summary: 'Completed the lane and handed it off for approval.', notes: null });
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
    }
    await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
    await sleep(1000);
  }
  throw new Error(`Timed out completing task lane ${taskId}: ${lastError}`);
}

async function cycleIdleSessionSubscription(sessionId: string, workerSessionId: string, timeoutMs = 60_000) {
  const sessionRecord = await waitForCondition(
    () => invokeCommand<any>(sessionId, 'get_session_record', { sessionId: workerSessionId }),
    (record) => ['idle', 'active'].includes(record.status),
    timeoutMs,
  );
  expect(sessionRecord.id).toBe(workerSessionId);

  const subscribedRecord = await invokeCommand<any>(sessionId, 'subscribe_session', { sessionId: workerSessionId });
  expect(subscribedRecord.id).toBe(workerSessionId);

  const unsubscribedRecord = await invokeCommand<any>(sessionId, 'unsubscribe_session', { sessionId: workerSessionId });
  expect(unsubscribedRecord.id).toBe(workerSessionId);

  const responsiveRecord = await invokeCommand<any>(sessionId, 'get_session_record', { sessionId: workerSessionId });
  expect(responsiveRecord.id).toBe(workerSessionId);
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

describe("desktop approval-gated workflow lanes", () => {
  it.skipIf(!isDesktopE2E)("holds worker success for approval and resumes the same session for rework", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");

      const project = await invokeCommand<{ id: string; name: string; slug: string }>(sessionId, 'create_project', {
        input: {
          name: 'Approval Lane Project',
          taskPrefix: 'ALP',
          description: 'Desktop end-to-end approval lane flow test.',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Approval Lane Repo',
          repositoryPath: repositoryRoot,
          defaultBranch: 'main',
        },
      });
      await invokeCommand(sessionId, 'set_project_default_repository', {
        projectId: project.id,
        repositoryId: repository.id,
      });
      await switchProject(sessionId, 'Approval Lane Project');
      const role = await invokeCommand<{ id: string; slug: string }>(sessionId, 'create_role', {
        input: {
          name: 'Approval Worker',
          description: 'Implements work that needs review approval.',
          systemPrompt: 'Implement the task and stop at review.',
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<any>(sessionId, 'create_workflow', {
        input: {
          name: 'Approval Flow',
          description: 'Worker success pauses for user approval.',
          lanes: [
            {
              id: 'lane-implement',
              key: 'implement',
              name: 'Implement',
              order: 0,
              assignedEntityType: 'role',
              assignedEntityId: role.slug,
              entryPromptTemplate: 'Implement the task and stop at review.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: true,
              needsWorkTargetLaneId: null,
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
          ],
        },
      });
      const createdTask = await invokeCommand<any>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Approval gated desktop task',
          description: 'Verify approval/rework flow against the desktop runtime.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: 'lane-implement',
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });

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

      await openTaskCard(sessionId, 'Approval gated desktop task');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');
      await expectTaskDetailHeaderActions(sessionId, {
        approve: false,
        needsWork: false,
        pause: true,
      });

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval",
      );
      await waitForText(sessionId, "paused for user approval", 15_000);
      await expectTaskDetailHeaderActions(sessionId, {
        approve: true,
        needsWork: true,
        pause: false,
      });
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
      await expectTaskDetailHeaderActions(sessionId, {
        approve: false,
        needsWork: false,
        pause: true,
      });
      const runningRoleOps = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      expect(runningRoleOps.activeInstanceCount).toBe(1);

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);
      const postReworkTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "completed" || (task.status === "in_review" && task.activeLaneAssignment?.status === "awaiting_user_approval"),
      );

      let completedTask = postReworkTask;
      if (postReworkTask.status === "in_review") {
        await expectTaskDetailHeaderActions(sessionId, {
          approve: true,
          needsWork: true,
          pause: false,
        });
        await clickSelector(sessionId, '[data-role="approve-task-lane"]');
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

  it.skipIf(!isDesktopE2E)("configures a Needs Work return lane in workflow settings and sends review-paused work there", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "lane-approval-repo", "repository");

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, 'create_project', {
        input: {
          name: 'Approval Return Project',
          taskPrefix: 'ARP',
          description: 'Desktop workflow settings Needs Work routing test.',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Approval Return Repo',
          repositoryPath: repositoryRoot,
          defaultBranch: 'main',
        },
      });
      await invokeCommand(sessionId, 'set_project_default_repository', {
        projectId: project.id,
        repositoryId: repository.id,
      });
      await switchProject(sessionId, 'Approval Return Project');

      const implementRole = await invokeCommand<{ id: string; slug: string }>(sessionId, 'create_role', {
        input: {
          name: 'Approval Return Worker',
          description: 'Implements work that may need review rework.',
          systemPrompt: 'Implement the task and stop at review.',
          capacity: 1,
        },
      });
      const fixRole = await invokeCommand<{ id: string; slug: string }>(sessionId, 'create_role', {
        input: {
          name: 'Approval Return Fixer',
          description: 'Handles review-returned work.',
          systemPrompt: 'Take over rework that came back from review.',
          capacity: 1,
        },
      });

      await clickByText(sessionId, 'button', 'Settings');
      await clickByText(sessionId, '[role="tab"]', 'Workflows');
      await clickByText(sessionId, 'button', 'New workflow');
      await setFieldByLabel(sessionId, 'Workflow name', 'Approval Return Flow');
      await clickByText(sessionId, '[role="tab"]', 'Lane');
      await setFieldByLabel(sessionId, 'Lane name', 'Implement');
      await setFieldByLabel(sessionId, 'Lane key', 'implement');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', implementRole.slug);
      expect(
        await executeScript<boolean>(sessionId, `return !document.querySelector('[data-role="lane-needs-work-target"]');`),
      ).toBe(true);

      await clickByText(sessionId, 'button', 'Add lane');
      await clickNthSelector(sessionId, '.workflow-board-lane', 1);
      await setFieldByLabel(sessionId, 'Lane name', 'Fix');
      await setFieldByLabel(sessionId, 'Lane key', 'fix');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', fixRole.slug);

      await clickNthSelector(sessionId, '.workflow-board-lane', 0);
      await clickSelector(sessionId, '[data-role="lane-success-review-required"]');
      await waitForSelector(sessionId, '[data-role="lane-needs-work-target"]');
      const needsWorkOptions = await getSelectOptions(sessionId, '[data-role="lane-needs-work-target"]');
      const fixOption = needsWorkOptions.find((option) => option.label === 'Fix');
      expect(fixOption?.value).toBeTruthy();
      await selectValue(sessionId, '[data-role="lane-needs-work-target"]', fixOption!.value);
      await clickSelector(sessionId, '[data-role="save-workflow"]');
      await waitForText(sessionId, 'Approval Return Flow');

      const workflows = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false });
      const workflowSummary = workflows.find((entry) => entry.name === 'Approval Return Flow');
      expect(workflowSummary?.id).toBeTruthy();
      const workflow = await invokeCommand<any>(sessionId, 'get_workflow', { workflowId: workflowSummary!.id });
      expect(workflow.lanes[0].needsWorkTargetLaneId).toBe(workflow.lanes[1].id);

      const createdTask = await invokeCommand<any>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Approval return desktop task',
          description: 'Verify configured Needs Work routing via workflow settings.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0].id,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });

      const dispatchedTask = await waitForCondition(
        async () => {
          let currentTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask.id });
          if (!currentTask.activeLaneAssignment?.sessionId) {
            await invokeCommand(sessionId, 'dispatch_task_lane', { taskId: createdTask.id }).catch(() => undefined);
            await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
            await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: implementRole.id }).catch(() => undefined);
            currentTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask.id });
          }
          return currentTask;
        },
        (task) => Boolean(task.activeLaneAssignment?.sessionId) && task.activeLaneAssignment?.status === 'active',
      );
      const initialSessionId = dispatchedTask.activeLaneAssignment?.sessionId;
      expect(initialSessionId).toBeTruthy();

      await openTaskCard(sessionId, 'Approval return desktop task');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Lane execution');

      await completeTaskLaneWithRetries(sessionId, createdTask.id);
      await waitForCondition(
        () => invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask.id }),
        (task) => task.status === 'in_review' && task.activeLaneAssignment?.status === 'awaiting_user_approval',
      );
      await waitForText(sessionId, 'paused for user approval', 15_000);
      await clickSelector(sessionId, '[data-role="send-task-back-for-work"]');

      const relanedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, 'get_task', { taskId: createdTask.id }),
        (task) => task.status === 'in_progress' && task.activeLaneAssignment?.laneId === workflow.lanes[1].id,
      );
      expect(relanedTask.currentLaneId).toBe(workflow.lanes[1].id);
      expect(relanedTask.activeLaneAssignment?.laneId).toBe(workflow.lanes[1].id);
      expect(relanedTask.activeLaneAssignment?.sessionId).toBeTruthy();
      expect(relanedTask.activeLaneAssignment?.sessionId).not.toBe(initialSessionId);
      expect(relanedTask.laneRuns[0].result).toBe('failure');
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

      const project = await invokeCommand<{ id: string; name: string; slug: string }>(sessionId, 'create_project', {
        input: {
          name: 'Intervention Lane Project',
          taskPrefix: 'ILP',
          description: 'Desktop end-to-end user intervention resume flow test.',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Intervention Lane Repo',
          repositoryPath: repositoryRoot,
          defaultBranch: 'main',
        },
      });
      await invokeCommand(sessionId, 'set_project_default_repository', {
        projectId: project.id,
        repositoryId: repository.id,
      });
      await switchProject(sessionId, 'Intervention Lane Project');
      const role = await invokeCommand<{ id: string; slug: string }>(sessionId, 'create_role', {
        input: {
          name: 'Intervention Worker',
          description: 'Implements work that may pause for user intervention.',
          systemPrompt: 'Implement the task and ask for user intervention if needed.',
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<any>(sessionId, 'create_workflow', {
        input: {
          name: 'Intervention Flow',
          description: 'Worker can pause for user intervention and resume the same session.',
          lanes: [
            {
              id: 'lane-implement',
              key: 'implement',
              name: 'Implement',
              order: 0,
              assignedEntityType: 'role',
              assignedEntityId: role.slug,
              entryPromptTemplate: 'Implement the task and ask for user intervention if needed.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
          ],
        },
      });
      const createdTask = await invokeCommand<any>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'User intervention desktop task',
          description: 'Verify user intervention resumes the same worker session.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: 'lane-implement',
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });

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
        summary: 'Blocked on a user decision before I can continue.',
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

      const project = await invokeCommand<{ id: string; name: string; slug: string }>(sessionId, 'create_project', {
        input: {
          name: 'Intervention Message Project',
          taskPrefix: 'IMP',
          description: 'Desktop end-to-end paused-session messaging regression test.',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Intervention Message Repo',
          repositoryPath: repositoryRoot,
          defaultBranch: 'main',
        },
      });
      await invokeCommand(sessionId, 'set_project_default_repository', {
        projectId: project.id,
        repositoryId: repository.id,
      });
      await switchProject(sessionId, 'Intervention Message Project');
      const role = await invokeCommand<{ id: string; slug: string }>(sessionId, 'create_role', {
        input: {
          name: 'Intervention Message Worker',
          description: 'Implements work that pauses for user intervention before a direct message is sent.',
          systemPrompt: 'Implement the task and ask for user intervention if needed.',
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<any>(sessionId, 'create_workflow', {
        input: {
          name: 'Intervention Message Flow',
          description: 'Worker pauses for user intervention and should remain messageable after unsubscribe.',
          lanes: [
            {
              id: 'lane-implement',
              key: 'implement',
              name: 'Implement',
              order: 0,
              assignedEntityType: 'role',
              assignedEntityId: role.slug,
              entryPromptTemplate: 'Implement the task and ask for user intervention if needed.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
          ],
        },
      });
      const createdTask = await invokeCommand<any>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Paused worker message task',
          description: 'Verify a paused idle worker session can still receive a direct message after unsubscribe.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: 'lane-implement',
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });

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
        summary: 'Pausing this lane for user intervention during the regression flow.',
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
      expect(logs.some((entry) => ['sessions.message.start', 'sessions.message.follow_up'].includes(String(entry.target ?? '')) && String(entry.message ?? '').includes(workerSessionId!))).toBe(true);
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

      const project = await invokeCommand<{ id: string; name: string; slug: string }>(sessionId, 'create_project', {
        input: {
          name: 'Relane Lane Project',
          taskPrefix: 'RLP',
          description: 'Desktop end-to-end re-lane flow test.',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Relane Lane Repo',
          repositoryPath: repositoryRoot,
          defaultBranch: 'main',
        },
      });
      await invokeCommand(sessionId, 'set_project_default_repository', {
        projectId: project.id,
        repositoryId: repository.id,
      });
      await switchProject(sessionId, 'Relane Lane Project');
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
              needsWorkTargetLaneId: null,
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
      const implementLaneId = workflow.lanes.find((lane: { key: string }) => lane.key === 'implement')?.id;
      const reviewPassLaneId = workflow.lanes.find((lane: { key: string }) => lane.key === 'review-pass')?.id;
      expect(implementLaneId).toBeTruthy();
      expect(reviewPassLaneId).toBeTruthy();
      const createdTask = await invokeCommand<any>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Approval relane desktop task',
          description: 'Verify re-lane flow against the desktop runtime.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: implementLaneId,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });

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
        (task) => task.status === "in_review",
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
        async () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => (task.status === 'in_progress' && Boolean(task.activeLaneAssignment)) || task.status === 'completed',
      );
      expect(relanedTask.currentLaneId === null || Boolean(relanedTask.currentLaneId)).toBe(true);
      if (relanedTask.activeLaneAssignment) {
        expect(relanedTask.activeLaneAssignment?.laneId).toBeTruthy();
        expect(['queued', 'active']).toContain(relanedTask.activeLaneAssignment?.status);
      }
      if (initialWorkerSessionId && relanedTask.activeLaneAssignment?.sessionId) {
        expect(relanedTask.activeLaneAssignment.sessionId).not.toBe(initialWorkerSessionId);
      }
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
