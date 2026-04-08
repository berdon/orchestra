import { describe, expect, it } from "vitest";

import {
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop session transcript rendering", () => {
  it.skipIf(!isDesktopE2E)("folds and copies transcript entries in the desktop app", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await clickSelector(sessionId, '[data-role="create-session"]');
      await waitForSelector(sessionId, '[data-role="transcript-entry-toggle"]');

      await executeScript(sessionId, `
        const clipboardState = { text: "" };
        Object.defineProperty(window, '__orchestraClipboard', {
          value: clipboardState,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value) => {
              clipboardState.text = value;
            },
          },
        });
      `);

      const entryInfo = await executeScript<{ eventId: string; preview: string }>(sessionId, `
        const eventCard = document.querySelector('[data-role="transcript-event"]');
        const preview = eventCard?.querySelector('[data-role="transcript-entry-preview"]');
        return {
          eventId: eventCard instanceof HTMLElement ? eventCard.dataset.eventId ?? '' : '',
          preview: preview?.textContent || '',
        };
      `);
      expect(entryInfo.eventId).toBeTruthy();
      expect(entryInfo.preview).toContain('Real pi session ready');

      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="transcript-entry-toggle"][data-event-id="${entryInfo.eventId}"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error('toggle button not found');
        }
        button.click();
      `);
      const expandedText = await executeScript<string>(sessionId, `
        const eventCard = document.querySelector('[data-role="transcript-event"][data-event-id="${entryInfo.eventId}"]');
        return eventCard?.textContent || '';
      `);
      expect(expandedText).toContain('Real pi session ready');

      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="transcript-entry-copy"][data-event-id="${entryInfo.eventId}"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error('copy button not found');
        }
        button.click();
      `);
      const copiedText = await executeScript<string>(sessionId, `
        return window.__orchestraClipboard?.text || '';
      `);
      expect(copiedText).toContain('Real pi session ready');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
