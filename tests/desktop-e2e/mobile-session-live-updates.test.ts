import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setWindowRect,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const MOBILE_WIDTH = 390;
const MOBILE_HEIGHT = 844;

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
  intervalMs = 250,
  label = "condition",
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(intervalMs);
  }

  throw new Error(`${label} not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

async function navigateMobilePrimary(webdriverSessionId: string, label: "Chat" | "Sessions" | "Tasks") {
  await clickSelector(webdriverSessionId, '[data-role="toggle-mobile-navigation"]');
  await waitForSelector(webdriverSessionId, '[data-role="mobile-navigation-sheet"]');
  await clickByText(webdriverSessionId, "button", label);
  await waitForCondition(
    () => executeScript<boolean>(webdriverSessionId, `return Boolean(document.querySelector('[data-role="mobile-navigation-sheet"]'));`),
    (isOpen) => isOpen === false,
    10_000,
    250,
    `mobile navigation to close after selecting ${label}`,
  );
}

async function getViewedSessionId(webdriverSessionId: string) {
  const value = await executeScript<string>(
    webdriverSessionId,
    `return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';`,
  );
  return value || "";
}

async function setFrontendSessionSubscribed(
  webdriverSessionId: string,
  sessionId: string,
  subscribed: boolean,
) {
  await executeScript(
    webdriverSessionId,
    `
      if (typeof window.__orchestraTestSetSessionSubscribed !== 'function') {
        throw new Error('Missing session subscription test hook');
      }
      window.__orchestraTestSetSessionSubscribed(arguments[0], arguments[1]);
      return true;
    `,
    [sessionId, subscribed],
  );
}

async function sendBackendMessage(
  webdriverSessionId: string,
  sessionId: string,
  message: string,
) {
  await invokeCommand(webdriverSessionId, "send_session_message", {
    sessionId,
    runId: `mobile-live-updates-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    message,
  });
}

describe("desktop mobile live update recovery", () => {
  it.skipIf(!isDesktopE2E)(
    "re-subscribes chat on mobile reopen even when the cached session summary still claims it is subscribed",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await setWindowRect(webdriverSessionId, {
          width: MOBILE_WIDTH,
          height: MOBILE_HEIGHT,
        });
        await waitForCondition(
          () => executeScript<number>(webdriverSessionId, "return window.innerWidth;"),
          (width) => width <= 900,
          15_000,
          250,
          "mobile viewport width",
        );

        await navigateMobilePrimary(webdriverSessionId, "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-mobile-agent-picker-trigger"]');

        const sessionId = await waitForCondition(
          () => getViewedSessionId(webdriverSessionId),
          (value) => Boolean(value),
          30_000,
          250,
          "chat session to become visible",
        );

        const initialToken = `MOBILE-CHAT-OPEN-${Date.now()}`;
        await sendBackendMessage(webdriverSessionId, sessionId, initialToken);
        await waitForText(webdriverSessionId, initialToken, 15_000);

        await navigateMobilePrimary(webdriverSessionId, "Tasks");
        await invokeCommand<{ subscribed: boolean }>(
          webdriverSessionId,
          "unsubscribe_session",
          { sessionId },
        );
        await setFrontendSessionSubscribed(webdriverSessionId, sessionId, true);

        await navigateMobilePrimary(webdriverSessionId, "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-mobile-agent-picker-trigger"]');
        await waitForCondition(
          () => getViewedSessionId(webdriverSessionId),
          (value) => value === sessionId,
          30_000,
          250,
          "chat to reopen the same session",
        );
        await sleep(1_000);

        const reopenToken = `MOBILE-CHAT-REOPEN-${Date.now()}`;
        await sendBackendMessage(webdriverSessionId, sessionId, reopenToken);
        await waitForText(webdriverSessionId, reopenToken, 15_000);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    180_000,
  );

  it.skipIf(!isDesktopE2E)(
    "re-subscribes the Sessions detail view on mobile reopen even when the cached session summary is stale",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);
        await setWindowRect(webdriverSessionId, {
          width: MOBILE_WIDTH,
          height: MOBILE_HEIGHT,
        });
        await waitForCondition(
          () => executeScript<number>(webdriverSessionId, "return window.innerWidth;"),
          (width) => width <= 900,
          15_000,
          250,
          "mobile viewport width",
        );

        await navigateMobilePrimary(webdriverSessionId, "Sessions");
        await waitForSelector(webdriverSessionId, '[data-role="sessions-mobile-picker-trigger"]');

        const sessionId = await waitForCondition(
          () => getViewedSessionId(webdriverSessionId),
          (value) => Boolean(value),
          30_000,
          250,
          "sessions detail session to become visible",
        );

        const initialToken = `MOBILE-SESSIONS-OPEN-${Date.now()}`;
        await sendBackendMessage(webdriverSessionId, sessionId, initialToken);
        await waitForText(webdriverSessionId, initialToken, 15_000);

        await navigateMobilePrimary(webdriverSessionId, "Tasks");
        await invokeCommand<{ subscribed: boolean }>(
          webdriverSessionId,
          "unsubscribe_session",
          { sessionId },
        );
        await setFrontendSessionSubscribed(webdriverSessionId, sessionId, true);

        await navigateMobilePrimary(webdriverSessionId, "Sessions");
        await waitForCondition(
          () => getViewedSessionId(webdriverSessionId),
          (value) => value === sessionId,
          30_000,
          250,
          "sessions detail to reopen the same session",
        );
        await sleep(1_000);

        const reopenToken = `MOBILE-SESSIONS-REOPEN-${Date.now()}`;
        await sendBackendMessage(webdriverSessionId, sessionId, reopenToken);
        await waitForText(webdriverSessionId, reopenToken, 15_000);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    180_000,
  );
});
