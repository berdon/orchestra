import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
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
            ownerType: 'user',
            entryPromptTemplate: 'Build it.',
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: 'Clickable workflow row',
        description: 'Verify whole table row opens detail.',
        workflowName: 'Task Table Flow',
      });

      await clickByText(sessionId, "button", "Tasks");
      await clickByText(sessionId, "button", "Table");
      await waitForText(sessionId, "Lane");
      await waitForText(sessionId, 'Clickable workflow row');

      await clickSelector(sessionId, '[data-role="task-table-row"]');
      await waitForText(sessionId, "Task detail");
      await waitForText(sessionId, 'Clickable workflow row');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
