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
