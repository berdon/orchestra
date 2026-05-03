import { expect, test } from "@playwright/test";

test("github landing page exposes the required product story and public CTAs", async ({ page }) => {
  await page.goto("/github.html");

  await expect(page.locator('[data-role="github-landing-root"]')).toBeVisible();
  await expect(
    page.getByRole("heading", {
      name: /Run a company, organization, or project with customizable workflows, agents, and live human control\./,
    }),
  ).toBeVisible();

  await expect(page.locator('[data-role="github-hero-download"]')).toHaveAttribute("href", "https://hnsn.io/Orchestra.zip");
  await expect(page.locator('[data-role="github-hero-github"]')).toHaveAttribute("href", "https://github.com/berdon/orchestra");

  for (const copy of [
    "Custom workflows",
    "Projects with multi-repo support",
    "Persistent agents + ephemeral role sessions",
    "Supervisor control by natural language",
    "Pi underneath",
    "Rich permissions",
    "Telegram orchestration",
    "Feature-parity mobile experience",
    "Safe secret support",
  ]) {
    await expect(page.getByText(copy, { exact: true }).first()).toBeVisible();
  }

  await expect(page.locator('[data-role="github-proof-grid"] img')).toHaveCount(7);
  await expect(page.getByText("Real product surfaces, not invented mockups")).toBeVisible();
  await expect(page.getByText("Completely customizable kanban-style flows")).toBeVisible();
});

test("github landing page stays within the mobile viewport", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto("/github.html");

  await expect(page.locator('[data-role="github-landing-root"]')).toBeVisible();
  await expect(page.locator('[data-role="github-hero-download-secondary"]')).toBeVisible();

  const viewportWidth = page.viewportSize()?.width ?? 390;
  await expect.poll(() => page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(viewportWidth);
});
