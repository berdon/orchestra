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

test("explanatory tooltips appear on key header controls and can be disabled globally", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-role="toggle-sidebar-collapse"]')).toHaveAttribute('data-tooltip', 'Collapse the sidebar to make more room for your work.');
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.locator('[data-role="new-task"]')).toHaveAttribute('data-tooltip', 'Create a new task draft in the active project.');
  await expect(page.locator('[data-role="open-command-palette"]')).toHaveAttribute('data-tooltip', 'Search pages and common actions from anywhere in the app.');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  await page.locator('[data-role="explanatory-tooltips-toggle"]').uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-explanatory-tooltips', 'disabled');

  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.locator('[data-role="new-task"]')).not.toHaveAttribute('data-tooltip', /.+/);
  await expect(page.locator('[data-role="open-command-palette"]')).not.toHaveAttribute('data-tooltip', /.+/);
  await expect(page.locator('[data-role="toggle-sidebar-collapse"]')).not.toHaveAttribute('data-tooltip', /.+/);
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

  await expect(page.locator('[data-role="app-brand"]')).toHaveCount(0);
  await expect(page.locator('[data-role="sidebar-collapsed-header"]')).toBeVisible();
  await expect(page.locator('[data-role="sidebar-collapsed-header"] >> [data-role="toggle-sidebar-collapse"]')).toHaveAttribute('title', 'Expand navigation');
  await expect(page.locator('.project-switcher__label')).toHaveCount(0);
  await expect(page.locator('.nav-item__icon').first()).toBeVisible();
  await expect(page.locator('.nav-item__label--short')).toHaveCount(0);
  await expect(page.locator('[data-role="project-switcher-trigger"]')).toHaveAccessibleName(/Switch project:/);
  await expect(page.locator('[data-role="project-switcher-trigger"]')).toHaveAttribute('data-tooltip', "Switch the active project and refresh the app to that project's data.");

  const collapsedSpacing = await page.evaluate(() => {
    const toggle = document.querySelector('[data-role="toggle-sidebar-collapse"]');
    const projectTrigger = document.querySelector('[data-role="project-switcher-trigger"]');
    const firstNavItem = document.querySelector('[data-role="nav-item-tasks"]');
    if (!(toggle instanceof HTMLElement) || !(projectTrigger instanceof HTMLElement) || !(firstNavItem instanceof HTMLElement)) {
      return null;
    }

    const toggleRect = toggle.getBoundingClientRect();
    const projectRect = projectTrigger.getBoundingClientRect();
    const firstNavRect = firstNavItem.getBoundingClientRect();
    return {
      toggleToProjectGap: Math.round(projectRect.top - toggleRect.bottom),
      projectToFirstNavGap: Math.round(firstNavRect.top - projectRect.bottom),
    };
  });

  expect(collapsedSpacing).not.toBeNull();
  expect(collapsedSpacing?.toggleToProjectGap ?? 999).toBeLessThanOrEqual(24);
  expect(collapsedSpacing?.projectToFirstNavGap ?? 999).toBeLessThanOrEqual(16);

  const storedCollapsed = await page.evaluate(() => window.localStorage.getItem('orchestra.preferences.sidebar-collapsed'));
  expect(storedCollapsed).toBe('true');

  await page.reload();
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'true');
  await expect(page.locator('[data-role="sidebar-collapsed-header"]')).toBeVisible();
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
