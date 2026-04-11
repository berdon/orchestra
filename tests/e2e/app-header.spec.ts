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

test("left navigation can collapse and persists across reloads", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'false');
  await page.locator('[data-role="toggle-sidebar-collapse"]').click();
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'true');
  await expect(page.locator('.nav-item__label--short').first()).toBeVisible();
  const storedCollapsed = await page.evaluate(() => window.localStorage.getItem('orchestra.preferences.sidebar-collapsed'));
  expect(storedCollapsed).toBe('true');
});
