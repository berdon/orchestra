import { expect, test } from "@playwright/test";

async function triggerShortcut(page: import("@playwright/test").Page, key: string) {
  await page.evaluate((nextKey) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: nextKey, ctrlKey: true, bubbles: true }));
  }, key);
}

test("ctrl+o opens the command palette and can launch an agent session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Search · Ctrl+O" })).toBeVisible();
  await triggerShortcut(page, "o");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toBeVisible();

  await page.locator('[data-role="command-palette-input"]').fill("launch data session");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Sessions" })).toHaveClass(/nav-item--active/);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");
});

test("command palette stays usable and clears loading when one source hangs", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.evaluate(() => {
    const testWindow = window as Window & {
      __orchestraTestCommandPalette?: {
        hangSources?: string[];
        sourceTimeoutMs?: number;
      };
    };
    testWindow.__orchestraTestCommandPalette = {
      hangSources: ["roles"],
      sourceTimeoutMs: 50,
    };
  });

  await triggerShortcut(page, "o");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toBeVisible();
  await expect(page.locator('[data-role="command-palette-item"]').filter({ hasText: "Create task" }).first()).toBeVisible();
  await expect(page.getByText("Loading commands…")).toHaveCount(0);

  await page.locator('[data-role="command-palette-input"]').fill("create task");
  await page.keyboard.press("Enter");

  await expect(page.getByRole("button", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
});

test("command palette can open an agent terminal window", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.getByRole("button", { name: "Search · Ctrl+O" })).toBeVisible();
  await triggerShortcut(page, "o");
  await page.locator('[data-role="command-palette-input"]').fill("open data in terminal");

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.keyboard.press("Enter"),
  ]);

  await expect(page.locator('[data-role="session-terminal-readonly"]')).toBeVisible();
  await popup.waitForLoadState();
  await expect.poll(() => popup.url()).toContain("view=agent-terminal");
  await popup.close();
  await expect(page.locator('[data-role="session-terminal-readonly"]')).toHaveCount(0);
});

test("command palette can jump directly to a role definition", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Reviewer");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();
  await expect(page.getByRole("heading", { name: "Reviewer" })).toBeVisible();

  await page.getByRole("button", { name: "Sessions" }).click();
  await triggerShortcut(page, "o");
  await page.locator('[data-role="command-palette-input"]').fill("Architect");
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Architect" }).first().click();

  await expect(page.getByRole("tab", { name: "Roles" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Architect" })).toBeVisible();
});

test("command palette can open Harness settings", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "o");
  await page.locator('[data-role="command-palette-input"]').fill("harness");
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Open Settings → Harness" }).first().click();

  await expect(page.getByRole("tab", { name: "Harness" })).toHaveAttribute("aria-selected", "true");
  await expect(page.getByRole("heading", { name: "Harness settings" })).toBeVisible();
});

test("command palette can jump directly to a workflow definition", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "o");
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
  await triggerShortcut(page, "o");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toHaveCount(0);

  await triggerShortcut(page, "o");
  await page.locator('[data-role="command-palette-input"]').fill("create task");
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Create task" }).first().click();

  await expect(page.getByRole("button", { name: "Tasks", exact: true })).toBeVisible();
  await expect(page.getByRole("button", { name: "New task" })).toBeVisible();
  await page.getByRole("button", { name: "New task" }).click();
  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
});

test("ctrl+o can fuzzy-match a project and switch the active project", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Second Project");
  await page.getByRole("button", { name: /Create project/i }).click();

  await expect(page.locator('[data-role="project-switcher-trigger"]')).toContainText("Second Project");
  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project one task");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project one task");

  await triggerShortcut(page, "o");
  await page.locator('[data-role="command-palette-input"]').fill("snd prj");
  await expect(page.locator('[data-role="command-palette-item"]').filter({ hasText: "Switch to project Second Project" })).toBeVisible();
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Switch to project Second Project" }).first().click();

  await expect(page.locator('[data-role="project-switcher-trigger"]')).toContainText("Second Project");
  await expect(page.locator('[data-role="draft-task-section"]')).toHaveCount(0);

  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project two task");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project two task");
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project one task");

  await triggerShortcut(page, "o");
  await page.locator('[data-role="command-palette-input"]').fill("orch");
  await expect(page.locator('[data-role="command-palette-item"]').filter({ hasText: "Switch to project Orchestra" })).toBeVisible();
  await page.locator('[data-role="command-palette-item"]').filter({ hasText: "Switch to project Orchestra" }).first().click();

  await expect(page.locator('[data-role="project-switcher-trigger"]')).toContainText("Orchestra");
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project one task");
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project two task");
});

test("keyboard navigation scrolls the active command into view", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const tasks = Array.from({ length: 25 }, (_, index) => ({
      id: `task-${index + 1}`,
      projectId: "orchestra",
      number: `ORC-${index + 1}`,
      title: `Scrollable task ${index + 1}`,
      description: null,
      type: "task",
      status: "ready",
      priority: "P2",
      workflowId: null,
      currentLaneId: null,
      assigneeType: "unassigned",
      assigneeId: null,
      repositoryId: null,
      parentTaskId: null,
      archived: false,
      commentCount: 0,
      laneRunCount: 0,
      childCount: 0,
      completedChildCount: 0,
      inProgressChildCount: 0,
      blockedChildCount: 0,
      blockedByCount: 0,
      blockingCount: 0,
      attachmentCount: 0,
      dependencyBlocked: false,
      readyForDispatch: true,
      parent: null,
      lineage: [],
      children: [],
      blockedBy: [],
      blocking: [],
      attachments: [],
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
      laneRuns: [],
    }));
    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify(tasks));
  });

  await page.goto("/");
  await triggerShortcut(page, "o");
  await expect(page.locator('[data-role="command-palette-overlay"]')).toBeVisible();

  await page.locator('[data-role="command-palette-input"]').fill("scrollable task");
  for (let index = 0; index < 12; index += 1) {
    await page.keyboard.press("ArrowDown");
  }

  const scrollState = await page.evaluate(() => {
    const results = document.querySelector('[data-role="command-palette-results"]') as HTMLDivElement | null;
    const active = document.querySelector('[data-role="command-palette-item"][data-active="true"]') as HTMLButtonElement | null;
    if (!results || !active) {
      return null;
    }

    const resultsRect = results.getBoundingClientRect();
    const activeRect = active.getBoundingClientRect();
    return {
      scrollTop: results.scrollTop,
      activeWithinViewport: activeRect.top >= resultsRect.top && activeRect.bottom <= resultsRect.bottom,
    };
  });

  expect(scrollState).not.toBeNull();
  expect(scrollState?.scrollTop ?? 0).toBeGreaterThan(0);
  expect(scrollState?.activeWithinViewport).toBe(true);
});
