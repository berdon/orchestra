import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  sleep,
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

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const clicked = await executeScript<boolean>(sessionId, `
          const row = Array.from(document.querySelectorAll('[data-role="task-table-row"]')).find((entry) =>
            (entry.textContent || '').includes(arguments[0]),
          );
          if (!(row instanceof HTMLElement)) {
            return false;
          }
          row.click();
          return true;
        `, ['Clickable workflow row']);
        if (clicked) {
          break;
        }
        await sleep(250);
      }
      await waitForText(sessionId, "Task detail");
      await waitForText(sessionId, 'Clickable workflow row');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
