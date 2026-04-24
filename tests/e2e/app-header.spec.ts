import { expect, test, type Page } from "@playwright/test";

test("shared page header is removed while the Orchestra brand remains in navigation", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.locator('.page-header')).toHaveCount(0);
  await expect(page.locator('[data-role="app-version-label"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-command-palette"]')).toHaveCount(0);
  await expect(page.locator('[data-role="open-supervisor-quick-chat"]')).toHaveCount(0);
  await expect(page.locator('[data-role="app-brand"]')).toContainText("Orchestra");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "orchestra-dark");
});

test("explanatory tooltips appear on the tasks floating action button and can be disabled globally", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator('[data-role="toggle-sidebar-collapse"]')).toHaveAttribute('data-tooltip', 'Collapse the sidebar to make more room for your work.');
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.locator('[data-role="new-task"]')).toHaveAttribute('data-tooltip', 'Create a new task draft in the active project.');

  await page.getByRole('button', { name: 'Settings' }).click();
  await page.getByRole('tab', { name: 'General' }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  await page.locator('[data-role="explanatory-tooltips-toggle"]').uncheck();
  await expect(page.locator('html')).toHaveAttribute('data-explanatory-tooltips', 'disabled');

  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.locator('[data-role="new-task"]')).not.toHaveAttribute('data-tooltip', /.+/);
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

async function openMobileNavigation(page: Page) {
  await page.locator('[data-role="toggle-mobile-navigation"]').click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toBeVisible();
}

test("mobile navigation uses a hamburger dialog, ignores desktop collapse state, and closes cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem('orchestra.preferences.sidebar-collapsed', 'true');
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");

  const shell = page.locator('.app-shell');
  await expect(shell).toHaveAttribute('data-mobile-navigation', 'true');
  await expect(shell).toHaveAttribute('data-sidebar-collapsed', 'false');
  await expect(page.locator('[data-role="toggle-sidebar-collapse"]')).toHaveCount(0);
  await expect(page.locator('[data-role="nav-item-tasks"]')).toHaveCount(0);

  const gridTemplateColumns = await shell.evaluate((element) => getComputedStyle(element).gridTemplateColumns);
  expect(gridTemplateColumns.split(' ').filter(Boolean)).toHaveLength(1);

  const trigger = page.locator('[data-role="toggle-mobile-navigation"]');
  await expect(trigger).toHaveAttribute('aria-label', 'Open navigation');
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');

  await openMobileNavigation(page);
  await expect(trigger).toHaveAttribute('aria-label', 'Close navigation');
  await expect(trigger).toHaveAttribute('aria-expanded', 'true');

  const sheet = page.locator('[data-role="mobile-navigation-sheet"]');
  for (const name of ['Tasks', 'Inbox', 'Agents', 'Chat', 'Sessions', 'Settings'] as const) {
    await expect(sheet.getByRole('button', { name })).toBeVisible();
  }

  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toBeFocused();

  await openMobileNavigation(page);
  await page.locator('[data-role="mobile-navigation-backdrop"]').click({ position: { x: 2, y: 2 } });
  await expect(sheet).toHaveCount(0);
  await expect(trigger).toHaveAttribute('aria-expanded', 'false');
});

test("mobile navigation closes after destination changes and keeps settings sub-navigation reachable", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");

  await openMobileNavigation(page);
  await page.getByRole('button', { name: 'Settings' }).click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Projects' })).toBeVisible();

  await openMobileNavigation(page);
  await page.getByRole('tab', { name: 'General' }).click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toHaveCount(0);
  await expect(page.getByRole('heading', { name: 'Theme' })).toBeVisible();

  await openMobileNavigation(page);
  await page.getByRole('button', { name: 'Tasks' }).click();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toHaveCount(0);
  await expect(page.locator('[data-role="new-task"]')).toBeVisible();
});


test("mobile overview topbar exposes the project switcher without opening the full navigation sheet", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });
  await page.setViewportSize({ width: 390, height: 844 });

  await page.goto("/");

  const trigger = page.locator('[data-role="mobile-topbar-project-switcher"] [data-role="project-switcher-trigger"]');
  await expect(page.locator('[data-role="mobile-topbar-brand"]')).toContainText('Orchestra');
  await expect(trigger).toBeVisible();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toHaveCount(0);

  await trigger.click();
  await expect(page.locator('[data-role="project-switcher-menu"]')).toBeVisible();
  await expect(page.locator('[data-role="mobile-navigation-sheet"]')).toHaveCount(0);
});

test("tasks page exposes the create flow through a bottom-right floating action button", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto('/');
  await page.getByRole('button', { name: 'Tasks' }).click();

  const fab = page.locator('[data-role="tasks-create-fab"]');
  const button = page.locator('[data-role="new-task"]');
  await expect(fab).toBeVisible();
  await expect(button).toBeVisible();

  const geometry = await page.evaluate(() => {
    const fab = document.querySelector('[data-role="tasks-create-fab"]');
    const button = document.querySelector('[data-role="new-task"]');
    if (!(fab instanceof HTMLElement) || !(button instanceof HTMLElement)) {
      return null;
    }
    const fabRect = fab.getBoundingClientRect();
    const buttonRect = button.getBoundingClientRect();
    return {
      fabRightInset: Math.round(window.innerWidth - fabRect.right),
      fabBottomInset: Math.round(window.innerHeight - fabRect.bottom),
      buttonWidth: Math.round(buttonRect.width),
      buttonHeight: Math.round(buttonRect.height),
    };
  });

  expect(geometry).not.toBeNull();
  expect(geometry?.fabRightInset ?? 999).toBeLessThanOrEqual(40);
  expect(geometry?.fabBottomInset ?? 999).toBeLessThanOrEqual(120);
  expect(geometry?.buttonWidth ?? 0).toBeGreaterThan(120);
  expect(geometry?.buttonHeight ?? 0).toBeGreaterThanOrEqual(48);

  await button.click();
  await expect(page.getByRole('heading', { name: 'New task' })).toBeVisible();
});
