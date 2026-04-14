import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  waitForSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop session prompt template settings", () => {
  it.skipIf(!isDesktopE2E)("resets the session prompt template draft to the updated default copy", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', 'General');
      await waitForSelector(sessionId, '[data-role="session-prompt-template"]');

      await setInputValue(sessionId, '[data-role="session-prompt-template"]', 'Task {TASK.ID}');
      await clickSelector(sessionId, '[data-role="save-session-prompt-template"]');
      await clickSelector(sessionId, '[data-role="reset-session-prompt-template"]');

      const templateValue = await executeScript<string>(sessionId, `
        const textarea = document.querySelector('[data-role="session-prompt-template"]');
        return textarea instanceof HTMLTextAreaElement ? textarea.value : '';
      `);

      expect(templateValue).toContain('You are an agent working inside Orchestra on task {TASK.NUMBER} — {TASK.NAME}.');
      expect(templateValue).toContain('As you do work - periodically comment on tasks to give an update on what you’re doing.');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
