import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

type SessionRecordLike = {
  id: string;
  title?: string;
  status?: string;
};

async function getSelectedSessionId(webdriverSessionId: string): Promise<string> {
  const result = await executeScript<string>(
    webdriverSessionId,
    `return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';`,
  );
  return result || "";
}

async function getAgentMainSessionId(
  webdriverSessionId: string,
): Promise<string | null> {
  const operations = await invokeCommand<Array<{
    agent: { id: string; name: string; slug: string };
    runtimeState: {
      status: string;
      mainSessionId: string | null;
      runtimeCwd: string | null;
      currentQueueEntryId: string | null;
      lastDispatchAt: string | null;
      lastError: string | null;
      terminalAttached: boolean;
      createdAt: string;
      updatedAt: string;
    };
  }>>(webdriverSessionId, "list_agent_operations");
  const supervisor = operations.find(
    (op) => op.agent.slug === "supervisor",
  );
  return supervisor?.runtimeState.mainSessionId ?? null;
}

async function waitForCondition<T>(
  callback: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 60_000,
  intervalMs = 500,
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

describe("desktop chat session recovery", () => {
  it.skipIf(!isDesktopE2E)(
    "new session becomes the agent's main session after creation",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        // Open supervisor chat to ensure it has a session
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await clickSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await waitForText(webdriverSessionId, "Supervisor chat");

        const initialSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value.length > 0),
          45_000,
          500,
          "supervisor chat session to become selected",
        );

        // Verify the agent's main session ID points to the initial session
        const mainBefore = await getAgentMainSessionId(webdriverSessionId);
        expect(mainBefore).toBe(initialSessionId);

        // Click "New Session" to create a new session
        await clickSelector(webdriverSessionId, '[data-role="session-actions-trigger"]');
        await sleep(300);
        await waitForSelector(webdriverSessionId, '[data-role="session-action-new"]');
        await clickSelector(webdriverSessionId, '[data-role="session-action-new"]');

        // Wait for a different session to be selected
        const newSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== initialSessionId),
          45_000,
          500,
          "new chat session to replace the old one after New session",
        );

        // Verify the agent's main session ID has been updated to the new session
        const mainAfter = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId),
          (value) => value === newSessionId,
          30_000,
          500,
          "agent mainSessionId to be updated to the new session",
        );
        expect(mainAfter).toBe(newSessionId);
        expect(mainAfter).not.toBe(initialSessionId);

        // Both sessions should exist in the session list
        const sessionsAfter = await invokeCommand<Array<SessionRecordLike>>(
          webdriverSessionId,
          "list_sessions",
        );
        expect(sessionsAfter.some((s) => s.id === initialSessionId)).toBe(true);
        expect(sessionsAfter.some((s) => s.id === newSessionId)).toBe(true);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );

  it.skipIf(!isDesktopE2E)(
    "after navigating away and back, the new session remains selected",
    async () => {
      const webdriverSessionId = await createReadyWebdriverSession();

      try {
        await ensureReactReady(webdriverSessionId);

        // Open supervisor chat
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await clickSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]');
        await waitForText(webdriverSessionId, "Supervisor chat");

        const sessionBeforeNew = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value.length > 0),
          45_000,
          500,
          "supervisor chat session to become selected",
        );

        // Click "New Session" to create a new session
        await clickSelector(webdriverSessionId, '[data-role="session-actions-trigger"]');
        await sleep(300);
        await waitForSelector(webdriverSessionId, '[data-role="session-action-new"]');
        await clickSelector(webdriverSessionId, '[data-role="session-action-new"]');

        const newSessionId = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== sessionBeforeNew),
          45_000,
          500,
          "new chat session to replace the old one after New session",
        );

        // Verify the agent's main session ID matches the new session
        const mainSessionId = await waitForCondition(
          () => getAgentMainSessionId(webdriverSessionId),
          (value) => value === newSessionId,
          30_000,
          500,
          "agent mainSessionId to match the new session",
        );
        expect(mainSessionId).toBe(newSessionId);

        // Navigate away to Tasks
        await clickByText(webdriverSessionId, "button", "Tasks");
        await sleep(500);

        // Navigate back to Chat
        await clickByText(webdriverSessionId, "button", "Chat");
        await waitForSelector(webdriverSessionId, '[data-role="chat-agent-nav-supervisor"]', 15_000);
        await sleep(500);

        // CRITICAL: Verify the new session (not the old one) is still selected
        const sessionAfterRecovery = await waitForCondition(
          () => getSelectedSessionId(webdriverSessionId),
          (value) => Boolean(value && value !== sessionBeforeNew),
          60_000,
          500,
          "chat session to remain the new session after navigating away and back",
        );

        expect(sessionAfterRecovery).not.toBe(
          sessionBeforeNew,
          "Chat should show the new session, not the old one that was replaced",
        );
        expect(sessionAfterRecovery).toBe(
          newSessionId,
          `Chat should match the session created by "New session" (${newSessionId})`,
        );

        // Also verify the agent's mainSessionId still points to the new session
        const mainAfterRecovery = await getAgentMainSessionId(webdriverSessionId);
        expect(mainAfterRecovery).toBe(newSessionId);
      } finally {
        await deleteWebdriverSession(webdriverSessionId);
      }
    },
    300_000,
  );
});
