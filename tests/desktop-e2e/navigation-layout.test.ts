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
          row?.dispatchEvent(new MouseEvent('mouseover', { bubbles: true }));
          row?.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        `,
      );
      await sleep(2200);
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
