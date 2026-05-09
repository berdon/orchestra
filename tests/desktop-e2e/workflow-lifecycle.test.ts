import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
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

async function completeTaskLaneWithRetries(sessionId: string, taskId: string, timeoutMs = 60_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    const task = await invokeCommand<any>(sessionId, 'get_task', { taskId });
    if (!task.activeLaneAssignment) {
      return task;
    }
    try {
      await invokeCommand(sessionId, 'complete_lane_as_success', { taskId, summary: 'Completed the workflow lane successfully.', notes: null });
      return task;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!lastError.includes('already processing a message')) {
        throw error;
      }
    }
    await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
    await sleep(1_000);
  }
  throw new Error(`Timed out completing task lane ${taskId}: ${lastError}`);
}

describe("desktop workflow lifecycle", () => {
  it.skipIf(!isDesktopE2E)("follows a multi-role task from creation to completion with visible runtime sessions", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "workflow-lifecycle-repo", "repository");

      await createProjectViaSettings(sessionId, "Workflow Lifecycle Project", "Desktop end-to-end workflow lifecycle test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Workflow Lifecycle Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Workflow Lifecycle Project");
      await createRoleViaSettings(sessionId, { name: "Architect", capacity: "1", description: "Plans the work." });
      await createRoleViaSettings(sessionId, { name: "Developer", capacity: "1", description: "Implements the work." });
      await createRoleViaSettings(sessionId, { name: "QA", capacity: "1", description: "Validates the work." });
      const roles = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false });
      const architectRole = roles.find((entry) => entry.name === 'Architect');
      const developerRole = roles.find((entry) => entry.name === 'Developer');
      const qaRole = roles.find((entry) => entry.name === 'QA');
      expect(architectRole).toBeTruthy();
      expect(developerRole).toBeTruthy();
      expect(qaRole).toBeTruthy();
      await createWorkflowViaSettings(sessionId, {
        name: "Workflow Lifecycle",
        description: "Three real role lanes ending in completion.",
        lanes: [
          { name: "Plan", key: "plan", ownerType: "role", ownerReference: "architect", entryPromptTemplate: "Plan the implementation." },
          { name: "Implement", key: "implement", ownerType: "role", ownerReference: "developer", entryPromptTemplate: "Implement the plan." },
          { name: "Validate", key: "validate", ownerType: "role", ownerReference: "qa", entryPromptTemplate: "Validate the implementation." },
        ],
      });
      const workflow = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false })
        .then((workflows) => workflows.find((entry) => entry.name === 'Workflow Lifecycle'))
        .then((summary) => {
          expect(summary).toBeTruthy();
          return invokeCommand<any>(sessionId, 'get_workflow', { workflowId: summary!.id });
        });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Workflow Lifecycle Project'));
      expect(project).toBeTruthy();
      const repository = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_repositories', { projectId: project!.id })
        .then((repositories) => repositories.find((entry) => entry.name === 'Workflow Lifecycle Repo'));
      expect(repository).toBeTruthy();
      await invokeCommand(sessionId, 'create_task', {
        projectId: project!.id,
        input: {
          title: 'Desktop workflow lifecycle task',
          description: 'Exercise task dispatch, session creation, transitions, and completion.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0]?.id ?? null,
          repositoryId: repository!.id,
          repositoryIds: [repository!.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });
      await executeScript(sessionId, `window.dispatchEvent(new CustomEvent('orchestra:projects-changed')); window.location.reload(); return true;`);
      await sleep(1_000);
      await ensureReactReady(sessionId);
      await switchProject(sessionId, 'Workflow Lifecycle Project');
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Desktop workflow lifecycle task'));
      expect(createdTask).toBeTruthy();

      const task = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
      expect(task.repositoryId).toBeTruthy();

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Sessions");

      await openTaskCard(sessionId, 'Desktop workflow lifecycle task');

      const plannedTask = await waitForCondition(
        async () => {
          let currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          if (!currentTask.activeLaneAssignment?.sessionId) {
            await invokeCommand(sessionId, 'dispatch_task_lane', { taskId: createdTask!.id }).catch(() => undefined);
            await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
            await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: architectRole!.id }).catch(() => undefined);
            currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          }
          return currentTask;
        },
        (currentTask) => Boolean(currentTask.activeLaneAssignment?.sessionId) && currentTask.activeLaneAssignment?.status === 'active',
        30_000,
      );
      const planSessionId = plannedTask.activeLaneAssignment?.sessionId;
      expect(planSessionId).toBeTruthy();
      await waitForCondition(
        () => invokeCommand<Array<{ id: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.id === planSessionId),
        30_000,
      );

      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await completeTaskLaneWithRetries(sessionId, createdTask!.id);

      const implementedTask = await waitForCondition(
        async () => {
          await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
          await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: developerRole!.id }).catch(() => undefined);
          return invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
        },
        (currentTask) => Boolean(currentTask.activeLaneAssignment?.sessionId) && currentTask.activeLaneAssignment?.status === 'active' && currentTask.activeLaneAssignment?.sessionId !== planSessionId,
        30_000,
      );
      const sessionsAfterPlan = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, "list_sessions");
      expect(sessionsAfterPlan.find((entry) => entry.id === planSessionId)?.status).toBe("closed");
      const implementSessionId = implementedTask.activeLaneAssignment?.sessionId;
      expect(implementSessionId).toBeTruthy();

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);

      const validatedTask = await waitForCondition(
        async () => {
          await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
          await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: qaRole!.id }).catch(() => undefined);
          return invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
        },
        (currentTask) => Boolean(currentTask.activeLaneAssignment?.sessionId) && currentTask.activeLaneAssignment?.status === 'active' && currentTask.activeLaneAssignment?.sessionId !== implementSessionId,
        30_000,
      );
      const sessionsAfterImplement = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, "list_sessions");
      expect(sessionsAfterImplement.find((entry) => entry.id === implementSessionId)?.status).toBe("closed");
      const validateSessionId = validatedTask.activeLaneAssignment?.sessionId;
      expect(validateSessionId).toBeTruthy();

      await completeTaskLaneWithRetries(sessionId, createdTask!.id);

      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (currentTask) => currentTask.status === "completed" && currentTask.activeLaneAssignment == null,
        30_000,
      );

      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.laneRuns).toHaveLength(3);
      expect(completedTask.laneRuns.map((run: { result: string }) => run.result)).toEqual(["success", "success", "success"]);

      const finalSessions = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, "list_sessions");
      expect([undefined, "closed"]).toContain(finalSessions.find((entry) => entry.id === planSessionId)?.status);
      expect([undefined, "closed"]).toContain(finalSessions.find((entry) => entry.id === implementSessionId)?.status);
      expect([undefined, "closed"]).toContain(finalSessions.find((entry) => entry.id === validateSessionId)?.status);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
