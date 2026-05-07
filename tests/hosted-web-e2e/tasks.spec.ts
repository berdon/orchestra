import { expect, test } from "@playwright/test";

import { pairHostedWebBrowser } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pairHostedWebBrowser(page);
});

test("hosted-web tasks browse the seeded Remote API task list and open detail", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-tasks"]').click();

  const hostedTaskEntry = page.getByText("Hosted web seeded task", { exact: true }).first();
  await expect(hostedTaskEntry).toBeVisible({ timeout: 10_000 });
  await expect(page.getByText("Hosted web review task", { exact: true }).first()).toBeVisible({ timeout: 10_000 });

  await hostedTaskEntry.click();
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Hosted web seeded task");
  await expect(page.locator('[data-role="task-overview-description"]')).toContainText("Browser-hosted task coverage through the Remote API path.");
});
