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
  await page.locator('[data-role="repository-path"]').fill("/tmp/client-repo");
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

test("settings projects panel deletes a repository and falls back the project default cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.confirm = () => true;
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Repository Cleanup Project");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="repository-name"]').fill("First repo");
  await page.locator('[data-role="repository-path"]').fill("/tmp/first-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();

  await page.locator('[data-role="repository-name"]').fill("Second repo");
  await page.locator('[data-role="repository-path"]').fill("/tmp/second-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();

  await expect(page.locator('[data-role="project-repositories"]')).toContainText("First repo");
  await expect(page.locator('[data-role="project-repositories"]')).toContainText("Second repo");

  const secondRepoCard = page.locator('[data-role="project-repositories"] .task-history-card').filter({ hasText: "Second repo" });
  await secondRepoCard.getByRole("button", { name: "Make default" }).click();
  await secondRepoCard.getByRole("button", { name: "Delete repository" }).click();
  await expect(page.locator('[data-role="project-repositories"]')).not.toContainText("Second repo");

  const storedState = await page.evaluate(() => {
    const projects = JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]");
    return projects.find((project: { name: string }) => project.name === "Repository Cleanup Project") ?? null;
  });

  expect(storedState?.repositories?.length).toBe(1);
  expect(storedState?.repositories?.[0]?.name).toBe("First repo");
  expect(storedState?.defaultRepositoryId).toBe(storedState?.repositories?.[0]?.id ?? null);
});

test("settings projects panel deletes a non-default project and falls back cleanly", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();

  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Disposable Project");
  await page.getByRole("button", { name: /Create project/i }).click();
  await expect(page.getByRole("heading", { name: "Disposable Project" })).toBeVisible();

  await page.locator('[data-role="delete-project"]').click();
  await expect(page.locator('[data-role="delete-project"]')).toHaveText("Confirm delete");
  await page.locator('[data-role="delete-project"]').click();
  await expect(page.getByRole("heading", { name: "Orchestra" })).toBeVisible();
  await expect(page.locator('nav[aria-label="Projects"]')).not.toContainText("Disposable Project");

  const storedState = await page.evaluate(() => ({
    activeProjectId: window.localStorage.getItem("orchestra.mock.active-project-id"),
    projects: JSON.parse(window.localStorage.getItem("orchestra.mock.projects") ?? "[]"),
  }));

  expect(storedState.activeProjectId).toBe("orchestra");
  expect(storedState.projects.some((project: { name: string }) => project.name === "Disposable Project")).toBe(false);
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

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project one task");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project one task");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Second Project" });
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project one task");

  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Project two task");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project two task");
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project one task");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Orchestra" });
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Project one task");
  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Project two task");
});
