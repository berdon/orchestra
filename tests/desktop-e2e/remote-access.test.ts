import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop remote access", () => {
  it.skipIf(!isDesktopE2E)("enables remote access and creates a pairing code", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "Remote");
      await waitForText(sessionId, "Remote API host");
      await waitForSelector(sessionId, '[data-role="remote-enabled"]');
      await waitForSelector(sessionId, '[data-role="save-remote-settings"]');

      const isEnabled = await executeScript<boolean>(sessionId, `
        const checkbox = document.querySelector('[data-role="remote-enabled"]');
        return checkbox instanceof HTMLInputElement ? checkbox.checked : false;
      `);
      if (!isEnabled) {
        await clickSelector(sessionId, '[data-role="remote-enabled"]');
      }
      await clickSelector(sessionId, '[data-role="save-remote-settings"]');
      await waitForText(sessionId, "Local URL:");

      const localUrl = await executeScript<string>(sessionId, `
        const hostSection = document.body.textContent || '';
        return hostSection;
      `);
      expect(localUrl).toContain("http://127.0.0.1:");

      await clickSelector(sessionId, '[data-role="create-remote-pairing-code"]');
      await waitForSelector(sessionId, '[data-role="latest-remote-pairing-code"]');
      const latestCode = await executeScript<string>(sessionId, `
        const element = document.querySelector('[data-role="latest-remote-pairing-code"]');
        return element ? element.textContent || '' : '';
      `);
      expect(latestCode).toContain("Latest code:");
      expect(latestCode).toMatch(/[A-Z0-9]{4}-[A-Z0-9]{4}/);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
