import { expect, test } from "@playwright/test";

test("orchestration setup creates project, workflow, roles, and automatically advances a ticket through the full flow", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  // Create a dedicated project and repository.
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("button", { name: "New project" }).click();
  await page.locator('[data-role="project-name"]').fill("Automation Project");
  await page.locator('[data-role="project-description"]').fill("End-to-end workflow automation test project.");
  await page.getByRole("button", { name: /Create project/i }).click();

  await page.locator('[data-role="repository-name"]').fill("Automation Repo");
  await page.locator('[data-role="repository-local-path"]').fill("/tmp/orchestra-automation-repo");
  await page.locator('[data-role="repository-default-branch"]').fill("main");
  await page.locator('[data-role="add-repository"]').click();
  await expect(page.locator('[data-role="project-repositories"]')).toContainText("Automation Repo");

  // Switch the app into the new project context.
  await page.locator('[data-role="project-switcher"]').selectOption({ label: "Automation Project" });

  // Create the Architect role.
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Architect");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();
  await expect(page.getByRole("heading", { name: "Architect" })).toBeVisible();

  // Create the Developer role.
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Developer");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();
  await expect(page.getByRole("heading", { name: "Developer" })).toBeVisible();

  // Create the QA role.
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("QA");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();
  await expect(page.getByRole("heading", { name: "QA" })).toBeVisible();

  // Create the development workflow.
  await page.getByRole("tab", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Workflow name").fill("Development Automation");
  await page.getByLabel("Lane name").fill("Plan");
  await page.getByLabel("Lane key").fill("plan");
  await page.locator('[data-role="lane-owner-type"]').selectOption("role");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("architect");

  await page.getByRole("button", { name: "Add lane" }).click();
  await page.locator('.workflow-board-lane').nth(1).click();
  await page.getByLabel("Lane name").fill("Implement");
  await page.getByLabel("Lane key").fill("implement");
  await page.locator('[data-role="lane-owner-type"]').selectOption("role");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("developer");

  await page.getByRole("button", { name: "Add lane" }).click();
  await page.locator('.workflow-board-lane').nth(2).click();
  await page.getByLabel("Lane name").fill("Validate");
  await page.getByLabel("Lane key").fill("validate");
  await page.locator('[data-role="lane-owner-type"]').selectOption("role");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("qa");

  await page.getByRole("button", { name: "Add lane" }).click();
  await page.locator('.workflow-board-lane').nth(3).click();
  await page.getByLabel("Lane name").fill("User Review");
  await page.getByLabel("Lane key").fill("user-review");
  await page.locator('[data-role="lane-owner-type"]').selectOption("user");

  await page.locator('[data-role="save-workflow"]').click();
  await expect(page.getByRole("heading", { name: "Development Automation" })).toBeVisible();

  // Create a task that represents creating /tmp/file.md.
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Create /tmp/file.md");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-workflow"]').selectOption({ label: "Development Automation" });
  await page.locator('[data-role="task-description"]').fill("Create the temporary markdown file /tmp/file.md as part of workflow automation validation.");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Create /tmp/file.md" })).toBeVisible();

  // Walk the task through the full automated workflow.
  await page.locator('[data-role="dispatch-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role · architect");
  await page.locator('[data-role="complete-task-success"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role · developer");
  await page.locator('[data-role="complete-task-success"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role · qa");
  await page.locator('[data-role="complete-task-success"]').click();

  // Final user review lane should be ready for explicit user completion.
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);
  await page.locator('[data-role="complete-task-success"]').click();

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Create /tmp/file.md");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Lane");

  // Validate project-scoped mock state captured the whole orchestration path.
  const storedState = await page.evaluate(() => {
    const activeProjectId = window.localStorage.getItem("orchestra.mock.active-project-id");
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    const roles = JSON.parse(window.localStorage.getItem("orchestra.mock.roles") ?? "[]");
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    const sessions = JSON.parse(window.localStorage.getItem(`orchestra.mock.sessions.${activeProjectId}`) ?? "[]");

    return {
      activeProjectId,
      workflow: workflows.find((workflow: { name: string }) => workflow.name === "Development Automation") ?? null,
      roleSlugs: roles.map((role: { slug: string }) => role.slug).sort(),
      task: tasks.find((task: { title: string; projectId: string }) => task.title === "Create /tmp/file.md" && task.projectId === activeProjectId) ?? null,
      relevantSessions: sessions.filter((session: { title: string }) =>
        ["Plan · Create /tmp/file.md", "Implement · Create /tmp/file.md", "Validate · Create /tmp/file.md", "User Review · Create /tmp/file.md"].includes(session.title),
      ),
    };
  });

  expect(storedState.activeProjectId).toBeTruthy();
  expect(storedState.roleSlugs).toEqual(expect.arrayContaining(["architect", "developer", "qa"]));
  expect(storedState.workflow?.lanes?.map((lane: { name: string; assignedEntityType: string; assignedEntityId: string | null }) => ({
    name: lane.name,
    assignedEntityType: lane.assignedEntityType,
    assignedEntityId: lane.assignedEntityId,
  }))).toEqual([
    { name: "Plan", assignedEntityType: "role", assignedEntityId: "architect" },
    { name: "Implement", assignedEntityType: "role", assignedEntityId: "developer" },
    { name: "Validate", assignedEntityType: "role", assignedEntityId: "qa" },
    { name: "User Review", assignedEntityType: "user", assignedEntityId: null },
  ]);
  expect(storedState.task?.status).toBe("completed");
  expect(storedState.task?.currentLaneId).toBeNull();
  expect(storedState.task?.laneRuns).toHaveLength(3);
  expect(storedState.task?.laneRuns?.map((laneRun: { result: string }) => laneRun.result)).toEqual([
    "success",
    "success",
    "success",
  ]);
  expect(storedState.relevantSessions.length).toBeGreaterThanOrEqual(1);
});
