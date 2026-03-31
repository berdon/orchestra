import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  sleep,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(500);
  }

  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

describe("desktop agent terminal handoff", () => {
  it.skipIf(!isDesktopE2E)("opens an idle agent in terminal mode from the agents page and command palette", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await invokeCommand<{ id: string }>(sessionId, "create_agent", {
        input: {
          name: "Terminal Agent",
          description: "Agent used to verify terminal handoff.",
          provider: null,
          model: null,
          thinkingLevel: "off",
        },
      });

      await executeScript(sessionId, `
        window.dispatchEvent(new KeyboardEvent('keydown', { key: 'o', ctrlKey: true, bubbles: true }));
        return true;
      `);
      await sleep(500);
      await setInputValue(sessionId, '[data-role="command-palette-input"]', 'terminal agent');
      await clickByText(sessionId, '[data-role="command-palette-item"]', 'Open Terminal Agent in terminal');

      await waitForText(sessionId, "Terminal Agent main session");
      const launchedSession = await waitForCondition(
        () => invokeCommand<Array<{ id: string; title: string; terminalAttached?: boolean }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === "Terminal Agent main session"),
      );
      const sessionRecord = launchedSession.find((entry) => entry.title === "Terminal Agent main session");
      expect(sessionRecord).toBeTruthy();
      const agentSessionId = sessionRecord?.id ?? "";

      const attachedUi = await waitForCondition(
        () => executeScript<{ sendDisabled: boolean; text: string }>(sessionId, `
          const sendButton = document.querySelector('[data-role="send-message"]');
          return {
            sendDisabled: sendButton instanceof HTMLButtonElement ? sendButton.disabled : false,
            text: document.body?.innerText ?? ''
          };
        `),
        (state) => state.sendDisabled && state.text.toLowerCase().includes('currently attached to a terminal window'),
        10_000,
      );
      expect(attachedUi.sendDisabled).toBe(true);

      const attachedRecord = await invokeCommand<any>(sessionId, "get_session_record", { sessionId: agentSessionId });
      expect(attachedRecord.terminalAttached).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
