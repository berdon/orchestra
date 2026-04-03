import { expect, test } from "@playwright/test";

test("app header shows version with short hash", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-role="app-version-label"]')).toContainText(/^0\.1\.0-[a-z0-9]{8}$/i);
});
