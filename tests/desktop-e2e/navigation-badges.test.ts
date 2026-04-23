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

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 15_000) {
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

describe("desktop navigation badges", () => {
  it.skipIf(!isDesktopE2E)("shows per-project unread badges cleanly in the collapsed navigation rail", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await invokeCommand(sessionId, "create_project", {
        input: {
          name: "Alpha",
          taskPrefix: "ALP",
          description: "Alpha project for navigation badge coverage.",
        },
      });
      await invokeCommand(sessionId, "create_project", {
        input: {
          name: "Beta",
          taskPrefix: "BET",
          description: "Beta project for navigation badge coverage.",
        },
      });
      const projects = await invokeCommand<Array<{ id: string; slug: string; name: string }>>(sessionId, "list_projects");
      const alphaProject = projects.find((project) => project.name === "Alpha");
      const betaProject = projects.find((project) => project.name === "Beta");
      expect(alphaProject).toBeTruthy();
      expect(betaProject).toBeTruthy();

      await invokeCommand(sessionId, "create_task", {
        projectId: alphaProject!.id,
        input: {
          title: "Alpha review request",
          description: "Needs user review.",
          type: "task",
          status: "in_review",
          priority: "P1",
          assigneeType: "user",
          assigneeId: null,
        },
      });

      await invokeCommand(sessionId, "send_mailbox_message", {
        input: {
          projectId: betaProject!.id,
          recipientType: "user",
          body: "Please check the beta inbox.",
          priority: "interrupt",
        },
      });

      await invokeCommand(sessionId, "create_session", {
        title: "Alpha project session",
        projectSlug: alphaProject!.slug,
      });
      await invokeCommand(sessionId, "create_session", {
        title: "Beta project session",
        projectSlug: betaProject!.slug,
      });

      await executeScript(sessionId, `
        window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
        window.location.reload();
        return true;
      `);
      await sleep(1000);
      await ensureReactReady(sessionId);
      await waitForSelector(sessionId, '[data-role="project-switcher-trigger-badge"]');
      const outsideUnreadLabel = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="project-switcher-trigger-badge"]')?.getAttribute('aria-label') ?? '';
      `);
      expect(outsideUnreadLabel).toBe('Unread activity in other projects');

      await clickSelector(sessionId, '[data-role="project-switcher-trigger"]');
      await waitForSelector(sessionId, '[data-role="project-switcher-option-alpha"]');
      await waitForText(sessionId, 'Alpha');
      await waitForText(sessionId, 'Beta');
      const expandedMenuTexts = await executeScript<{ alpha: string; beta: string }>(sessionId, `
        return {
          alpha: document.querySelector('[data-role="project-switcher-option-alpha"]')?.textContent ?? '',
          beta: document.querySelector('[data-role="project-switcher-option-beta"]')?.textContent ?? '',
        };
      `);
      expect(expandedMenuTexts.alpha).toContain('1');
      expect(expandedMenuTexts.beta).toContain('1');
      await clickSelector(sessionId, '[data-role="project-switcher-option-alpha"]');

      await waitForSelector(sessionId, '[data-role="nav-badge-inbox"]');
      await clickSelector(sessionId, '[data-role="toggle-sidebar-collapse"]');

      const collapsedAlphaBadgeState = await executeScript<{
        triggerBadgeText: string;
        triggerBadgeClass: string;
        triggerBadgeWithinRail: boolean;
        inboxBadgeText: string;
        inboxBadgeClass: string;
        inboxBadgeWithinRail: boolean;
        sessionsBadgeText: string;
        sessionsBadgeClass: string;
        sessionsBadgeWithinRail: boolean;
      }>(sessionId, `
        const trigger = document.querySelector('[data-role="project-switcher-trigger"]');
        const triggerBadge = document.querySelector('[data-role="project-switcher-trigger-badge"]');
        const inboxButton = document.querySelector('[data-role="nav-item-inbox"]');
        const inboxBadge = document.querySelector('[data-role="nav-badge-inbox"]');
        const sessionsButton = document.querySelector('[data-role="nav-item-sessions"]');
        const sessionsBadge = document.querySelector('[data-role="nav-badge-sessions"]');

        const within = (container, badge) =>
          container instanceof HTMLElement && badge instanceof HTMLElement
            ? badge.getBoundingClientRect().right <= container.getBoundingClientRect().right + 1
              && badge.getBoundingClientRect().top >= container.getBoundingClientRect().top - 1
            : false;

        return {
          triggerBadgeText: triggerBadge?.textContent?.trim() ?? '',
          triggerBadgeClass: triggerBadge?.className ?? '',
          triggerBadgeWithinRail: within(trigger, triggerBadge),
          inboxBadgeText: inboxBadge?.textContent?.trim() ?? '',
          inboxBadgeClass: inboxBadge?.className ?? '',
          inboxBadgeWithinRail: within(inboxButton, inboxBadge),
          sessionsBadgeText: sessionsBadge?.textContent?.trim() ?? '',
          sessionsBadgeClass: sessionsBadge?.className ?? '',
          sessionsBadgeWithinRail: within(sessionsButton, sessionsBadge),
        };
      `);
      expect(collapsedAlphaBadgeState.triggerBadgeText).toBe('1');
      expect(collapsedAlphaBadgeState.triggerBadgeClass).toContain('status-badge--rail');
      expect(collapsedAlphaBadgeState.triggerBadgeWithinRail).toBe(true);
      expect(collapsedAlphaBadgeState.inboxBadgeText).toBe('1');
      expect(collapsedAlphaBadgeState.inboxBadgeClass).toContain('status-badge--rail');
      expect(collapsedAlphaBadgeState.inboxBadgeWithinRail).toBe(true);
      expect(collapsedAlphaBadgeState.sessionsBadgeText).toBe('1');
      expect(collapsedAlphaBadgeState.sessionsBadgeClass).toContain('status-badge--rail');
      expect(collapsedAlphaBadgeState.sessionsBadgeWithinRail).toBe(true);

      await clickSelector(sessionId, '[data-role="project-switcher-trigger"]');
      await waitForSelector(sessionId, '[data-role="project-switcher-menu"]');
      const collapsedMenuState = await executeScript<{
        width: number | null;
        left: number | null;
        triggerRight: number | null;
        alpha: string;
        beta: string;
      }>(sessionId, `
        const trigger = document.querySelector('[data-role="project-switcher-trigger"]');
        const menu = document.querySelector('[data-role="project-switcher-menu"]');
        const triggerRect = trigger instanceof HTMLElement ? trigger.getBoundingClientRect() : null;
        const menuRect = menu instanceof HTMLElement ? menu.getBoundingClientRect() : null;
        return {
          width: menuRect ? Math.round(menuRect.width) : null,
          left: menuRect ? Math.round(menuRect.left) : null,
          triggerRight: triggerRect ? Math.round(triggerRect.right) : null,
          alpha: document.querySelector('[data-role="project-switcher-option-alpha"]')?.textContent ?? '',
          beta: document.querySelector('[data-role="project-switcher-option-beta"]')?.textContent ?? '',
        };
      `);
      expect(collapsedMenuState.width).not.toBeNull();
      expect(collapsedMenuState.width ?? 0).toBeGreaterThanOrEqual(220);
      expect(collapsedMenuState.left).not.toBeNull();
      expect(collapsedMenuState.triggerRight).not.toBeNull();
      expect(collapsedMenuState.left ?? 0).toBeGreaterThanOrEqual((collapsedMenuState.triggerRight ?? 0) - 1);
      expect(collapsedMenuState.alpha).toContain('1');
      expect(collapsedMenuState.beta).toContain('1');

      await clickSelector(sessionId, '[data-role="project-switcher-option-beta"]');
      const collapsedBetaBadgeState = await waitForCondition(
        () => executeScript<{
          triggerBadgeText: string;
          inboxBadgeText: string;
          sessionsBadgeText: string;
        }>(sessionId, `
          return {
            triggerBadgeText: document.querySelector('[data-role="project-switcher-trigger-badge"]')?.textContent?.trim() ?? '',
            inboxBadgeText: document.querySelector('[data-role="nav-badge-inbox"]')?.textContent?.trim() ?? '',
            sessionsBadgeText: document.querySelector('[data-role="nav-badge-sessions"]')?.textContent?.trim() ?? '',
          };
        `),
        (value) => value.triggerBadgeText === '1' && value.inboxBadgeText === '1' && value.sessionsBadgeText === '1',
      );
      expect(collapsedBetaBadgeState.triggerBadgeText).toBe('1');
      expect(collapsedBetaBadgeState.inboxBadgeText).toBe('1');
      expect(collapsedBetaBadgeState.sessionsBadgeText).toBe('1');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
