import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  waitForSelector,
  waitForText,
} from "./driver";
import { createRoleViaSettings } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

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

      const sessionsChrome = await executeScript<{
        hasSessionList: boolean;
        hasFilters: boolean;
        hasModelPicker: boolean;
        autoScrollMode: string;
        scrollLocked: string;
      }>(sessionId, `
        return {
          hasSessionList: Boolean(document.querySelector('[data-role="session-link"]')),
          hasFilters: Boolean(document.querySelector('[data-role="session-filter-active"]')),
          hasModelPicker: Boolean(document.querySelector('select[aria-label="Session model"]')),
          autoScrollMode: document.querySelector('[data-role="session-scroll-lock-toggle"]')?.getAttribute('data-auto-scroll-mode') || '',
          scrollLocked: document.querySelector('[data-role="session-transcript"]')?.getAttribute('data-scroll-locked') || '',
        };
      `);
      expect(sessionsChrome.hasSessionList).toBe(false);
      expect(sessionsChrome.hasFilters).toBe(false);
      expect(sessionsChrome.hasModelPicker).toBe(true);
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
      expect(firstSessionCount).toBe(1);

      await clickByText(sessionId, 'button', 'Chat');
      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'Supervisor main session');

      const secondSessionCount = await executeScript<number>(sessionId, `
        return Array.from(document.querySelectorAll('[data-role="session-link"]'))
          .filter((entry) => (entry.textContent || '').includes('Supervisor main session')).length;
      `);
      expect(secondSessionCount).toBe(1);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
