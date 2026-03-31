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
  it.skipIf(!isDesktopE2E)("opens a second Orchestra window that renders the embedded terminal instead of the Orchestra shell", async () => {
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
      let terminalWindowState = { hasTerminalSurface: false, hasProjectSwitcher: true, href: "", title: "", windowKind: "", bodyText: "" };
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        terminalWindowState = await executeScript<{ hasTerminalSurface: boolean; hasProjectSwitcher: boolean; href: string; title: string; windowKind: string; bodyText: string }>(sessionId, `
          return {
            hasTerminalSurface: Boolean(document.querySelector('[data-role="agent-terminal-surface"]')),
            hasProjectSwitcher: Boolean(document.querySelector('[data-role="project-switcher"]')),
            href: window.location.href,
            title: document.title,
            windowKind: String(window.__ORCHESTRA_WINDOW_KIND__ || ''),
            bodyText: (document.body?.innerText || '').slice(0, 300),
          };
        `);
        if (terminalWindowState.hasTerminalSurface && !terminalWindowState.hasProjectSwitcher) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(terminalWindowState.hasTerminalSurface).toBe(true);
      expect(terminalWindowState.hasProjectSwitcher).toBe(false);

      await executeScript(sessionId, `
        window.close();
        return true;
      `);
      await waitForWindowCount(sessionId, 1, 45_000);
      await switchToWindow(sessionId, mainHandle);
      await ensureReactReady(sessionId);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
