import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  sleep,
  waitForSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop command palette", () => {
  it.skipIf(!isDesktopE2E)("stays usable when one runtime source hangs", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await executeScript(
        sessionId,
        `
          window.__orchestraTestCommandPalette = {
            hangSources: ["roles"],
            sourceTimeoutMs: 50,
          };
          window.dispatchEvent(new KeyboardEvent("keydown", { key: "o", ctrlKey: true, bubbles: true }));
          return true;
        `,
      );

      await waitForSelector(sessionId, '[data-role="command-palette-overlay"]');
      await waitForSelector(sessionId, '[data-role="command-palette-item"][data-command-id="action-create-task"]');

      const deadline = Date.now() + 10_000;
      let loadingVisible = true;
      while (Date.now() < deadline) {
        loadingVisible = await executeScript<boolean>(
          sessionId,
          `
            return Array.from(document.querySelectorAll('.muted-copy')).some((node) =>
              (node.textContent || '').includes('Loading commands…')
            );
          `,
        );
        if (!loadingVisible) {
          break;
        }
        await sleep(50);
      }
      expect(loadingVisible).toBe(false);

      await setInputValue(sessionId, '[data-role="command-palette-input"]', 'create task');
      const submitted = await executeScript<boolean>(
        sessionId,
        `
          const input = document.querySelector(arguments[0]);
          if (!(input instanceof HTMLInputElement)) {
            return false;
          }
          input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
          return true;
        `,
        ['[data-role="command-palette-input"]'],
      );
      expect(submitted).toBe(true);

      await waitForSelector(sessionId, '[data-role="task-title"]');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
