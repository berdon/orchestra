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

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task whip configuration", () => {
  it.skipIf(!isDesktopE2E)("shows the default whip max attempts and accepts custom values through task creation", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const agent = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_agent", {
        input: {
          name: "Whip Agent",
          description: "Agent used to test task whip configuration.",
          systemPrompt: "Keep working until the task is complete and use the completion tools when you are done.",
          provider: null,
          model: null,
          roleId: null,
          thinkingLevel: "medium",
          policyIds: [],
          directPermissions: [],
        },
      });

      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Whip Flow",
          description: null,
          lanes: [
            {
              id: "lane-whip",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: agent.slug,
              entryPromptTemplate: "Keep going until done.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      await clickByText(sessionId, "button", "Tasks");
      await clickSelector(sessionId, '[data-role="new-task"]');
      const defaultWhipValue = await executeScript<string>(sessionId, `
        const field = document.querySelector('[data-role="task-whip-max-attempts"]');
        return field instanceof HTMLInputElement ? field.value : '';
      `);
      expect(defaultWhipValue).toBe('10');

      const createdTask = await invokeCommand<{ id: string; whipMaxAttempts?: number }>(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Whip-configured task",
          description: "Task with a custom whip threshold.",
          type: "task",
          status: "draft",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: "lane-whip",
          assigneeType: "agent",
          assigneeId: agent.slug,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          whipMaxAttempts: 3,
          archived: false,
        },
      });

      expect(createdTask.whipMaxAttempts).toBe(3);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
