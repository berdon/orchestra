import { expect, test } from "@playwright/test";

test("settings projects panel creates a project and repository", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Client Work");
  await page.locator('[data-role="project-description"]').fill("A separate customer-facing project.");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="repository-name"]').fill("Client repo");
  await page.locator('[data-role="repository-local-path"]').fill("/tmp/client-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();

  await expect(page.locator('[data-role="project-repositories"]')).toContainText("Client repo");

  const storedState = await page.evaluate(() => {
    const projects = JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]");
    return projects.find((project: { name: string }) => project.name === "Client Work") ?? null;
  });

  expect(storedState?.repositories?.length).toBe(1);
  expect(storedState?.repositories?.[0]?.name).toBe("Client repo");
});

test("project switcher isolates browser-mode task state by project", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Second Project");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project one task");
  await page.locator('[data-role="save-task"]').click();
  await expect(page.locator('.task-list')).toContainText("Project one task");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Second Project" });
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('.task-list')).not.toContainText("Project one task");

  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project two task");
  await page.locator('[data-role="save-task"]').click();
  await expect(page.locator('.task-list')).toContainText("Project two task");
  await expect(page.locator('.task-list')).not.toContainText("Project one task");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('.task-list')).toContainText("Project one task");
  await expect(page.locator('.task-list')).not.toContainText("Project two task");
});
