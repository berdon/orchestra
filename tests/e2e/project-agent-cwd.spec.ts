import { expect, test } from "@playwright/test";

test("agent runtime cwd follows the active project's default repository path", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Project CWD Test");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="repository-name"]').fill("CWD Repo");
  await page.locator('[data-role="repository-local-path"]').fill("/tmp/project-cwd-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();
  await expect(page.locator('[data-role="project-repositories"]')).toContainText("/tmp/project-cwd-repo");

  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Project CWD Test" });

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();
  await page.locator('[data-role="open-agent-session"]').click();

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();
  await expect(page.getByText("Runtime cwd").locator("..")).toContainText("/tmp/project-cwd-repo");

  const runtimeState = await page.evaluate(() => {
    const runtimes = JSON.parse(window.localStorage.getItem("orchestra.mock.agent-runtimes") ?? "[]");
    return runtimes.find((runtime: { projectId: string; runtimeCwd?: string | null }) => runtime.projectId !== "orchestra") ?? null;
  });

  expect(runtimeState?.runtimeCwd).toBe("/tmp/project-cwd-repo");
});
