import { expect, test } from "@playwright/test";

test("hosted-web chat opens the seeded supervisor session through ensure-agent-session", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-chat"]').click();

  await page.getByRole("button", { name: /Supervisor/i }).click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="session-chat-panel"]')).toBeVisible();
});
