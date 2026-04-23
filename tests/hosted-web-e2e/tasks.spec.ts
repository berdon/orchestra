import { expect, test } from "@playwright/test";

test("hosted-web tasks browse the seeded Remote API task list and open detail", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-tasks"]').click();

  const hostedTaskCard = page.locator('[data-role="task-card"]').filter({ hasText: "Hosted web seeded task" }).first();
  await expect(hostedTaskCard).toBeVisible();
  await expect(page.locator('[data-role="task-card"]').filter({ hasText: "Hosted web review task" }).first()).toBeVisible();

  await hostedTaskCard.click();
  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Hosted web seeded task");
  await expect(page.locator('[data-role="task-overview-description"]')).toContainText("Browser-hosted task coverage through the Remote API path.");
});
