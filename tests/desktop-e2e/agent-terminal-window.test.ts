import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  closeCurrentWindow,
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

      const runtimeDetail = await invokeCommand<{ runtimeState?: { mainSessionId?: string | null } }>(
        sessionId,
        "get_agent_operations",
        { agentId: "agent-supervisor" },
      );
      const attachedSessionId = runtimeDetail.runtimeState?.mainSessionId ?? "";
      expect(attachedSessionId).toBeTruthy();

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
        hasCanvas: false,
        visiblePixelCount: 0,
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
          hasCanvas: boolean;
          visiblePixelCount: number;
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
          const canvas = surface?.querySelector('canvas');
          let visiblePixelCount = 0;
          if (canvas instanceof HTMLCanvasElement) {
            const ctx = canvas.getContext('2d', { willReadFrequently: true });
            if (ctx) {
              const width = Math.min(canvas.width || 0, 320);
              const height = Math.min(canvas.height || 0, 160);
              if (width > 0 && height > 0) {
                const data = ctx.getImageData(0, 0, width, height).data;
                for (let i = 0; i < data.length; i += 4) {
                  const r = data[i];
                  const g = data[i + 1];
                  const b = data[i + 2];
                  const a = data[i + 3];
                  if (a > 0 && (Math.abs(r - 17) > 4 || Math.abs(g - 19) > 4 || Math.abs(b - 24) > 4)) {
                    visiblePixelCount += 1;
                  }
                }
              }
            }
          }
          return {
            hasTerminalSurface: Boolean(surface),
            hasProjectSwitcher: Boolean(document.querySelector('[data-role="project-switcher"]')),
            hasError: Boolean(document.querySelector('[data-role="agent-terminal-error"]')),
            ready: shell?.getAttribute('data-terminal-ready') === 'true',
            terminalSessionId: shell?.getAttribute('data-session-id') || window.__ORCHESTRA_AGENT_TERMINAL_SESSION_ID__ || '',
            bufferLength: 0,
            hasCanvas: canvas instanceof HTMLCanvasElement,
            visiblePixelCount,
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

        if (terminalWindowState.terminalSessionId || attachedSessionId) {
          const resolvedTerminalSessionId = terminalWindowState.terminalSessionId || attachedSessionId;
          try {
            await switchToWindow(sessionId, mainHandle);
            const buffer = await invokeCommand<string>(sessionId, "get_agent_terminal_buffer", {
              sessionId: resolvedTerminalSessionId,
            });
            await switchToWindow(sessionId, terminalHandle!);
            terminalWindowState.bufferLength = typeof buffer === "string" ? buffer.length : 0;
          } catch {
            await switchToWindow(sessionId, terminalHandle!).catch(() => undefined);
            terminalWindowState.bufferLength = 0;
          }
        }

        if (
          terminalWindowState.hasTerminalSurface &&
          !terminalWindowState.hasProjectSwitcher &&
          !terminalWindowState.hasError &&
          terminalWindowState.ready &&
          terminalWindowState.hasCanvas &&
          terminalWindowState.visiblePixelCount > 100 &&
          terminalWindowState.fillsViewport
        ) {
          break;
        }
        await new Promise((resolve) => setTimeout(resolve, 500));
      }

      expect(terminalWindowState.hasTerminalSurface).toBe(true);
      expect(terminalWindowState.hasProjectSwitcher).toBe(false);
      expect(terminalWindowState.hasError).toBe(false);
      expect(terminalWindowState.ready).toBe(true);
      expect(terminalWindowState.hasCanvas).toBe(true);
      expect(terminalWindowState.visiblePixelCount).toBeGreaterThan(100);
      expect(terminalWindowState.shellPadding).toBe("0px");
      expect(terminalWindowState.shellMargin).toBe("0px");
      expect(terminalWindowState.surfaceBorderRadius).toBe("0px");
      expect(terminalWindowState.fillsViewport).toBe(true);

      await closeCurrentWindow(sessionId);
      await waitForWindowCount(sessionId, 1, 45_000);
      await switchToWindow(sessionId, mainHandle);
      await ensureReactReady(sessionId);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
