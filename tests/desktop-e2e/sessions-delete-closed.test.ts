import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop sessions closed actions", () => {
  it.skipIf(!isDesktopE2E)("shows Delete closed pinned below the scrollable sessions list when Closed is selected", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await clickByText(sessionId, "button", "Sessions");
      await clickByText(sessionId, "button", "Closed");
      await waitForSelector(sessionId, '[data-role="delete-closed-sessions"]');

      const pinned = await executeScript<boolean>(sessionId, `
        const panel = document.querySelector('.session-list-panel');
        const scroll = document.querySelector('.session-list-scroll');
        const footerButton = document.querySelector('[data-role="delete-closed-sessions"]');
        if (!(panel instanceof HTMLElement) || !(scroll instanceof HTMLElement) || !(footerButton instanceof HTMLElement)) {
          return false;
        }
        return !scroll.contains(footerButton) && panel.contains(footerButton);
      `);
      expect(pinned).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
