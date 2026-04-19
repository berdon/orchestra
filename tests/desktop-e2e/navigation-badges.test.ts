import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop navigation badges", () => {
  it.skipIf(!isDesktopE2E)("shows per-project unread badges and scopes Sessions to the active project", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const alphaProject = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_project", {
        input: { name: "Alpha" },
      });
      const betaProject = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_project", {
        input: { name: "Beta" },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");

      await invokeCommand(sessionId, "create_task", {
        projectId: alphaProject.id,
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
          projectId: betaProject.id,
          recipientType: "user",
          body: "Please check the beta inbox.",
          priority: "interrupt",
        },
      });

      await invokeCommand(sessionId, "create_session", {
        title: "Alpha project session",
        projectSlug: alphaProject.slug,
      });
      await invokeCommand(sessionId, "create_session", {
        title: "Beta project session",
        projectSlug: betaProject.slug,
      });

      await waitForSelector(sessionId, '[data-role="project-switcher-trigger-badge"]');
      await waitForText(sessionId, '*');

      await clickSelector(sessionId, '[data-role="project-switcher-trigger"]');
      await waitForSelector(sessionId, '[data-role="project-switcher-option-alpha"]');
      await waitForText(sessionId, 'Alpha');
      await waitForText(sessionId, 'Beta');
      await clickSelector(sessionId, '[data-role="project-switcher-option-alpha"]');

      await waitForSelector(sessionId, '[data-role="nav-badge-inbox"]');
      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'Alpha project session');
      const alphaSessionsText = await executeScript<string>(sessionId, `
        const element = document.querySelector('.session-list');
        return element ? element.textContent || '' : '';
      `);
      expect(alphaSessionsText).toContain('Alpha project session');

      await clickSelector(sessionId, '[data-role="project-switcher-trigger"]');
      await waitForSelector(sessionId, '[data-role="project-switcher-option-beta"]');
      await clickSelector(sessionId, '[data-role="project-switcher-option-beta"]');

      await waitForText(sessionId, 'Beta project session');
      const betaSessionsText = await executeScript<string>(sessionId, `
        const element = document.querySelector('.session-list');
        return element ? element.textContent || '' : '';
      `);
      expect(betaSessionsText).toContain('Beta project session');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
