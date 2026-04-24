import { expect, test } from "@playwright/test";

import { pairHostedWebBrowser } from "./helpers";

test.beforeEach(async ({ page }) => {
  await pairHostedWebBrowser(page);
});

test("hosted-web sessions load seeded transcript data from the Remote API", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-sessions"]').click();

  const sessionLink = page.locator('[data-role="session-link"]').filter({ hasText: "Hosted web seeded session" }).first();
  await expect(sessionLink).toBeVisible();
  await sessionLink.click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Hosted web seeded session");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from hosted-web E2E");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText(
    "Hosted web reply from the seeded Remote API session.",
  );
});
