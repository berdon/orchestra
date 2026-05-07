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
  it.skipIf(!isDesktopE2E)("shows the hosted Orchestra browser endpoint and generates pairing codes from the desktop host", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', "Remote");
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
      await waitForSelector(sessionId, '[data-role="remote-endpoint-browser-app"]');
      await waitForText(sessionId, "Hosted Orchestra web app URL");

      const endpoints = await executeScript<{ browserUrl: string; localApiUrl: string }>(sessionId, `
        const browserElement = document.querySelector('[data-role="remote-endpoint-browser-app"] code');
        const localApiElement = document.querySelector('[data-role="remote-endpoint-local-api"] code');
        return {
          browserUrl: browserElement ? (browserElement.textContent || '').trim() : '',
          localApiUrl: localApiElement ? (localApiElement.textContent || '').trim() : '',
        };
      `);
      expect(endpoints.browserUrl).toMatch(/^http:\/\/.+:[0-9]+$/);
      expect(endpoints.localApiUrl).toContain("http://127.0.0.1:");
      expect(new URL(endpoints.browserUrl).port).toBe(new URL(endpoints.localApiUrl).port);

      await clickSelector(sessionId, '[data-role="remote-detail-tab-pairing"]');
      await waitForSelector(sessionId, '[data-role="create-remote-pairing-code"]');
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
