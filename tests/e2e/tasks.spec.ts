import { expect, test } from "@playwright/test";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=";

test("tasks overview creates a draft task and opens dedicated detail/create pages", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await page.locator('[data-role="task-title"]').fill("Draft board task");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Draft board task" })).toBeVisible();
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft board task");

  await page.locator('[data-role="task-card"]').filter({ hasText: "Draft board task" }).first().click();
  await expect(page.getByRole("heading", { name: "Draft board task" })).toBeVisible();
});

test("tasks overview shows workflow sections with compact cards and supports subtasks", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Development");
  await page.locator('[data-role="task-card"]').filter({ hasText: "Define Orchestra task system" }).first().click();
  await page.locator('[data-role="new-subtask"]').click();

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await page.locator('[data-role="task-title"]').fill("Add hierarchy badges");
  await page.locator('[data-role="task-type"]').selectOption("task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-priority"]').selectOption("P2");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Add hierarchy badges" })).toBeVisible();
  await expect(page.locator('[data-role="task-lineage"]')).toContainText("ORC-1");
});

test("task detail manages dependencies and blocked state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Dependency target");
  await page.locator('[data-role="task-type"]').selectOption("task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-priority"]').selectOption("P2");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="dependency-blocker-select"]').selectOption({ label: "ORC-2 · Implement task foundation shell" });
  await page.locator('[data-role="add-dependency"]').click();

  await expect(page.locator('[data-role="task-blocked-by"]')).toContainText("ORC-2");
  await expect(page.getByText("Not dispatchable", { exact: true })).toBeVisible();
});

test("task detail supports attachments, comments, timeline, and review inbox filtering", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

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

  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Pause and re-check the task context before you continue.");
  await page.locator('[data-role="task-comment-interrupt"]').check();
  await page.locator('[data-role="add-task-comment"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Interrupt requested");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Attachment added: notes.txt");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Reviewer commented");

  await page.getByRole("button", { name: "Back to tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Review me");
  await page.locator('[data-role="task-status"]').selectOption("in_review");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Back to tasks" }).click();

  await page.locator('[data-role="task-filter-attention"]').click();
  await expect(page.locator('[data-role="task-attention-queue"]')).toContainText("Review me");
  await page.locator('[data-role="task-filter-review"]').click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Review me");
});

test("task detail dispatches a role-owned lane and completes it into the next workflow lane", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.locator('[data-role="dispatch-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("developer");

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.getByText("Not dispatchable", { exact: true })).toBeVisible();
});

test("task detail dispatches an agent-owned lane and completes the workflow", async ({ page }) => {
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
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Agent dispatched task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="dispatch-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("agent");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("lane-agent");

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);
  await expect(page.locator('[data-role="task-timeline"]')).toContainText('Lane lane-agent completed');
});


test("dispatching a role-owned task surfaces the spawned runtime session in the Sessions list", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Sessions" }).click();
  const previousSessionCount = await page.locator('[data-role="session-link"]').count();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();
  await page.locator('[data-role="dispatch-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role");

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(previousSessionCount + 1);
});


test("dispatching an agent-owned task reuses the agent main session instead of spawning a duplicate", async ({ page }) => {
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
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Sessions" }).click();
  const initialSessionCount = await page.locator('[data-role="session-link"]').count();

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();
  await page.locator('[data-role="open-agent-session"]').click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(initialSessionCount + 1);

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Agent session reuse task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="dispatch-task-lane"]').click();

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(initialSessionCount + 1);

  const sessionCounts = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.filter((session: { title: string }) => session.title === "Data main session").length;
  });

  expect(sessionCounts).toBe(1);
});

test("task detail refreshes from backend task-change events without waiting on polling", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Implement task foundation shell");
    if (!target) {
      throw new Error("Expected seeded task was not found");
    }
    target.title = "Updated from backend event";
    target.updatedAt = new Date().toISOString();
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(
      new CustomEvent("orchestra:task-change", {
        detail: {
          taskIds: [target.id],
          reason: "task.updated",
        },
      }),
    );
  });

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Updated from backend event");
});
