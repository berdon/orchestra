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

test("left navigation can collapse into an icon rail and persists across reloads", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => window.localStorage.clear());
  await page.reload();
  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'false');
  await page.locator('[data-role="toggle-sidebar-collapse"]').click();
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'true');

  for (const name of ['Tasks', 'Inbox', 'Agents', 'Chat', 'Sessions', 'Settings'] as const) {
    await expect(page.getByRole('button', { name })).toBeVisible();
  }

  await expect(page.locator('.nav-item__icon').first()).toBeVisible();
  await expect(page.locator('.nav-item__label--short')).toHaveCount(0);
  await expect(page.locator('[data-role="project-switcher-trigger"]')).toHaveAccessibleName(/Switch project:/);
  await expect(page.locator('[data-role="project-switcher-trigger"]')).toHaveAttribute('title', /Switch project:/);

  const storedCollapsed = await page.evaluate(() => window.localStorage.getItem('orchestra.preferences.sidebar-collapsed'));
  expect(storedCollapsed).toBe('true');

  await page.reload();
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'true');
  await expect(page.getByRole('button', { name: 'Tasks' })).toBeVisible();
});

test("mobile layout stays single-column even when the sidebar is collapsed", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 840, height: 900 });

  await page.goto("/");
  await page.locator('[data-role="toggle-sidebar-collapse"]').click();

  const gridTemplateColumns = await page.locator('.app-shell').evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(gridTemplateColumns.split(' ').filter(Boolean)).toHaveLength(1);
});
