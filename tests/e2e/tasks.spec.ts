import { expect, test } from "@playwright/test";

test("tasks page creates and edits a persisted task in browser mode", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();

  await page.locator('[data-role="task-title"]').fill("Task foundation shell");
  await page.locator('[data-role="task-type"]').selectOption("feature");
  await page.locator('[data-role="task-status"]').selectOption("in_progress");
  await page.locator('[data-role="task-priority"]').selectOption("P1");
  await page.locator('[data-role="task-assignee-type"]').selectOption("role");
  await page.locator('[data-role="task-assignee-id"]').fill("developer");
  await page.locator('[data-role="task-description"]').fill("Create the first persisted Tasks surface.");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Task foundation shell" })).toBeVisible();
  await expect(page.locator(".task-list-link").first()).toContainText("Task foundation shell");

  await page.locator('[data-role="task-status"]').selectOption("in_review");
  await page.locator('[data-role="save-task"]').click();

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { title: string }) => task.title === "Task foundation shell") ?? null;
  });

  expect(storedState?.type).toBe("feature");
  expect(storedState?.status).toBe("in_review");
  expect(storedState?.priority).toBe("P1");
  expect(storedState?.assigneeType).toBe("role");
  expect(storedState?.assigneeId).toBe("developer");
});

test("tasks page creates subtasks and updates epic rollups", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("link", { name: /Define Orchestra task system/i }).click();
  await page.locator('[data-role="new-subtask"]').click();

  await page.locator('[data-role="task-title"]').fill("Add hierarchy badges");
  await page.locator('[data-role="task-type"]').selectOption("task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-priority"]').selectOption("P2");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Add hierarchy badges" })).toBeVisible();
  await expect(page.locator('[data-role="task-lineage"]')).toContainText("ORC-1");

  await page.getByRole("button", { name: /ORC-1/i }).click();
  await expect(page.getByRole("heading", { name: "Define Orchestra task system" })).toBeVisible();
  await expect(page.locator('[data-role="task-children"]')).toContainText("Add hierarchy badges");

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    const created = tasks.find((task: { title: string }) => task.title === "Add hierarchy badges") ?? null;
    const epic = tasks.find((task: { number: string }) => task.number === "ORC-1") ?? null;
    return { created, epic };
  });

  expect(storedState.created?.parentTaskId).toBe(storedState.epic?.id ?? null);
  expect(storedState.epic?.children?.length).toBeGreaterThanOrEqual(1);
});

test("tasks page adds dependencies and shows unblock flow", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Dependency target");
  await page.locator('[data-role="task-type"]').selectOption("task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-priority"]').selectOption("P2");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="dependency-blocker-select"]').selectOption({ label: "ORC-2 · Implement task foundation shell" });
  await page.locator('[data-role="add-dependency"]').click();

  await expect(page.locator('[data-role="task-blocked-by"]')).toContainText("ORC-2");
  await expect(page.getByText("Not dispatchable", { exact: true })).toBeVisible();

  await page.getByRole("link", { name: /Implement task foundation shell/i }).click();
  await page.locator('[data-role="task-status"]').selectOption("completed");
  await page.locator('[data-role="save-task"]').click();

  await page.getByRole("link", { name: /Dependency target/i }).click();
  await expect(page.getByText(/Dispatchable/i)).toBeVisible();

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    const target = tasks.find((task: { title: string }) => task.title === "Dependency target") ?? null;
    return target;
  });

  expect(storedState?.blockedBy?.length).toBe(1);
  expect(storedState?.dependencyBlocked).toBe(false);
});
