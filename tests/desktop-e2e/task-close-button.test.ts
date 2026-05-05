import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task close button", () => {
  it.skipIf(!isDesktopE2E)("closes a task without deleting it", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const workflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Close Task Flow",
          description: "User-owned lane for close coverage.",
          lanes: [
            {
              id: "lane-user-close",
              key: "user-close",
              name: "User close",
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: null,
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const task = await invokeCommand<any>(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Close me desktop",
          description: "Close button desktop coverage.",
          type: "task",
          status: "in_review",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: "lane-user-close",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
        },
      });

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Close me desktop");
      await clickByText(sessionId, '[data-role="task-card"]', 'Close me desktop');
      await waitForSelector(sessionId, '[data-role="close-task"]');
      await clickSelector(sessionId, '[data-role="close-task"]');
      await waitForSelector(sessionId, '[data-role="task-close-confirm"]');
      await executeScript(sessionId, `
        const input = document.querySelector('[data-role="task-close-reason"]');
        if (!(input instanceof HTMLTextAreaElement)) {
          throw new Error('Close reason field was not found');
        }
        input.value = 'No longer needed';
        input.dispatchEvent(new Event('input', { bubbles: true }));
        input.dispatchEvent(new Event('change', { bubbles: true }));
      `);
      await clickSelector(sessionId, '[data-role="confirm-close-task"]');

      const updatedTask = await invokeCommand<any>(sessionId, "get_task", { taskId: task.id });
      expect(updatedTask.status).toBe("canceled");

      await clickByText(sessionId, "button", "Tasks");
      await clickSelector(sessionId, '[data-role="task-filter-done"]');
      await clickSelector(sessionId, '[data-role="task-view-table"]');
      await waitForText(sessionId, "Close me desktop");
      const tableText = await executeScript<string>(sessionId, `
        const table = document.querySelector('[data-role="task-table"]');
        return table ? table.textContent || '' : '';
      `);
      expect(tableText).toContain("Close me desktop");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
