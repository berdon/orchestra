import { expect, test } from "@playwright/test";

test("settings roles panel creates a role with supervisor access and direct permissions", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await expect(page.getByText("Built-in roles are editable like any other role.")).toHaveCount(0);
  await expect(page.locator('[data-role="new-role"]')).toBeVisible();
  await page.locator('[data-role="new-role"]').click();

  await page.locator('[data-role="role-name"]').fill("Operator");
  await page.getByLabel("Capacity").fill("2");
  await page.locator('[data-role="role-detail-tab-access"]').click();
  await page.locator('[data-role="role-supervisor-toggle"]').check();
  await page.locator('[data-role="role-permission-sessions.message"]').check();
  await page.locator('[data-role="save-role"]').click();

  await expect(page.getByRole("heading", { name: "Operator" })).toBeVisible();
  await expect(page.locator('[data-role="role-effective-access"]')).toContainText("Full access");
  await expect(page.locator('[data-role="role-selected-permission-sessions.message"]')).toBeVisible();

  const storedRole = await page.evaluate(() => {
    const roles = JSON.parse(window.localStorage.getItem("orchestra.mock.roles") ?? "[]");
    return roles.find((role: { name: string }) => role.name === "Operator") ?? null;
  });

  expect(storedRole?.slug).toBe("operator");
  expect(storedRole?.capacity).toBe(2);
  expect(storedRole?.policyIds).toContain("policy-supervisor");
  expect(storedRole?.directPermissions).toContain("sessions.message");
});
