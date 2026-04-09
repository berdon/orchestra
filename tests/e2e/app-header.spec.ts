import { expect, test } from "@playwright/test";

test("app header shows version with short hash and the Orchestra brand", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.locator('[data-role="app-version-label"]')).toContainText(/^0\.1\.0-[a-z0-9]{8}$/i);
  await expect(page.locator('[data-role="app-brand"]')).toContainText("Orchestra");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "orchestra-dark");
});
