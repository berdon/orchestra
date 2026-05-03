import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop session runtime details", () => {
  it.skipIf(!isDesktopE2E)("does not expose a runtime details control from the session chat surface", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await invokeCommand(sessionId, "update_pi_runtime_settings", {
        extraExtensions: ["npm:pi-example", "./extensions/local-extra.ts"],
      });

      const createdSession = await invokeCommand<{ id: string; title: string }>(sessionId, "create_session", {
        title: "Runtime details desktop session",
        projectSlug: "orchestra",
      });
      await invokeCommand(sessionId, "subscribe_session", { sessionId: createdSession.id });

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Runtime details desktop session");
      await waitForSelector(sessionId, '[data-role="session-link"]');
      await clickByText(sessionId, '[data-role="session-link"]', "Runtime details desktop session");
      await waitForText(sessionId, "Runtime details desktop session");
      await waitForSelector(sessionId, '[data-role="selected-session-title"]');

      expect(await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="open-session-runtime-details"]'));
      `)).toBe(false);
      expect(await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="session-runtime-details-dialog"]'));
      `)).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
