import { describe, expect, it } from "vitest";

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

async function beginTaskListInvokeMonitoring(sessionId: string) {
  await executeScript(
    sessionId,
    `
      window.__orchestraTestTaskListInvokeStats = { total: 0, commands: [] };
      if (!window.__orchestraTestOriginalInvoke && window.__TAURI_INTERNALS__?.invoke) {
        window.__orchestraTestOriginalInvoke = window.__TAURI_INTERNALS__.invoke;
        window.__TAURI_INTERNALS__.invoke = async function(command, args) {
          if (command === 'list_tasks') {
            const stats = window.__orchestraTestTaskListInvokeStats;
            stats.total += 1;
            stats.commands.push({ command, args });
          }
          return await window.__orchestraTestOriginalInvoke.call(this, command, args);
        };
      }
      window.__orchestraTestTaskChangeStats = { total: 0, reasons: {} };
      window.__orchestraTestTaskChangeListener?.();
      const handler = (event) => {
        const detail = event && typeof event === 'object' ? event.detail || {} : {};
        const reason = typeof detail.reason === 'string' ? detail.reason : '<unknown>';
        const stats = window.__orchestraTestTaskChangeStats;
        stats.total += 1;
        stats.reasons[reason] = (stats.reasons[reason] || 0) + 1;
      };
      window.addEventListener('orchestra:task-change', handler);
      window.__orchestraTestTaskChangeListener = () => window.removeEventListener('orchestra:task-change', handler);
      return true;
    `,
  );
}

async function endTaskListInvokeMonitoring(sessionId: string) {
  return executeScript<{
    taskListInvokeStats: { total: number; commands: Array<{ command: string; args: unknown }> };
    taskChangeStats: { total: number; reasons: Record<string, number> };
  }>(
    sessionId,
    `
      const result = {
        taskListInvokeStats: window.__orchestraTestTaskListInvokeStats || { total: 0, commands: [] },
        taskChangeStats: window.__orchestraTestTaskChangeStats || { total: 0, reasons: {} },
      };
      if (window.__orchestraTestOriginalInvoke && window.__TAURI_INTERNALS__) {
        window.__TAURI_INTERNALS__.invoke = window.__orchestraTestOriginalInvoke;
      }
      delete window.__orchestraTestOriginalInvoke;
      delete window.__orchestraTestTaskListInvokeStats;
      window.__orchestraTestTaskChangeListener?.();
      delete window.__orchestraTestTaskChangeListener;
      delete window.__orchestraTestTaskChangeStats;
      return result;
    `,
  );
}

describe("desktop task list startup churn", () => {
  it.skipIf(!isDesktopE2E)("does not keep reloading tasks while the Tasks page sits idle", async () => {
    const sessionId = await createReadyWebdriverSession();

    try {
      await ensureReactReady(sessionId);
      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Tasks");
      await sleep(750);

      await beginTaskListInvokeMonitoring(sessionId);

      await sleep(2000);

      const { taskListInvokeStats, taskChangeStats } = await endTaskListInvokeMonitoring(sessionId);

      if (taskListInvokeStats.total > 0) {
        throw new Error(
          [
            `Observed ${taskListInvokeStats.total} idle list_tasks invoke(s) after settling on Tasks page.`,
            `Task change stats: ${JSON.stringify(taskChangeStats)}`,
            `Invokes: ${JSON.stringify(taskListInvokeStats.commands)}`,
          ].join("\n"),
        );
      }

      expect(taskChangeStats.total).toBe(0);
    } finally {
      await endTaskListInvokeMonitoring(sessionId).catch(() => undefined);
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);

  it.skipIf(!isDesktopE2E)("does not keep reloading tasks while an assigned task session is active", async () => {
    const sessionId = await createReadyWebdriverSession();
    const suffix = Date.now().toString(36);
    const projectName = `Task Churn ${suffix}`;
    const roleName = `Task Churn Role ${suffix}`;
    const workflowName = `Task Churn Workflow ${suffix}`;
    const taskTitle = `Task churn ${suffix}`;

    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, projectName, "Reproduce task list churn while an assigned task is active.");
      await switchProject(sessionId, projectName);
      await createRoleViaSettings(sessionId, {
        name: roleName,
        capacity: "1",
        description: "Role used for task churn regression coverage.",
      });
      await createWorkflowViaSettings(sessionId, {
        name: workflowName,
        description: "Single active role lane.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: `task-churn-role-${suffix}`,
            entryPromptTemplate: "Keep working until done.",
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: taskTitle,
        description: "Regression task for task list churn.",
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

      await waitForCondition(
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

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, taskTitle);
      await sleep(1500);

      await beginTaskListInvokeMonitoring(sessionId);
      await sleep(2000);
      const { taskListInvokeStats, taskChangeStats } = await endTaskListInvokeMonitoring(sessionId);

      if (taskListInvokeStats.total > 0) {
        throw new Error(
          [
            `Observed ${taskListInvokeStats.total} idle list_tasks invoke(s) while an assigned task was active.`,
            `Task change stats: ${JSON.stringify(taskChangeStats)}`,
            `Invokes: ${JSON.stringify(taskListInvokeStats.commands)}`,
          ].join("\n"),
        );
      }
    } finally {
      await endTaskListInvokeMonitoring(sessionId).catch(() => undefined);
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
