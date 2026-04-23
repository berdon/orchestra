import { describe, expect, it } from "vitest";

import {
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop navigation layout", () => {
  it.skipIf(!isDesktopE2E)("supports collapsing the left rail and resizing the sessions nav", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await waitForSelector(sessionId, '[data-role="toggle-sidebar-collapse"]');

      const initialCollapsed = await executeScript<string | null>(
        sessionId,
        `return document.querySelector('.app-shell')?.getAttribute('data-sidebar-collapsed') ?? null;`,
      );
      expect(initialCollapsed).toBe('false');

      await clickSelector(sessionId, '[data-role="toggle-sidebar-collapse"]');
      await sleep(300);
      const collapsed = await executeScript<string | null>(
        sessionId,
        `return document.querySelector('.app-shell')?.getAttribute('data-sidebar-collapsed') ?? null;`,
      );
      expect(collapsed).toBe('true');

      const collapsedRailState = await executeScript<{
        navTitles: string[];
        navAriaLabels: string[];
        iconCount: number;
        triggerTooltip: string;
        toggleTooltip: string;
        shortLabelCount: number;
        brandCount: number;
        collapsedHeaderButtonCount: number;
        projectLabelCount: number;
        toggleToProjectGap: number | null;
      }>(
        sessionId,
        `
          const toggle = document.querySelector('[data-role="toggle-sidebar-collapse"]');
          const trigger = document.querySelector('[data-role="project-switcher-trigger"]');
          return {
            navTitles: Array.from(document.querySelectorAll('[data-role^="nav-item-"]')).map((node) => node.getAttribute('title') ?? ''),
            navAriaLabels: Array.from(document.querySelectorAll('[data-role^="nav-item-"]')).map((node) => node.getAttribute('aria-label') ?? ''),
            iconCount: document.querySelectorAll('.nav-item__icon').length,
            triggerTooltip: document.querySelector('[data-role="project-switcher-trigger"]')?.getAttribute('data-tooltip') ?? '',
            toggleTooltip: document.querySelector('[data-role="toggle-sidebar-collapse"]')?.getAttribute('data-tooltip') ?? '',
            shortLabelCount: document.querySelectorAll('.nav-item__label--short').length,
            brandCount: document.querySelectorAll('[data-role="app-brand"]').length,
            collapsedHeaderButtonCount: document.querySelectorAll('[data-role="sidebar-collapsed-header"] [data-role="toggle-sidebar-collapse"]').length,
            projectLabelCount: document.querySelectorAll('.project-switcher__label').length,
            toggleToProjectGap: toggle instanceof HTMLElement && trigger instanceof HTMLElement
              ? Math.round(trigger.getBoundingClientRect().top - toggle.getBoundingClientRect().bottom)
              : null,
          };
        `,
      );
      expect(collapsedRailState.navTitles).toEqual(['Tasks', 'Inbox', 'Agents', 'Chat', 'Sessions', 'Settings']);
      expect(collapsedRailState.navAriaLabels).toEqual(['Tasks', 'Inbox', 'Agents', 'Chat', 'Sessions', 'Settings']);
      expect(collapsedRailState.iconCount).toBeGreaterThanOrEqual(6);
      expect(collapsedRailState.triggerTooltip).toBe("Switch the active project and refresh the app to that project's data.");
      expect(collapsedRailState.toggleTooltip).toBe('Expand the sidebar so labels and navigation details are visible again.');
      expect(collapsedRailState.shortLabelCount).toBe(0);
      expect(collapsedRailState.brandCount).toBe(0);
      expect(collapsedRailState.collapsedHeaderButtonCount).toBe(1);
      expect(collapsedRailState.projectLabelCount).toBe(0);
      expect(collapsedRailState.toggleToProjectGap).not.toBeNull();
      expect(collapsedRailState.toggleToProjectGap ?? 999).toBeLessThanOrEqual(24);

      await clickSelector(sessionId, '[data-role="project-switcher-trigger"]');
      await waitForSelector(sessionId, '[data-role="project-switcher-menu"]');
      const collapsedMenuState = await executeScript<{
        menuWidth: number | null;
        menuLeft: number | null;
        triggerRight: number | null;
      }>(
        sessionId,
        `
          const trigger = document.querySelector('[data-role="project-switcher-trigger"]');
          const menu = document.querySelector('[data-role="project-switcher-menu"]');
          if (!(trigger instanceof HTMLElement) || !(menu instanceof HTMLElement)) {
            return { menuWidth: null, menuLeft: null, triggerRight: null };
          }
          const triggerRect = trigger.getBoundingClientRect();
          const menuRect = menu.getBoundingClientRect();
          return {
            menuWidth: Math.round(menuRect.width),
            menuLeft: Math.round(menuRect.left),
            triggerRight: Math.round(triggerRect.right),
          };
        `,
      );
      expect(collapsedMenuState.menuWidth).not.toBeNull();
      expect(collapsedMenuState.menuWidth ?? 0).toBeGreaterThanOrEqual(220);
      expect(collapsedMenuState.menuLeft).not.toBeNull();
      expect(collapsedMenuState.triggerRight).not.toBeNull();
      expect(collapsedMenuState.menuLeft ?? 0).toBeGreaterThanOrEqual((collapsedMenuState.triggerRight ?? 0) - 1);

      await clickSelector(sessionId, '[data-role="toggle-sidebar-collapse"]');
      const expanded = await executeScript<string | null>(
        sessionId,
        `return document.querySelector('.app-shell')?.getAttribute('data-sidebar-collapsed') ?? null;`,
      );
      expect(expanded).toBe('false');

      await executeScript(
        sessionId,
        `
          const apply = window.__orchestraTestApplySessionRecord;
          if (typeof apply !== 'function') {
            throw new Error('Session apply test hook is unavailable');
          }
          const timestamp = new Date().toISOString();
          apply({
            id: 'session-late',
            title: 'runtime-z',
            status: 'active',
            createdAt: timestamp,
            updatedAt: timestamp,
            subscribed: false,
            events: [],
            taskId: 'task-10',
            taskNumber: 'ORC-10',
            taskTitle: 'Tenth task',
            workerType: 'agent',
            workerName: 'Reviewer',
          });
          apply({
            id: 'session-early',
            title: 'runtime-a',
            status: 'active',
            createdAt: timestamp,
            updatedAt: timestamp,
            subscribed: false,
            events: [],
            taskId: 'task-2',
            taskNumber: 'ORC-2',
            taskTitle: 'Second task',
            workerType: 'role',
            workerName: 'Builder',
          });
        `,
      );

      await waitForText(sessionId, 'Second task');
      const firstRowText = await executeScript<string>(
        sessionId,
        `return document.querySelector('[data-role="session-link"]')?.textContent?.trim() ?? '';`,
      );
      expect(firstRowText).toContain('ORC-2');
      expect(firstRowText).toContain('Second task');

      await executeScript(
        sessionId,
        `
          const row = document.querySelector('.session-list-row');
          const link = row?.querySelector('[data-role="session-link"]');
          row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true, relatedTarget: document.body }));
          row?.dispatchEvent(new MouseEvent('mouseenter', { relatedTarget: document.body }));
          if (link instanceof HTMLElement) {
            link.focus();
          }
          return true;
        `,
      );
      await waitForSelector(sessionId, '.session-list-row--actions-visible .session-delete-button', 5000);
      const revealClass = await executeScript<string>(
        sessionId,
        `return document.querySelector('.session-list-row')?.className ?? '';`,
      );
      expect(revealClass).toContain('session-list-row--actions-visible');

      const resizeHandleExists = await executeScript<boolean>(
        sessionId,
        `return Boolean(document.querySelector('[data-role="secondary-nav-resize-handle"]'));`,
      );
      expect(resizeHandleExists).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
