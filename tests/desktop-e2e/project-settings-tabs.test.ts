import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  setWindowRect,
  waitForSelector,
  waitForText,
  waitForVisibleSelector,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function assertPanelRendered(sessionId: string, panelSelector: string, readySelector: string) {
  await waitForVisibleSelector(sessionId, panelSelector);
  await waitForVisibleSelector(sessionId, readySelector, 30_000);

  const loadingText = await executeScript<string>(sessionId, `
    const panel = document.querySelector(arguments[0]);
    return panel instanceof HTMLElement ? panel.innerText : "";
  `, [panelSelector]);
  expect(loadingText).not.toContain("Loading");
}

async function waitForProjectTabToRender(sessionId: string, tabSelector: string, panelSelector: string, readySelector: string) {
  await waitForSelector(sessionId, tabSelector);
  await clickSelector(sessionId, tabSelector);
  await assertPanelRendered(sessionId, panelSelector, readySelector);
}

async function waitForProjectSectionToRender(sessionId: string, sectionId: "automation" | "source-control" | "secrets", panelSelector: string, readySelector: string) {
  await waitForVisibleSelector(sessionId, '[data-role="project-detail-section-select-control"]');
  await setInputValue(sessionId, '[data-role="project-detail-section-select-control"]', sectionId);
  await assertPanelRendered(sessionId, panelSelector, readySelector);
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

  it.skipIf(!isDesktopE2E)("keeps Automation, Source Control, and Secrets reachable in the narrow mobile settings layout", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "Projects");
      await waitForText(sessionId, "Project catalog");
      await waitForSelector(sessionId, '[data-role="project-detail-tab-general"]');
      await waitForText(sessionId, "Orchestra");

      await setWindowRect(sessionId, { width: 390, height: 844, x: 0, y: 0 });
      await waitForVisibleSelector(sessionId, '[data-role="project-detail-section-select-control"]');
      const mobileNavigationState = await executeScript<string>(sessionId, `
        return document.querySelector('.app-shell')?.getAttribute('data-mobile-navigation') ?? '';
      `);
      expect(mobileNavigationState).toBe('true');

      await waitForProjectSectionToRender(
        sessionId,
        "automation",
        '[data-role="project-detail-tabpanel-automation"]',
        '[data-role="project-auto-dispatch-on-blocker-completion"]',
      );

      await waitForProjectSectionToRender(
        sessionId,
        "source-control",
        '[data-role="project-detail-tabpanel-source-control"]',
        '[data-role="project-source-control-settings"]',
      );

      await waitForProjectSectionToRender(
        sessionId,
        "secrets",
        '[data-role="project-detail-tabpanel-secrets"]',
        '[data-role="project-secrets-status"]',
      );
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
