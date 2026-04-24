import { expect, test } from "@playwright/test";

import { pairHostedWebBrowser } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pairHostedWebBrowser(page);
});

test("hosted-web settings load the seeded agents admin surface through the remote API", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.locator('[data-role="settings-tab-agents"]').click();

  await expect(page.locator('[data-role="agent-name"]')).toBeVisible();
  await expect(page.locator('[data-role="agent-name"]')).toHaveValue(/Supervisor|Data/);
  await expect(page.locator('[data-role="agent-pi-executable-diagnostic"]')).toContainText(/Pi runtime:/);
});
