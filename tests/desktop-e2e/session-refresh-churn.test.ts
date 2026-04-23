import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import {
  createProjectViaSettings,
  createRoleViaSettings,
  createTaskViaTasks,
  createWorkflowViaSettings,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 60_000) {
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

describe("desktop session refresh churn", () => {
  it.skipIf(!isDesktopE2E)("keeps the Sessions page stable for active assigned task sessions and debounces refresh bursts", async () => {
    const sessionId = await createReadyWebdriverSession();
    const suffix = Date.now().toString(36);
    const projectName = `Refresh Churn ${suffix}`;
    const roleName = `Refresh Role ${suffix}`;
    const workflowName = `Refresh Workflow ${suffix}`;
    const taskTitle = `Refresh task ${suffix}`;

    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, projectName, "Reproduce session refresh churn with an active assignment session.");
      await switchProject(sessionId, projectName);
      await createRoleViaSettings(sessionId, {
        name: roleName,
        capacity: "1",
        description: "Role used for refresh churn regression coverage.",
      });
      await createWorkflowViaSettings(sessionId, {
        name: workflowName,
        description: "Single active role lane.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: `refresh-role-${suffix}`,
            entryPromptTemplate: "Keep working until done.",
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: taskTitle,
        description: "Regression task for session refresh churn.",
        workflowName,
        publish: true,
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === projectName));
      expect(project).toBeTruthy();
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_roles", { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === roleName));
      expect(role).toBeTruthy();
      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === taskTitle));
      expect(task).toBeTruthy();

      const activeTask = await waitForCondition(
        async () => {
          const currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: task!.id });
          if (!currentTask.activeLaneAssignment?.sessionId) {
            await invokeCommand(sessionId, "dispatch_task_lane", { taskId: task!.id }).catch(() => undefined);
            await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
            await invokeCommand(sessionId, "dispatch_role_queue", { roleId: role!.id }).catch(() => undefined);
            return invokeCommand<any>(sessionId, "get_task", { taskId: task!.id });
          }
          return currentTask;
        },
        (currentTask) => Boolean(currentTask.activeLaneAssignment?.sessionId) && currentTask.activeLaneAssignment?.status === "active",
        90_000,
      );
      const workerSessionId = activeTask.activeLaneAssignment.sessionId as string;
      expect(workerSessionId).toBeTruthy();

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Sessions");
      await waitForSelector(sessionId, `[data-session-id="${workerSessionId}"]`);
      await clickSelector(sessionId, `[data-session-id="${workerSessionId}"]`);
      await waitForText(sessionId, roleName);

      const initialStats = await waitForCondition(
        () => executeScript<{ listRefreshCount: number; recordLoadCounts: Record<string, number> }>(sessionId, `
          return window.__orchestraTestSessionRefreshStats ? window.__orchestraTestSessionRefreshStats() : { listRefreshCount: 0, recordLoadCounts: {} };
        `),
        (stats) => (stats.recordLoadCounts[workerSessionId] ?? 0) >= 1,
        30_000,
      );
      const baselineRecordLoads = initialStats.recordLoadCounts[workerSessionId] ?? 0;
      expect(baselineRecordLoads).toBeGreaterThan(0);

      await sleep(2_500);

      const afterWaitStats = await executeScript<{ listRefreshCount: number; recordLoadCounts: Record<string, number> }>(sessionId, `
        return window.__orchestraTestSessionRefreshStats ? window.__orchestraTestSessionRefreshStats() : { listRefreshCount: 0, recordLoadCounts: {} };
      `);
      expect(afterWaitStats.recordLoadCounts[workerSessionId] ?? 0).toBe(baselineRecordLoads);

      const baselineListRefreshes = afterWaitStats.listRefreshCount;
      await executeScript(sessionId, `
        for (let index = 0; index < 5; index += 1) {
          window.dispatchEvent(new CustomEvent("orchestra:session-change", {
            detail: { sessionIds: [${JSON.stringify(workerSessionId)}], reason: "burst-" + index },
          }));
        }
      `);
      await waitForCondition(
        () => executeScript<{ listRefreshCount: number; recordLoadCounts: Record<string, number> }>(sessionId, `
          return window.__orchestraTestSessionRefreshStats ? window.__orchestraTestSessionRefreshStats() : { listRefreshCount: 0, recordLoadCounts: {} };
        `),
        (stats) => stats.listRefreshCount === baselineListRefreshes + 1,
        30_000,
      );

      const beforeUnknownSessionBurst = await executeScript<{ listRefreshCount: number; recordLoadCounts: Record<string, number> }>(sessionId, `
        return window.__orchestraTestSessionRefreshStats ? window.__orchestraTestSessionRefreshStats() : { listRefreshCount: 0, recordLoadCounts: {} };
      `);
      await executeScript(sessionId, `
        const receivedAt = new Date().toISOString();
        for (let index = 0; index < 5; index += 1) {
          window.dispatchEvent(new CustomEvent("orchestra:session-stream", {
            detail: {
              sessionId: "unknown-stream-session",
              runId: "unknown-run-" + index,
              receivedAt,
              event: {
                type: "message_update",
                message: { role: "assistant", content: [{ type: "text", text: "chunk-" + index }] },
                assistantMessageEvent: { type: "text_delta", delta: "chunk-" + index, contentIndex: 0, partial: {} },
              },
            },
          }));
        }
      `);
      await waitForCondition(
        () => executeScript<{ listRefreshCount: number; recordLoadCounts: Record<string, number> }>(sessionId, `
          return window.__orchestraTestSessionRefreshStats ? window.__orchestraTestSessionRefreshStats() : { listRefreshCount: 0, recordLoadCounts: {} };
        `),
        (stats) => stats.listRefreshCount === beforeUnknownSessionBurst.listRefreshCount + 1,
        30_000,
      );
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
