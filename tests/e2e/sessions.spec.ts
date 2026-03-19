import { expect, test } from "@playwright/test";

test("sessions UI creates a session and streams a mock reply", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.locator('[data-role="new-session-title"]').fill("Playwright session");
  await page.locator('[data-role="create-session"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toHaveText("Playwright session");

  await page.locator('[data-role="composer-input"]').fill("Hello from Playwright");
  await page.locator('[data-role="send-message"]').click();

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from Playwright", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Acknowledged: Hello from Playwright", { timeout: 20_000 });
});
