import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import { createRoleViaSettings } from "./ui-flows";

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

describe("desktop agent chat navigation", () => {
  it.skipIf(!isDesktopE2E)("opens focused agent chat from Chat nav and keeps Sessions available for debugging", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await createRoleViaSettings(sessionId, {
        name: "Reviewer",
        capacity: "1",
        description: "Role used to verify chat nav excludes workforce roles.",
      });

      await clickByText(sessionId, "button", "Chat");
      await waitForSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');

      const chatNavState = await executeScript<{ labels: string[] }>(sessionId, `
        const items = Array.from(document.querySelectorAll('.settings-subnav[aria-label="Chat agents"] .settings-subnav__item'));
        return {
          labels: items.map((entry) => (entry.textContent || '').trim()).filter(Boolean),
        };
      `);
      expect(chatNavState.labels).toContain('Supervisor');
      expect(chatNavState.labels).not.toContain('Reviewer');

      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');
      await waitForSelector(sessionId, '[data-role="session-wrap-toggle"]');
      await waitForSelector(sessionId, '[data-role="session-scroll-lock-toggle"]');
      await waitForSelector(sessionId, '[data-role="composer-input"]');
      await waitForCondition(
        () => executeScript<boolean>(sessionId, `
          return Boolean(document.querySelector('[data-role="session-context-stats"]'));
        `),
        (value) => value === true,
      );

      const sessionsChrome = await executeScript<{
        hasSessionList: boolean;
        hasFilters: boolean;
        hasModelPicker: boolean;
        hasContextStats: boolean;
        contextPercentLabel: string;
        autoScrollMode: string;
        scrollLocked: string;
      }>(sessionId, `
        return {
          hasSessionList: Boolean(document.querySelector('[data-role="session-link"]')),
          hasFilters: Boolean(document.querySelector('[data-role="session-filter-active"]')),
          hasModelPicker: Boolean(document.querySelector('select[aria-label="Session model"]')),
          hasContextStats: Boolean(document.querySelector('[data-role="session-context-stats"]')),
          contextPercentLabel: document.querySelector('[data-role="session-context-percent"]')?.textContent || '',
          autoScrollMode: document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '',
          scrollLocked: document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '',
        };
      `);
      expect(sessionsChrome.hasSessionList).toBe(false);
      expect(sessionsChrome.hasFilters).toBe(false);
      expect(sessionsChrome.hasModelPicker).toBe(true);
      expect(sessionsChrome.hasContextStats).toBe(true);
      expect(sessionsChrome.contextPercentLabel.toLowerCase()).toContain('context');
      expect(sessionsChrome.autoScrollMode).toBe('on');
      expect(sessionsChrome.scrollLocked).toBe('true');

      await clickSelector(sessionId, '[data-role="session-scroll-lock-toggle"]');
      const pausedAutoScroll = await executeScript<{ autoScrollMode: string; scrollLocked: string }>(sessionId, `
        return {
          autoScrollMode: document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '',
          scrollLocked: document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '',
        };
      `);
      expect(pausedAutoScroll.autoScrollMode).toBe('off');
      expect(pausedAutoScroll.scrollLocked).toBe('false');

      await clickSelector(sessionId, '[data-role="session-scroll-lock-toggle"]');
      const resumedAutoScroll = await executeScript<{ autoScrollMode: string; scrollLocked: string }>(sessionId, `
        return {
          autoScrollMode: document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '',
          scrollLocked: document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '',
        };
      `);
      expect(resumedAutoScroll.autoScrollMode).toBe('on');
      expect(resumedAutoScroll.scrollLocked).toBe('true');

      const firstChatSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
      `);
      expect(firstChatSessionId).toBeTruthy();

      await clickSelector(sessionId, '[data-role="session-actions-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-actions-menu"]');
      await clickSelector(sessionId, '[data-role="session-action-new"]');
      await waitForText(sessionId, 'Supervisor chat');

      const secondChatSessionId = await waitForCondition(
        () => executeScript<string>(sessionId, `
          return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
        `),
        (value) => Boolean(value) && value !== firstChatSessionId,
      );
      expect(secondChatSessionId).toBeTruthy();
      expect(secondChatSessionId).not.toBe(firstChatSessionId);

      await clickSelector(sessionId, '[data-role="session-actions-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-actions-menu"]');
      await clickSelector(sessionId, '[data-role="session-action-reload"]');
      await waitForText(sessionId, 'Reloaded');

      const longLine = `DESKTOP-CHAT-${'z'.repeat(240)}`;
      await setInputValue(sessionId, '[data-role="composer-input"]', longLine);
      await clickSelector(sessionId, '[data-role="send-message"]');
      await waitForText(sessionId, longLine);

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForSelector(sessionId, '[data-role="session-filter-active"]');
      await waitForText(sessionId, 'Supervisor main session');

      const firstSessionCount = await executeScript<number>(sessionId, `
        return Array.from(document.querySelectorAll('[data-role="session-link"]'))
          .filter((entry) => (entry.textContent || '').includes('Supervisor main session')).length;
      `);
      expect(firstSessionCount).toBe(2);

      const selectedSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('.session-list-link--active[data-role="session-link"]')?.getAttribute('data-session-id') || '';
      `);
      expect(selectedSessionId).toBe(secondChatSessionId);

      await clickByText(sessionId, 'button', 'Chat');
      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');

      const restoredChatSessionId = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '';
      `);
      expect(restoredChatSessionId).toBe(secondChatSessionId);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
