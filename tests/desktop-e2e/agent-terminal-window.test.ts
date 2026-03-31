import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  getCurrentWindowHandle,
  switchToWindow,
  waitForText,
  waitForWindowCount,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop embedded agent terminal window", () => {
  it.skipIf(!isDesktopE2E)("opens a second Orchestra window for the embedded terminal and leaves the main session readonly while attached", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      const mainHandle = await getCurrentWindowHandle(sessionId);

      await clickByText(sessionId, "button", "Agents");
      await waitForText(sessionId, "Persistent collaborators");
      await waitForText(sessionId, "Supervisor");
      await clickByText(sessionId, "a", "Supervisor");
      await clickSelector(sessionId, '[data-role="open-agent-session-terminal"]');

      await waitForText(sessionId, "Supervisor main session");
      await waitForText(sessionId, "attached to an embedded terminal window");

      const handles = await waitForWindowCount(sessionId, 2, 45_000);
      const terminalHandle = handles.find((handle) => handle !== mainHandle);
      expect(terminalHandle).toBeTruthy();

      await switchToWindow(sessionId, terminalHandle!);
      await executeScript(sessionId, `
        window.close();
        return true;
      `);
      await waitForWindowCount(sessionId, 1, 45_000);
      await switchToWindow(sessionId, mainHandle);
      await ensureReactReady(sessionId);
      const stillReadonly = await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="session-terminal-readonly"]'));
      `);
      expect(stillReadonly).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
