import { expect, test } from "@playwright/test";

test("hosted-web inbox reads and archives seeded Remote API mail", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-inbox"]').click();

  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText(
    "Hosted-web inbox message from the seeded Remote API fixture.",
  );
  await expect(page.locator('[data-role="inbox-attention-tasks"]')).toContainText("Hosted web review task");
  await expect(page.locator('[data-role="inbox-unread-count"]')).toContainText("1 unread");

  await page.locator('[data-role^="mark-inbox-read-"]').first().click();
  await expect(page.locator('[data-role="inbox-unread-count"]')).toContainText("0 unread");
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Read");

  await page.locator('[data-role^="archive-inbox-message-"]').first().click();
  await expect(page.locator('[data-role="user-inbox-messages"]')).not.toContainText(
    "Hosted-web inbox message from the seeded Remote API fixture.",
  );

  await page.locator('[data-role="inbox-filter-archived"]').click();
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText(
    "Hosted-web inbox message from the seeded Remote API fixture.",
  );
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Archived");
});
