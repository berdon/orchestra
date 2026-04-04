import { expect, test } from "@playwright/test";

test("global and project-scoped agents are filtered by the selected project", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Client Project");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.getByRole("tab", { name: "Agents" }).click();
  await page.locator('[data-role="new-agent"]').click();
  await page.locator('[data-role="agent-name"]').fill("Global Architect");
  await page.locator('[data-role="agent-scope"]').selectOption("global");
  await page.locator('[data-role="save-agent"]').click();
  await expect(page.getByRole("heading", { name: "Global Architect" })).toBeVisible();
  await expect(page.locator('[data-role="agent-scope-badge"]')).toContainText("Global");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Client Project" });
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.locator('[data-role="new-agent"]').click();
  await page.locator('[data-role="agent-name"]').fill("Client Builder");
  await page.locator('[data-role="agent-scope"]').selectOption("project");
  await expect(page.locator('[data-role="agent-project-scope"]')).toHaveValue(/project-/);
  await page.locator('[data-role="save-agent"]').click();
  await expect(page.getByRole("heading", { name: "Client Builder" })).toBeVisible();
  await expect(page.locator('[data-role="agent-scope-badge"]')).toContainText("Project specific");

  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("link", { name: /Global Architect/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Client Builder/i })).toBeVisible();

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });
  await page.getByRole("button", { name: "Agents", exact: true }).click();
  await expect(page.getByRole("link", { name: /Global Architect/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Client Builder/i })).toHaveCount(0);

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Agents" }).click();
  await expect(page.getByRole("link", { name: /Global Architect/i })).toBeVisible();
  await expect(page.getByRole("link", { name: /Client Builder/i })).toHaveCount(0);

  await page.getByRole("link", { name: /Supervisor/i }).click();
  await expect(page.locator('[data-role="agent-scope"]')).toBeDisabled();
  await expect(page.locator('[data-role="agent-scope-badge"]')).toContainText("Global");
});
