import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop bridge diagnostics", () => {
  it.skipIf(!isDesktopE2E)("shows bridge diagnostics in Settings → General", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "General");
      await waitForText(sessionId, "Session prompt");
      await waitForSelector(sessionId, '[data-role="session-prompt-template"]');
      await waitForSelector(sessionId, '[data-role="save-session-prompt-template"]');
      await waitForText(sessionId, "Bridge diagnostics");
      await waitForSelector(sessionId, '[data-role="bridge-instance-id"]');
      await waitForSelector(sessionId, '[data-role="refresh-bridge-diagnostics"]');
      await waitForSelector(sessionId, '[data-role="cleanup-stale-bridges"]');

      const diagnostics = await invokeCommand<any>(sessionId, "get_bridge_diagnostics");
      expect(diagnostics?.instance?.instanceId).toBeTruthy();
      expect(String(diagnostics?.instance?.url ?? "")).toContain("127.0.0.1");

      await invokeCommand(sessionId, "cleanup_stale_bridge_instances");
      await waitForText(sessionId, "Recent stale-bridge cleanup events");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
