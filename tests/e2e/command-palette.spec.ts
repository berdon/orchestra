import { expect, test } from "@playwright/test";

async function triggerShortcut(page: import("@playwright/test").Page, key: string) {
  await page.evaluate((nextKey) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: nextKey, ctrlKey: true, bubbles: true }));
  }, key);
}

test("ctrl+p opens the command palette and can launch an agent session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "p");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toBeVisible();

  await page.locator('[data-role="command-palette-input"]').fill("launch data session");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Sessions" })).toHaveClass(/nav-item--active/);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");
});

test("command palette can jump directly to a role definition", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "p");
  await page.locator('[data-role="command-palette-input"]').fill("Reviewer");
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Reviewer" }).first().click();

  await expect(page.getByRole("tab", { name: "Roles" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Reviewer" })).toBeVisible();
});

test("command palette can jump directly to a workflow definition", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "p");
  await page.locator('[data-role="command-palette-input"]').fill("Development");
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Development" }).first().click();

  await expect(page.getByRole("tab", { name: "Workflows" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Development" })).toBeVisible();
});

test("command palette can open the new task flow and closes with escape", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "p");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toHaveCount(0);

  await triggerShortcut(page, "p");
  await page.locator('[data-role="command-palette-input"]').fill("create task");
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Create task" }).first().click();

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
});
