import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
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
  it.skipIf(!isDesktopE2E)("shows loaded runtime extensions for an active session", async () => {
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
      await clickSelector(sessionId, '[data-role="open-session-runtime-details"]');
      await waitForSelector(sessionId, '[data-role="session-runtime-details-dialog"]');

      const dialogText = await executeScript<string>(
        sessionId,
        `return document.querySelector('[data-role="session-runtime-details-dialog"]')?.textContent || '';`,
      );

      expect(dialogText).toContain("Live runtime active");
      expect(dialogText).toContain("extensions/orchestra-tools.ts");
      expect(dialogText).toContain("npm:pi-example");
      expect(dialogText).toContain("./extensions/local-extra.ts");
      expect(dialogText).toContain("Disabled by --no-extensions");
      expect(dialogText).toContain("Managed skills state");
      expect(dialogText).toContain("Resolved");
      expect(dialogText).toContain("Context hash");
      expect(dialogText).toContain("Ambient skills");
      expect(dialogText).toContain("Resolved skills");
      expect(dialogText).toContain("Managed skills notes");

      await clickSelector(sessionId, '[data-role="close-session-runtime-details"]');
      const dialogVisible = await executeScript<boolean>(
        sessionId,
        `return Boolean(document.querySelector('[data-role="session-runtime-details-dialog"]'));`,
      );
      expect(dialogVisible).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
