import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForText,
} from "./driver";
import { createProjectViaSettings, createTaskViaTasks, createWorkflowViaSettings, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task table rows", () => {
  it.skipIf(!isDesktopE2E)("shows the lane column and allows clicking anywhere on a task table row to open details", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, 'Task Table Project', 'Task table row interaction test.');
      await switchProject(sessionId, 'Task Table Project');
      await createWorkflowViaSettings(sessionId, {
        name: 'Task Table Flow',
        description: 'Simple table flow.',
        lanes: [
          {
            name: 'Build',
            key: 'build',
            ownerType: 'agent',
            ownerReference: 'supervisor',
            entryPromptTemplate: 'Build it.',
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: 'Clickable workflow row',
        description: 'Verify whole table row opens detail.',
        workflowName: 'Task Table Flow',
        publish: true,
      });

      await clickByText(sessionId, "button", "Tasks");
      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="task-view-table"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error('Table view toggle was not available');
        }
        button.click();
        return true;
      `);
      await waitForText(sessionId, 'Clickable workflow row');
      await waitForText(sessionId, 'Supervisor');

      await executeScript(sessionId, `
        const row = document.querySelector('[data-role="task-table-row"]');
        if (!(row instanceof HTMLElement)) {
          throw new Error('Task table row was not available');
        }
        row.click();
        return true;
      `);
      await waitForText(sessionId, "Task detail");
      await waitForText(sessionId, 'Clickable workflow row');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
