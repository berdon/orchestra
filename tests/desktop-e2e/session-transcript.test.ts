import { describe, expect, it } from "vitest";

import {
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop session transcript rendering", () => {
  it.skipIf(!isDesktopE2E)("folds system entries, expands them, and copies their content", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await clickSelector(sessionId, '[data-role="create-session"]');
      await waitForSelector(sessionId, '[data-role="session-link"]');

      const selectedSessionId = await executeScript<string | null>(sessionId, `
        const link = document.querySelector('[data-role="session-link"].session-list-link--active');
        return link instanceof HTMLElement ? link.dataset.sessionId ?? null : null;
      `);
      expect(selectedSessionId).toBeTruthy();

      await executeScript(sessionId, `
        const clipboardState = { text: "" };
        Object.defineProperty(window, '__orchestraClipboard', {
          value: clipboardState,
          configurable: true,
          writable: true,
        });
        Object.defineProperty(navigator, 'clipboard', {
          configurable: true,
          value: {
            writeText: async (value) => {
              clipboardState.text = value;
            },
          },
        });

        const receivedAt = new Date().toISOString();
        window.dispatchEvent(new CustomEvent('orchestra:session-stream', {
          detail: {
            sessionId: arguments[0],
            runId: 'desktop-run-tools',
            receivedAt,
            event: {
              type: 'tool_execution_end',
              toolCallId: 'desktop-call-1',
              toolName: 'write_file',
              args: { path: 'src/desktop.ts', content: 'const answer = 42;' },
              result: {
                content: [
                  {
                    type: 'text',
                    text: '- wrote src/desktop.ts\\n- applied formatting\\n- final line visible',
                  },
                ],
              },
              isError: false,
              durationMs: 12,
            },
          },
        }));
      `, [selectedSessionId]);

      await waitForSelector(sessionId, '[data-role="transcript-event"][data-event-id="tool-execution-desktop-call-1"]');

      const collapsedState = await executeScript<{ collapsed: string | null; preview: string }>(sessionId, `
        const eventCard = document.querySelector('[data-role="transcript-event"][data-event-id="tool-execution-desktop-call-1"]');
        const preview = eventCard?.querySelector('[data-role="transcript-entry-preview"]');
        return {
          collapsed: eventCard instanceof HTMLElement ? eventCard.dataset.eventCollapsed ?? null : null,
          preview: preview?.textContent || '',
        };
      `);
      expect(collapsedState.collapsed).toBe('true');
      expect(collapsedState.preview).toContain('final line visible');
      expect(collapsedState.preview).toContain('…');

      await clickSelector(sessionId, '[data-role="transcript-entry-toggle"][data-event-id="tool-execution-desktop-call-1"]');

      const expandedState = await executeScript<{ collapsed: string | null; text: string; codeLabel: string }>(sessionId, `
        const eventCard = document.querySelector('[data-role="transcript-event"][data-event-id="tool-execution-desktop-call-1"]');
        const rendered = eventCard?.querySelector('[data-role="transcript-entry-rendered-markdown"]');
        const codeLabel = eventCard?.querySelector('.transcript-code-block figcaption');
        return {
          collapsed: eventCard instanceof HTMLElement ? eventCard.dataset.eventCollapsed ?? null : null,
          text: rendered?.textContent || eventCard?.textContent || '',
          codeLabel: codeLabel?.textContent || '',
        };
      `);
      expect(expandedState.collapsed).toBe('false');
      expect(expandedState.text).toContain('Tool result');
      expect(expandedState.text).toContain('src/desktop.ts');
      expect(expandedState.codeLabel).toBeTruthy();

      await clickSelector(sessionId, '[data-role="transcript-entry-copy"][data-event-id="tool-execution-desktop-call-1"]');
      const copiedText = await executeScript<string>(sessionId, `
        return window.__orchestraClipboard?.text || '';
      `);
      expect(copiedText).toContain('src/desktop.ts');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
