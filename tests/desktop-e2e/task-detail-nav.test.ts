import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task detail navigation", () => {
  it.skipIf(!isDesktopE2E)("shows the task overview description and returns to the task list from the Tasks nav", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Tasks");
      await clickByText(sessionId, "button", "New task");
      await setInputValue(sessionId, '[data-role="task-title"]', 'Desktop task detail nav');
      await clickSelector(sessionId, '[data-role="save-task"]');

      await waitForText(sessionId, 'Desktop task detail nav');
      await waitForText(sessionId, 'Task description');
      await waitForText(sessionId, 'No description provided.');

      const backButtonVisible = await executeScript<boolean>(sessionId, `
        return Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Back to tasks');
      `);
      expect(backButtonVisible).toBe(false);

      await clickByText(sessionId, 'button', 'Tasks');
      await waitForText(sessionId, 'Desktop task detail nav');

      const detailHeadingVisible = await executeScript<boolean>(sessionId, `
        return Array.from(document.querySelectorAll('h2')).some((heading) => heading.textContent?.trim() === 'Desktop task detail nav');
      `);
      expect(detailHeadingVisible).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
