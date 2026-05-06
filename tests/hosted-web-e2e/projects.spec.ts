import { expect, test } from "@playwright/test";

import { pairHostedWebBrowser } from "./helpers";

function slugify(value: string) {
  return (
    value
      .trim()
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "project"
  );
}

test.beforeEach(async ({ page }) => {
  await pairHostedWebBrowser(page);
});

async function expectProjectSectionLoaded(page: { locator: (selector: string) => any }, sectionId: "automation" | "source-control" | "secrets", panelSelector: string, readySelector: string) {
  await page.locator('[data-role="project-detail-section-select-control"]').selectOption(sectionId);
  await expect(page.locator(panelSelector)).toBeVisible();
  await expect(page.locator(readySelector)).toBeVisible();
  await expect(page.locator(panelSelector)).not.toContainText("Loading");
}

test("hosted-web mobile project settings load project-scoped tabs and clear refreshing states", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/?page=settings&settingsTab=projects");

  await expect(page.locator('[data-role="project-mobile-subnav-shell"]')).toBeVisible();
  await expect(page.locator('.settings-mobile-subnav-panel')).toBeHidden();
  await expect(page.locator('[data-role="project-detail-tabpanel-general"]')).toBeVisible();

  await expectProjectSectionLoaded(
    page,
    "automation",
    '[data-role="project-detail-tabpanel-automation"]',
    '[data-role="project-automation-settings"]',
  );
  await expect(page.locator('[data-role="project-automation-load-error"]')).toHaveCount(0);

  await expectProjectSectionLoaded(
    page,
    "source-control",
    '[data-role="project-detail-tabpanel-source-control"]',
    '[data-role="project-source-control-settings"]',
  );
  await expect(page.locator('[data-role="project-source-control-load-error"]')).toHaveCount(0);

  await expectProjectSectionLoaded(
    page,
    "secrets",
    '[data-role="project-detail-tabpanel-secrets"]',
    '[data-role="project-secrets-status"]',
  );
  await expect(page.locator('[data-role="project-secrets-load-error"]')).toHaveCount(0);
});

test("hosted-web project creation makes the new project immediately selectable in the project switcher", async ({
  page,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const projectName = `Hosted Web Fresh ${suffix}`;
  const projectSlug = slugify(projectName);

  await page.goto("/");
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill(projectName);
  await page
    .locator('[data-role="project-task-prefix"]')
    .fill(`HW${suffix.slice(-3)}`);
  await page
    .locator('[data-role="project-description"]')
    .fill("Hosted-web regression coverage for switcher invalidation.");
  await page.getByRole("button", { name: /Create project/i }).click();

  await expect(page.getByRole("heading", { name: projectName })).toBeVisible();

  await page.locator('[data-role="project-switcher-trigger"]').click();
  await expect(
    page.locator(`[data-role="project-switcher-option-${projectSlug}"]`),
  ).toBeVisible();
  await page
    .locator(`[data-role="project-switcher-option-${projectSlug}"]`)
    .click();

  await expect(
    page.locator('[data-role="project-switcher-trigger"]'),
  ).toContainText(projectName);
});

test("hosted-web project rename updates the project switcher immediately", async ({
  page,
}) => {
  const suffix = Date.now().toString().slice(-6);
  const originalProjectName = `Hosted Web Rename ${suffix}`;
  const originalProjectSlug = slugify(originalProjectName);
  const renamedProjectName = `${originalProjectName} Updated`;
  const renamedProjectSlug = slugify(renamedProjectName);

  await page.goto("/");
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill(originalProjectName);
  await page
    .locator('[data-role="project-task-prefix"]')
    .fill(`HR${suffix.slice(-3)}`);
  await page
    .locator('[data-role="project-description"]')
    .fill("Hosted-web regression coverage for project rename refresh.");
  await page.getByRole("button", { name: /Create project/i }).click();

  await expect(
    page.getByRole("heading", { name: originalProjectName }),
  ).toBeVisible();
  await page.locator('[data-role="project-switcher-trigger"]').click();
  await expect(
    page.locator(
      `[data-role="project-switcher-option-${originalProjectSlug}"]`,
    ),
  ).toBeVisible();
  await page
    .locator(`[data-role="project-switcher-option-${originalProjectSlug}"]`)
    .click();
  await expect(
    page.locator('[data-role="project-switcher-trigger"]'),
  ).toContainText(originalProjectName);

  await page.locator('[data-role="project-detail-tab-general"]').click();
  await page.locator('[data-role="project-name"]').fill(renamedProjectName);
  await page.getByRole("button", { name: /Save project/i }).click();

  await expect(
    page.getByRole("heading", { name: renamedProjectName }),
  ).toBeVisible();
  await expect(
    page.locator('[data-role="project-switcher-trigger"]'),
  ).toContainText(renamedProjectName);

  await page.locator('[data-role="project-switcher-trigger"]').click();
  await expect(
    page.locator(`[data-role="project-switcher-option-${renamedProjectSlug}"]`),
  ).toBeVisible();
  await expect(
    page.locator(
      `[data-role="project-switcher-option-${originalProjectSlug}"]`,
    ),
  ).toHaveCount(0);
});
