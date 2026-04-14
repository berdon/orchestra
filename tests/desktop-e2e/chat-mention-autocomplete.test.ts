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
  waitForText,
} from "./driver";
import { createRoleViaSettings } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop chat reference autocomplete", () => {
  it.skipIf(!isDesktopE2E)("autocompletes tasks and agents in chat and opens task links from the transcript", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await createRoleViaSettings(sessionId, {
        name: "Reviewer",
        capacity: "1",
        description: "Role used to verify chat mention autocomplete.",
      });

      await clickByText(sessionId, "button", "Tasks");
      await clickByText(sessionId, "button", "New task");
      await setInputValue(sessionId, '[data-role="task-title"]', 'Chat mention target');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Chat mention target');

      await clickByText(sessionId, "button", "Chat");
      await waitForSelector(sessionId, '[data-role="composer-input"]');

      await setInputValue(sessionId, '[data-role="composer-input"]', 'Coordinate with @sup');
      await waitForSelector(sessionId, '[data-role="composer-mention-list"]');
      const agentMenu = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="composer-mention-list"]')?.textContent || '';
      `);
      expect(agentMenu).toContain('Supervisor');
      expect(agentMenu).toContain('Agent · supervisor');

      await setInputValue(sessionId, '[data-role="composer-input"]', 'Please inspect @target');
      await waitForSelector(sessionId, '[data-role="composer-mention-list"]');
      await waitForText(sessionId, 'Chat mention target');
      await executeScript(sessionId, `
        const option = Array.from(document.querySelectorAll('[data-role="composer-mention-option"]')).find((entry) =>
          (entry.textContent || '').includes('Chat mention target'),
        );
        if (!(option instanceof HTMLElement)) return false;
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        option.click();
        return true;
      `);

      const composerValue = await executeScript<string>(sessionId, `
        const textarea = document.querySelector('[data-role="composer-input"]');
        return textarea instanceof HTMLTextAreaElement ? textarea.value : '';
      `);
      expect(composerValue).toMatch(/@ORC-\d+/);

      await clickSelector(sessionId, '[data-role="send-message"]');
      await waitForText(sessionId, 'Chat mention target');

      const hasTranscriptTaskLink = await executeScript<boolean>(sessionId, `
        return Array.from(document.querySelectorAll('[data-role="transcript-mention-link"]')).some((entry) =>
          (entry.textContent || '').includes('Chat mention target'),
        );
      `);
      expect(hasTranscriptTaskLink).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
