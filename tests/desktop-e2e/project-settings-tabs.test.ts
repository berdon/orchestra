import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForProjectTabToRender(sessionId: string, tabSelector: string, panelSelector: string, readySelector: string) {
  await waitForSelector(sessionId, tabSelector);
  await clickSelector(sessionId, tabSelector);
  await waitForSelector(sessionId, panelSelector);
  await waitForSelector(sessionId, readySelector, 30_000);

  const loadingText = await executeScript<string>(sessionId, `
    const panel = document.querySelector(arguments[0]);
    return panel instanceof HTMLElement ? panel.innerText : "";
  `, [panelSelector]);
  expect(loadingText).not.toContain("Loading");
}

describe("desktop project settings tabs", () => {
  it.skipIf(!isDesktopE2E)("loads Automation, Source Control, and Secrets for the seeded desktop project", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "Projects");
      await waitForText(sessionId, "Project catalog");
      await waitForSelector(sessionId, '[data-role="project-detail-tab-general"]');
      await waitForText(sessionId, "Orchestra");

      await waitForProjectTabToRender(
        sessionId,
        '[data-role="project-detail-tab-automation"]',
        '[data-role="project-detail-tabpanel-automation"]',
        '[data-role="project-auto-dispatch-on-blocker-completion"]',
      );

      await waitForProjectTabToRender(
        sessionId,
        '[data-role="project-detail-tab-source-control"]',
        '[data-role="project-detail-tabpanel-source-control"]',
        '[data-role="project-source-control-settings"]',
      );

      await waitForProjectTabToRender(
        sessionId,
        '[data-role="project-detail-tab-secrets"]',
        '[data-role="project-detail-tabpanel-secrets"]',
        '[data-role="project-secrets-status"]',
      );
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
