import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
} from "./driver";
import { createAgentViaSettings, createTaskViaTasks, createWorkflowViaSettings } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task whip configuration", () => {
  it.skipIf(!isDesktopE2E)("shows the default whip max attempts and accepts custom values through task creation", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await createAgentViaSettings(sessionId, {
        name: "Whip Agent",
        description: "Agent used to test task whip configuration.",
        systemPrompt: "Keep working until the task is complete and use the completion tools when you are done.",
        thinkingLevel: "medium",
      });
      await createWorkflowViaSettings(sessionId, {
        name: "Whip Flow",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "agent",
            ownerReference: "whip-agent",
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

      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Whip-configured task'));
      expect(createdTask).toBeTruthy();
      const loadedTask = await invokeCommand<{ id: string; whipMaxAttempts?: number }>(sessionId, 'get_task', { taskId: createdTask!.id });
      expect(loadedTask.whipMaxAttempts).toBe(3);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
