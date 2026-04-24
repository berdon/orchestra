import { expect, test } from "@playwright/test";

test("hosted-web settings load and save global source-control defaults through the remote API", async ({ page }) => {
  await page.goto("/");
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.locator('[data-role="settings-tab-source_control"]').click();

  const userNameTemplate = page.locator('[data-role="source-control-git-user-name-template"]');
  const emailTemplate = page.locator('[data-role="source-control-git-email-template"]');
  await expect(userNameTemplate).toBeVisible();
  await expect(page.locator('[data-role="source-control-preview-table"]')).toBeVisible();

  await userNameTemplate.click();
  await userNameTemplate.pressSequentially("Hosted Web {role}");
  await expect(userNameTemplate).toHaveValue("Hosted Web {role}");

  await emailTemplate.click();
  await emailTemplate.pressSequentially("hosted-web+{agent}@example.test");
  await expect(userNameTemplate).toHaveValue("Hosted Web {role}");
  await expect(emailTemplate).toHaveValue("hosted-web+{agent}@example.test");

  await page.locator('[data-role="save-source-control-settings"]').click();

  await expect(userNameTemplate).toHaveValue("Hosted Web {role}");
  await expect(emailTemplate).toHaveValue("hosted-web+{agent}@example.test");
  await expect(page.locator('[data-role="source-control-preview-table"]')).toContainText("Hosted Web");
});
