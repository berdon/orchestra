import { expect, test } from "@playwright/test";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=";

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
  await page.locator('[data-role="task-assignee-type"]').selectOption("agent");
  await expect(page.locator('[data-role="task-assignee-id"]')).toContainText("Data");
  await page.locator('[data-role="task-assignee-type"]').selectOption("role");
  await expect(page.locator('[data-role="task-assignee-id"]')).toContainText("Developer");
  await page.locator('[data-role="task-assignee-id"]').selectOption("developer");
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

test("tasks page uploads text and image attachments", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Attachment target");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="task-attachment-input"]').setInputFiles([
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Attachment preview text"),
    },
    {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    },
  ]);

  await expect(page.locator('[data-role="task-attachments"]')).toContainText("notes.txt");
  await expect(page.locator('[data-role="task-attachments"]')).toContainText("pixel.png");
  await expect(page.locator('.task-attachment-card__text')).toContainText("Attachment preview text");
  await expect(page.locator('.task-attachment-card__image')).toHaveCount(1);

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { title: string }) => task.title === "Attachment target") ?? null;
  });

  expect(storedState?.attachments?.length).toBe(2);
  expect(storedState?.attachmentCount).toBe(2);
});

test("tasks page adds comments and records interrupt intent", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("link", { name: /Implement task foundation shell/i }).click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Pause and re-check the task context before you continue.");
  await page.locator('[data-role="task-comment-interrupt"]').check();
  await page.locator('[data-role="add-task-comment"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Interrupt requested");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Pause and re-check the task context before you continue.");

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { title: string }) => task.title === "Implement task foundation shell") ?? null;
  });

  expect(storedState?.comments?.some((comment: { author: string; interruptAgent: boolean }) => comment.author === "Reviewer" && comment.interruptAgent)).toBe(true);
});

test("tasks page dispatches a role-owned lane and completes it into the next workflow lane", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("link", { name: /Implement task foundation shell/i }).click();

  await page.locator('[data-role="dispatch-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("developer");

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.getByText("Not dispatchable", { exact: true })).toBeVisible();

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { title: string }) => task.title === "Implement task foundation shell") ?? null;
  });

  expect(storedState?.activeLaneAssignment).toBeNull();
  expect(storedState?.status).toBe("in_review");
});

test("tasks page dispatches an agent-owned lane and completes the workflow", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-agent",
          slug: "agent-flow",
          name: "Agent Flow",
          description: "Single agent-owned lane.",
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lanes: [
            {
              id: "lane-agent",
              key: "agent",
              name: "Agent",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: "data",
              entryPromptTemplate: "Do the work.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify([]));
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Agent dispatched task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="dispatch-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("agent");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("data");

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);

  const storedState = await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { title: string }) => task.title === "Agent dispatched task") ?? null;
  });

  expect(storedState?.status).toBe("completed");
  expect(storedState?.activeLaneAssignment).toBeNull();
});

test("tasks page exposes a review inbox filter and attention queue", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await page.locator('[data-role="task-title"]').fill("Review me");
  await page.locator('[data-role="task-status"]').selectOption("in_review");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.locator('[data-role="task-attention-queue"]')).toContainText("Review me");
  await page.locator('[data-role="task-filter-attention"]').click();
  await expect(page.locator('.task-list')).toContainText("Review me");
  await expect(page.locator('.task-list')).toContainText("Plan hierarchy rollups");

  await page.locator('[data-role="task-filter-review"]').click();
  await expect(page.locator('.task-list')).toContainText("Review me");
  await expect(page.locator('.task-list')).not.toContainText("Plan hierarchy rollups");

  await page.locator('[data-role="task-filter-blocked"]').click();
  await expect(page.locator('.task-list')).toContainText("Plan hierarchy rollups");
});

test("tasks page shows a chronological activity timeline", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("link", { name: /Implement task foundation shell/i }).click();

  await expect(page.locator('[data-role="task-timeline"]')).toContainText("User commented");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Lane");

  await page.locator('[data-role="task-attachment-input"]').setInputFiles({
    name: "timeline.txt",
    mimeType: "text/plain",
    buffer: Buffer.from("Timeline attachment"),
  });

  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Attachment added: timeline.txt");
});
