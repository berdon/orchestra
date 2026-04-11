import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectValue,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop bridge diagnostics", () => {
  it.skipIf(!isDesktopE2E)("shows bridge diagnostics in Settings → General", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const createdSession = await invokeCommand<{ id: string }>(sessionId, "create_session", {
        title: "Bridge diagnostics log filter probe",
      });
      expect(createdSession.id).toBeTruthy();
      await invokeCommand(sessionId, "send_session_message", {
        sessionId: createdSession.id,
        message: "Reply with a short greeting.",
        runId: `bridge-log-filter-${Date.now()}`,
      });

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "General");
      await waitForText(sessionId, "Session prompt");
      await waitForSelector(sessionId, '[data-role="session-prompt-template"]');
      await waitForSelector(sessionId, '[data-role="save-session-prompt-template"]');
      await waitForText(sessionId, "Bridge diagnostics");
      await waitForSelector(sessionId, '[data-role="bridge-instance-id"]');
      await waitForSelector(sessionId, '[data-role="refresh-bridge-diagnostics"]');
      await waitForSelector(sessionId, '[data-role="cleanup-stale-bridges"]');

      const bridgeMetadata = await executeScript<string>(sessionId, `
        const element = document.querySelector('[data-role="bridge-instance-metadata"]');
        return element ? element.textContent || '' : '';
      `);
      expect(bridgeMetadata).toContain('127.0.0.1');

      await clickByText(sessionId, "button", "Sessions");
      const beforeCount = await executeScript<number>(sessionId, `
        return document.querySelectorAll('.session-list button, .session-list a, [data-role="session-list-item"]').length;
      `);
      await clickByText(sessionId, "button", "Create session");
      await executeScript(
        sessionId,
        `window.dispatchEvent(new CustomEvent('orchestra:sessions-changed')); return true;`,
      );
      const deadline = Date.now() + 15_000;
      let afterCount = beforeCount;
      while (Date.now() < deadline) {
        afterCount = await executeScript<number>(sessionId, `
          return document.querySelectorAll('.session-list button, .session-list a, [data-role="session-list-item"]').length;
        `);
        if (afterCount > beforeCount) break;
      }
      expect(afterCount).toBeGreaterThanOrEqual(beforeCount);
      await waitForText(sessionId, 'Session');

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "General");
      await clickSelector(sessionId, '[data-role="cleanup-stale-bridges"]');
      await waitForText(sessionId, "Recent stale-bridge cleanup events");

      await waitForSelector(sessionId, '[data-role="runtime-log-level-filter"]');
      await waitForText(sessionId, 'sessions.message.start');
      const infoLogText = await executeScript<string>(sessionId, `
        const element = document.querySelector('[data-role="runtime-log-list"]');
        return element ? element.textContent || '' : '';
      `);
      expect(infoLogText).toContain('(sessions.message.start):');
      expect(infoLogText).not.toContain('(sessions.rpc.event):');

      await selectValue(sessionId, '[data-role="runtime-log-level-filter"]', 'debug');
      await waitForText(sessionId, 'sessions.rpc.event');
      const debugLogText = await executeScript<string>(sessionId, `
        const element = document.querySelector('[data-role="runtime-log-list"]');
        return element ? element.textContent || '' : '';
      `);
      expect(debugLogText).toContain('(sessions.rpc.event):');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
