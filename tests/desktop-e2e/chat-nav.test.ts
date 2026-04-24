import { describe, expect, it } from "vitest";

import {
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

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(250);
  }
  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue)}`);
}

async function getSessionsPageState(sessionId: string) {
  return executeScript<{
    hasFilters: boolean;
    selectedSessionId: string;
    activeListSessionId: string;
    title: string;
    search: string;
  }>(sessionId, `
    return {
      hasFilters: Boolean(document.querySelector('[data-role="session-filter-active"]')),
      selectedSessionId: document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '',
      activeListSessionId: document.querySelector('.session-list-link--active[data-role="session-link"]')?.getAttribute('data-session-id') || '',
      title: document.querySelector('[data-role="selected-session-title"]')?.textContent?.trim() || '',
      search: window.location.search,
    };
  `);
}

async function injectSessionRecord(sessionId: string, record: Record<string, unknown>) {
  await executeScript(
    sessionId,
    `
      const apply = window.__orchestraTestApplySessionRecord;
      if (typeof apply !== 'function') {
        throw new Error('Missing __orchestraTestApplySessionRecord test hook');
      }
      apply(arguments[0]);
      return true;
    `,
    [record],
  );
}

async function hydrateChatAgentSession(sessionId: string, payload: { agentId: string; sessionId: string; select?: boolean }) {
  await executeScript(
    sessionId,
    `
      const hydrate = window.__orchestraTestHydrateChatAgentSession;
      if (typeof hydrate !== 'function') {
        throw new Error('Missing __orchestraTestHydrateChatAgentSession test hook');
      }
      hydrate(arguments[0]);
      return true;
    `,
    [payload],
  );
}

async function pinSessionIds(sessionId: string, sessionIds: string[]) {
  await executeScript(
    sessionId,
    `
      const pin = window.__orchestraTestPinSessionIds;
      if (typeof pin !== 'function') {
        throw new Error('Missing __orchestraTestPinSessionIds test hook');
      }
      pin(arguments[0]);
      return true;
    `,
    [sessionIds],
  );
}

describe("desktop agent chat navigation", () => {
  it.skipIf(!isDesktopE2E)("keeps Sessions selection isolated from a cached chat agent session", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await invokeCommand(sessionId, "create_role", {
        input: {
          name: "Reviewer",
          capacity: 1,
          description: "Role used to verify chat nav excludes workforce roles.",
          systemPrompt: "Review desktop navigation work.",
        },
      });

      const agent = await invokeCommand<{ id: string; slug: string; name: string }>(sessionId, "create_agent", {
        input: {
          name: "Desktop Chat Agent",
          description: "Agent used to verify chat/session navigation isolation.",
          systemPrompt: "Keep context focused on the current desktop navigation test.",
          thinkingLevel: "off",
        },
      });
      const chatTitle = `${agent.name} chat`;
      const sessionListTitle = `${agent.name} main session`;

      const baselineSession = {
        id: "session-desktop-baseline",
        title: "Desktop baseline session",
      };
      const firstChatSession = {
        id: "session-desktop-chat-agent-1",
        title: sessionListTitle,
      };
      const secondChatSession = {
        id: "session-desktop-chat-agent-2",
        title: sessionListTitle,
      };
      await pinSessionIds(sessionId, [baselineSession.id, firstChatSession.id, secondChatSession.id]);

      const baselineTimestamp = new Date().toISOString();
      await injectSessionRecord(sessionId, {
        id: baselineSession.id,
        title: baselineSession.title,
        status: "active",
        createdAt: baselineTimestamp,
        updatedAt: baselineTimestamp,
        subscribed: false,
        events: [{
          id: "session-event-desktop-baseline",
          kind: "assistant",
          message: "Baseline session pinned in Sessions.",
          timestamp: baselineTimestamp,
        }],
      });

      await clickSelector(sessionId, '[data-role="nav-item-sessions"]');
      await waitForSelector(sessionId, '[data-role="session-filter-active"]');
      await waitForText(sessionId, baselineSession.title);
      await clickSelector(sessionId, `[data-role="session-link"][data-session-id="${baselineSession.id}"]`);

      const initialSessionsState = await waitForCondition(
        () => getSessionsPageState(sessionId),
        (value) => value.hasFilters
          && value.selectedSessionId === baselineSession.id
          && value.activeListSessionId === baselineSession.id
          && value.title.includes(baselineSession.title),
      );
      expect(initialSessionsState.selectedSessionId).toBe(baselineSession.id);
      expect(initialSessionsState.activeListSessionId).toBe(baselineSession.id);
      expect(initialSessionsState.title).toContain(baselineSession.title);

      await clickSelector(sessionId, '[data-role="nav-item-chat"]');
      await waitForSelector(sessionId, `[data-role="chat-agent-nav-${agent.slug}"]`);

      const chatNavState = await executeScript<{ labels: string[] }>(sessionId, `
        const items = Array.from(document.querySelectorAll('.settings-subnav[aria-label="Chat agents"] .settings-subnav__item'));
        return {
          labels: items.map((entry) => (entry.textContent || '').trim()).filter(Boolean),
        };
      `);
      expect(chatNavState.labels).toContain(agent.name);
      expect(chatNavState.labels).not.toContain("Reviewer");

      const firstChatTimestamp = new Date().toISOString();
      await injectSessionRecord(sessionId, {
        id: firstChatSession.id,
        title: firstChatSession.title,
        status: "active",
        createdAt: firstChatTimestamp,
        updatedAt: firstChatTimestamp,
        subscribed: true,
        events: [{
          id: "session-event-desktop-chat-agent-1",
          kind: "assistant",
          message: "First desktop chat session.",
          timestamp: firstChatTimestamp,
        }],
      });
      await hydrateChatAgentSession(sessionId, { agentId: agent.id, sessionId: firstChatSession.id });
      await waitForText(sessionId, chatTitle);

      const firstChatSessionId = await waitForCondition(
        () => executeScript<string>(sessionId, `
          return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
        `),
        (value) => value === firstChatSession.id,
      );
      expect(firstChatSessionId).toBe(firstChatSession.id);

      const secondChatTimestamp = new Date().toISOString();
      await injectSessionRecord(sessionId, {
        id: secondChatSession.id,
        title: secondChatSession.title,
        status: "active",
        createdAt: secondChatTimestamp,
        updatedAt: secondChatTimestamp,
        subscribed: true,
        events: [{
          id: "session-event-desktop-chat-agent-2",
          kind: "assistant",
          message: "Second desktop chat session.",
          timestamp: secondChatTimestamp,
        }],
      });
      await hydrateChatAgentSession(sessionId, { agentId: agent.id, sessionId: secondChatSession.id });

      const secondChatSessionId = await waitForCondition(
        () => executeScript<string>(sessionId, `
          return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
        `),
        (value) => value === secondChatSession.id,
      );
      expect(secondChatSessionId).toBe(secondChatSession.id);

      await clickSelector(sessionId, '[data-role="nav-item-sessions"]');
      await waitForSelector(sessionId, '[data-role="session-filter-active"]');
      await waitForText(sessionId, sessionListTitle);

      const sessionsStateAfterReturn = await waitForCondition(
        () => getSessionsPageState(sessionId),
        (value) => value.hasFilters
          && value.selectedSessionId === initialSessionsState.selectedSessionId
          && value.activeListSessionId === initialSessionsState.activeListSessionId
          && value.title.includes(initialSessionsState.title)
          && !value.title.includes(chatTitle)
          && value.search.includes(`selectedSessionId=${initialSessionsState.selectedSessionId}`),
      );
      expect(sessionsStateAfterReturn.selectedSessionId).toBe(initialSessionsState.selectedSessionId);
      expect(sessionsStateAfterReturn.activeListSessionId).toBe(initialSessionsState.activeListSessionId);
      expect(sessionsStateAfterReturn.selectedSessionId).not.toBe(secondChatSessionId);
      expect(sessionsStateAfterReturn.title).toContain(initialSessionsState.title);
      expect(sessionsStateAfterReturn.title).not.toContain(chatTitle);
      expect(sessionsStateAfterReturn.search).toContain(`selectedSessionId=${initialSessionsState.selectedSessionId}`);

      await clickSelector(sessionId, '[data-role="nav-item-chat"]');
      await waitForText(sessionId, chatTitle);

      const restoredChatSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
      `);
      expect(restoredChatSessionId).toBe(secondChatSessionId);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
