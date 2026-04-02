import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  getCurrentWindowHandle,
  invokeCommand,
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
      let terminalWindowState = {
        hasTerminalSurface: false,
        hasProjectSwitcher: true,
        hasError: false,
        ready: false,
        terminalSessionId: "",
        bufferLength: 0,
        href: "",
        title: "",
        windowKind: "",
        bodyText: "",
        shellPadding: "",
        shellMargin: "",
        surfaceBorderRadius: "",
        fillsViewport: false,
      };
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        terminalWindowState = await executeScript<{
          hasTerminalSurface: boolean;
          hasProjectSwitcher: boolean;
          hasError: boolean;
          ready: boolean;
          terminalSessionId: string;
          bufferLength: number;
          href: string;
          title: string;
          windowKind: string;
          bodyText: string;
          shellPadding: string;
          shellMargin: string;
          surfaceBorderRadius: string;
          fillsViewport: boolean;
        }>(sessionId, `
          const shell = document.querySelector('[data-role="agent-terminal-window"]');
          const surface = document.querySelector('[data-role="agent-terminal-surface"]');
          const shellStyle = shell ? window.getComputedStyle(shell) : null;
          const surfaceRect = surface?.getBoundingClientRect();
          const shellRect = shell?.getBoundingClientRect();
          return {
            hasTerminalSurface: Boolean(surface),
            hasProjectSwitcher: Boolean(document.querySelector('[data-role="project-switcher"]')),
            hasError: Boolean(document.querySelector('[data-role="agent-terminal-error"]')),
            ready: shell?.getAttribute('data-terminal-ready') === 'true',
            terminalSessionId: shell?.getAttribute('data-session-id') || window.__ORCHESTRA_AGENT_TERMINAL_SESSION_ID__ || '',
            bufferLength: 0,
            href: window.location.href,
            title: document.title,
            windowKind: String(window.__ORCHESTRA_WINDOW_KIND__ || ''),
            bodyText: (document.body?.innerText || '').slice(0, 300),
            shellPadding: shellStyle?.padding || '',
            shellMargin: shellStyle?.margin || '',
            surfaceBorderRadius: surface ? window.getComputedStyle(surface).borderRadius : '',
            fillsViewport: Boolean(surfaceRect && shellRect
              && Math.abs(shellRect.width - window.innerWidth) < 2
              && Math.abs(shellRect.height - window.innerHeight) < 2
              && Math.abs(surfaceRect.width - window.innerWidth) < 2
              && Math.abs(surfaceRect.height - window.innerHeight) < 2),
          };
        `);
        if (terminalWindowState.terminalSessionId) {
          try {
            const buffer = await invokeCommand<string>(sessionId, 'get_agent_terminal_buffer', {
              sessionId: terminalWindowState.terminalSessionId,
            });
            terminalWindowState.bufferLength = typeof buffer === 'string' ? buffer.length : 0;
          } catch {
            terminalWindowState.bufferLength = 0;
          }
        }
        if (
          terminalWindowState.hasTerminalSurface
          && !terminalWindowState.hasProjectSwitcher
          && !terminalWindowState.hasError
          && terminalWindowState.ready
          && terminalWindowState.bufferLength > 0
          && terminalWindowState.fillsViewport
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
      expect(terminalWindowState.hasTerminalSurface).toBe(true);
      expect(terminalWindowState.hasProjectSwitcher).toBe(false);
      expect(terminalWindowState.hasError).toBe(false);
      expect(terminalWindowState.ready).toBe(true);
      expect(terminalWindowState.bufferLength).toBeGreaterThan(0);
      expect(terminalWindowState.shellPadding).toBe('0px');
      expect(terminalWindowState.shellMargin).toBe('0px');
      expect(terminalWindowState.surfaceBorderRadius).toBe('0px');
      expect(terminalWindowState.fillsViewport).toBe(true);

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
