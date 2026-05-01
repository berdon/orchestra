import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickSelector,
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
  openRoleOperations,
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

describe("desktop workflow recovery", () => {
  it.skipIf(!isDesktopE2E)("resets multiple UI-dispatched workflow tasks and clears role runtime/session state", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const suffix = Date.now().toString(36);
      const projectName = `Role Reset Project ${suffix}`;
      const repositoryName = `Role Reset Repo ${suffix}`;
      const workflowName = `Role Reset Flow ${suffix}`;
      const roleName = `Reset Worker ${suffix}`;
      const roleReference = `reset-worker-${suffix}`;
      const taskATitle = `Reset task A ${suffix}`;
      const taskBTitle = `Reset task B ${suffix}`;
      const repositoryRoot = join(testHome!, "workspace", `role-reset-repo-${suffix}`, "repository");

      await createProjectViaSettings(sessionId, projectName, "Reset role assignments while preserving queued workflow work.");
      await addRepositoryViaSettings(sessionId, {
        name: repositoryName,
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, projectName);
      await createRoleViaSettings(sessionId, {
        name: roleName,
        capacity: "2",
        description: "Worker used for role reset regression coverage.",
      });
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_roles", { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === roleName));
      expect(role).toBeTruthy();
      await createWorkflowViaSettings(sessionId, {
        name: workflowName,
        description: "Single role lane for reset testing.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: roleReference,
            entryPromptTemplate: "Implement the task.",
          },
        ],
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === projectName));
      expect(project).toBeTruthy();

      await createTaskViaTasks(sessionId, {
        title: taskATitle,
        description: "First task for role reset coverage.",
        repositoryName,
        workflowName,
        publish: true,
      });
      await createTaskViaTasks(sessionId, {
        title: taskBTitle,
        description: "Second task for role reset coverage.",
        repositoryName,
        workflowName,
        publish: true,
      });

      const activeRoleOps = await waitForCondition(
        async () => {
          await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
          await invokeCommand(sessionId, "dispatch_role_queue", { roleId: role!.id }).catch(() => undefined);
          return invokeCommand<any>(sessionId, "get_role_operations", { roleId: role!.id });
        },
        (detail) => detail.activeInstanceCount === 2 && detail.assignedCount === 2,
        30_000,
      );
      const sessionIds = activeRoleOps.instances
        .filter((instance: any) => instance.status === "running")
        .map((instance: any) => instance.sessionId)
        .filter((value: string | null | undefined): value is string => Boolean(value));
      expect(sessionIds).toHaveLength(2);

      await openRoleOperations(sessionId, roleName);
      await waitForText(sessionId, roleName);
      const resetEnabled = await executeScript<boolean>(
        sessionId,
        `
          const button = document.querySelector('[data-role="reset-role-assignments"]');
          return button instanceof HTMLButtonElement ? !button.disabled : false;
        `,
      );
      expect(resetEnabled).toBe(true);
      await clickSelector(sessionId, '[data-role="reset-role-assignments"]');

      const resetRoleOps = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_role_operations", { roleId: role!.id }),
        (detail) => detail.activeInstanceCount === 0 && detail.assignedCount === 0 && detail.queuedCount === 2,
        30_000,
      );
      expect(resetRoleOps.instances.every((instance: any) => !instance.currentQueueEntryId)).toBe(true);

      const tasks = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      });
      const taskIds = tasks
        .filter((entry) => entry.title === taskATitle || entry.title === taskBTitle)
        .map((entry) => entry.id);
      expect(taskIds).toHaveLength(2);

      for (const taskId of taskIds) {
        const task = await invokeCommand<any>(sessionId, "get_task", { taskId });
        expect(task.status).toBe("ready");
        expect([undefined, "queued"]).toContain(task.activeLaneAssignment?.status);
        if (task.activeLaneAssignment) {
          expect(task.activeLaneAssignment.sessionId).toBeNull();
          expect(task.activeLaneAssignment.roleInstanceId).toBeNull();
        }
      }

      const sessions = await invokeCommand<Array<{ id: string; status: string }>>(sessionId, "list_sessions");
      for (const staleSessionId of sessionIds) {
        expect([undefined, "closed"]).toContain(sessions.find((entry) => entry.id === staleSessionId)?.status);
      }
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
