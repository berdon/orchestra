import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForText,
} from "./driver";
import {
  createProjectViaSettings,
  createRoleViaSettings,
  dispatchRoleQueueViaUi,
  enqueueRoleWorkViaUi,
  openRoleOperations,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop workforce work filters", () => {
  it.skipIf(!isDesktopE2E)("shows queued, active, and completed work chips on role details and hides completed by default", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Work Filter Project", "Role work filter coverage.");
      await switchProject(sessionId, "Work Filter Project");
      await createRoleViaSettings(sessionId, {
        name: "Work Filter Role",
        capacity: "1",
        description: "Role for filter chip testing.",
      });

      await openRoleOperations(sessionId, "Work Filter Role");
      await enqueueRoleWorkViaUi(sessionId, {
        title: "Completed work item",
        summary: "Should appear in completed filter.",
        entryPrompt: "completed",
      });
      await enqueueRoleWorkViaUi(sessionId, {
        title: "Active work item",
        summary: "Should appear in active filter.",
        entryPrompt: "active",
      });
      await enqueueRoleWorkViaUi(sessionId, {
        title: "Queued work item",
        summary: "Should appear in queued filter.",
        entryPrompt: "queued",
      });

      await dispatchRoleQueueViaUi(sessionId);
      await waitForText(sessionId, 'Mark success');
      await clickByText(sessionId, 'button', 'Mark success');

      await waitForText(sessionId, "Queued");
      await waitForText(sessionId, "Active");
      await waitForText(sessionId, "Completed");

      await waitForText(sessionId, "Active work item");
      const defaultHidesCompleted = await executeScript<boolean>(sessionId, `
        return !(document.body ? document.body.innerText : '').includes('Completed work item');
      `);
      expect(defaultHidesCompleted).toBe(true);

      await clickByText(sessionId, 'button', 'Queued');
      await waitForText(sessionId, 'Queued work item');

      await clickByText(sessionId, 'button', 'Completed');
      await waitForText(sessionId, 'Completed work item');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
