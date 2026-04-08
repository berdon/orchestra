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
  waitForText,
} from "./driver";
import { createProjectViaSettings, createTaskViaTasks, createWorkflowViaSettings, switchProject } from "./ui-flows";

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

describe("desktop task whip configuration", () => {
  it.skipIf(!isDesktopE2E)("shows the default whip max attempts and accepts custom values through task creation", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await createProjectViaSettings(sessionId, "Whip Project", "Desktop whip threshold coverage.");
      await switchProject(sessionId, "Whip Project");
      await createWorkflowViaSettings(sessionId, {
        name: "Whip Flow",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "agent",
            ownerReference: "supervisor",
            entryPromptTemplate: "Keep going until done.",
          },
        ],
      });

      await clickByText(sessionId, "button", "Tasks");
      await clickSelector(sessionId, '[data-role="new-task"]');
      const defaultWhipValue = await executeScript<string>(sessionId, `
        const field = document.querySelector('[data-role="task-whip-max-attempts"]');
        return field instanceof HTMLInputElement ? field.value : '';
      `);
      expect(defaultWhipValue).toBe('10');

      await clickByText(sessionId, "button", "Back to tasks");
      await createTaskViaTasks(sessionId, {
        title: "Whip-configured task",
        description: "Task with a custom whip threshold.",
        workflowName: "Whip Flow",
        whipMaxAttempts: 3,
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Whip Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Whip-configured task'));
      expect(createdTask).toBeTruthy();
      const loadedTask = await invokeCommand<{ id: string; whipMaxAttempts?: number }>(sessionId, 'get_task', { taskId: createdTask!.id });
      expect(loadedTask.whipMaxAttempts).toBe(3);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("automatically whips a mocked idle assigned session without requiring manual intervention", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const scenario = await invokeCommand<{
        projectId: string;
        projectName: string;
        roleId: string;
        taskId: string;
        sessionId: string;
      }>(sessionId, "debug_seed_idle_task_whip_scenario");
      expect(scenario.taskId).toBeTruthy();
      expect(scenario.sessionId).toBeTruthy();
      await executeScript(sessionId, `
        window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
        return true;
      `);

      await switchProject(sessionId, scenario.projectName);
      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Seeded automatic whip task");
      await clickByText(sessionId, '[data-role="task-card"]', "Seeded automatic whip task");
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, 'Whips: 0 / 10');

      const seededSession = await invokeCommand<any>(sessionId, "get_session_record", { sessionId: scenario.sessionId });
      expect(seededSession.status).toBe("idle");
      const roleOpsBeforeWhip = await invokeCommand<any>(sessionId, "get_role_operations", { roleId: scenario.roleId });
      expect(roleOpsBeforeWhip.activeInstanceCount).toBe(1);
      expect(roleOpsBeforeWhip.assignedCount).toBe(1);

      await invokeCommand(sessionId, "run_dispatcher_tick");

      const whippedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: scenario.taskId }),
        (task) => (task.activeLaneAssignment?.whipCount ?? 0) >= 1,
        30_000,
      );
      expect(whippedTask.activeLaneAssignment?.whipCount).toBe(1);
      await waitForCondition(
        () => executeScript<string>(sessionId, `return document.body ? document.body.innerText : '';`),
        (text) => text.toLowerCase().includes("whips: 1 / 10"),
        30_000,
      );

      const roleOpsAfterWhip = await invokeCommand<any>(sessionId, "get_role_operations", { roleId: scenario.roleId });
      expect(roleOpsAfterWhip.assignedCount).toBe(1);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
