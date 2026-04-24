import { expect, test } from "@playwright/test";

import { pairHostedWebBrowser } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pairHostedWebBrowser(page);
});

test("hosted-web chat exposes Supervisor as a selectable chat target", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-chat"]').click();

  const supervisorTab = page.locator('[data-role="chat-agent-nav-supervisor"]');
  await expect(supervisorTab).toBeVisible();
  await supervisorTab.click();
  await expect(supervisorTab).toHaveAttribute("aria-selected", "true");
});
