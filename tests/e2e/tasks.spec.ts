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
  await expect(page.locator('[data-role="task-status"]')).toHaveCount(0);
  await page.locator('[data-role="task-title"]').fill("Draft board task");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Draft board task" })).toBeVisible();
  await expect(page.locator('[data-role="publish-task"]')).toBeVisible();
  await page.getByRole("button", { name: "Back to tasks" }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft board task");

  await page.locator('[data-role="task-card"]').filter({ hasText: "Draft board task" }).first().click();
  await expect(page.getByRole("heading", { name: "Draft board task" })).toBeVisible();
});

test("tasks overview hides empty inbox, hides done lanes, and supports done filtering in card and table views", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-simple",
          slug: "simple",
          name: "Simple Flow",
          description: "Single implementation lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Build it.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-active",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Visible lane task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-simple",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
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
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-done",
          projectId: "orchestra",
          number: "ORC-2",
          title: "Completed task",
          description: null,
          type: "task",
          status: "completed",
          priority: "P2",
          workflowId: "workflow-simple",
          currentLaneId: null,
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          laneRunCount: 1,
          childCount: 0,
          completedChildCount: 0,
          inProgressChildCount: 0,
          blockedChildCount: 0,
          blockedByCount: 0,
          blockingCount: 0,
          attachmentCount: 0,
          dependencyBlocked: false,
          readyForDispatch: false,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="task-attention-section"]')).toHaveCount(0);
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Simple Flow");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Done");
  await expect(page.locator('[data-role="task-filter-done"]')).toBeVisible();

  await page.locator('[data-role="task-filter-done"]').click();
  await expect(page.locator('[data-role="workflow-done-grid"]')).toContainText("Completed task");

  await page.locator('[data-role="task-view-table"]').click();
  await expect(page.locator('[data-role="task-table"]')).toContainText("Completed task");
  await expect(page.locator('[data-role="task-table-row"]')).toContainText("Simple Flow");
  await expect(page.locator('[data-role="task-table-row"]')).toContainText("0");
  await expect(page.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () =>
    page.evaluate(() => window.localStorage.getItem("orchestra.preferences.task-board-view-mode"))
  ).toBe("table");

  const secondPage = await page.context().newPage();
  await secondPage.goto("/");
  await secondPage.getByRole("button", { name: "Tasks" }).click();
  await secondPage.locator('[data-role="task-filter-done"]').click();
  await expect(secondPage.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect(secondPage.locator('[data-role="task-table"]')).toContainText("Completed task");
  await secondPage.close();
});

test("task detail manages dependencies and blocked state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Dependency target");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="task-detail-tab-dependencies"]').click();
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

  await page.locator('[data-role="task-detail-tab-attachments"]').click();
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

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Pause and re-check the task context before you continue.");
  await page.locator('[data-role="task-comment-interrupt"]').check();
  await page.locator('[data-role="add-task-comment"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Interrupt requested");

  await page.locator('[data-role="reply-task-comment"]').first().click();
  await page.locator('[data-role="task-reply-author"]').fill("Worker");
  await page.locator('[data-role="task-reply-message"]').fill("I checked the task context and updated the plan.");
  await page.locator('[data-role="add-task-reply"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Worker");
  await expect(page.locator('[data-role="task-comment-reply"]')).toContainText("I checked the task context and updated the plan.");

  await page.locator('[data-role="task-detail-tab-timeline"]').click();
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Attachment added: notes.txt");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Reviewer commented");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Worker replied");

  await page.getByRole("button", { name: "Back to tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Review me");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="task-status"]').selectOption("in_review");
  await page.locator('[data-role="save-task"]').click();
  await page.getByRole("button", { name: "Back to tasks" }).click();

  await page.locator('[data-role="task-filter-attention"]').click();
  await expect(page.locator('[data-role="task-attention-queue"]')).toContainText("Review me");
  await page.locator('[data-role="task-filter-review"]').click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Review me");
});

test("task detail retries a role-owned lane and completes it into the next workflow lane", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await expect(page.locator('[data-role="retry-task-lane"]')).toBeVisible();
  await page.locator('[data-role="retry-task-lane"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("developer");

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.getByText("Not dispatchable", { exact: true })).toBeVisible();
});

test("task detail shows completion controls when user involvement is pending", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.locator('[data-role="dispatch-task-lane"]').click();
  await page.locator('[data-role="complete-task-needs-user"]').click();

  await expect(page.locator('[data-role="complete-task-success"]')).toBeVisible();
  await expect(page.locator('[data-role="complete-task-failure"]')).toBeVisible();
});

test("task detail dispatches an agent-owned task via publish, retries the active session, and completes the workflow", async ({ page }) => {
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
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="publish-task"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("agent");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("lane-agent");
  await expect(page.locator('[data-role="retry-task-lane"]')).toBeVisible();

  await page.locator('[data-role="retry-task-lane"]').click();
  await expect.poll(async () =>
    page.evaluate(() => {
      const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
      return sessions.some((session: { events?: Array<{ message?: string }> }) =>
        (session.events ?? []).some((event) => event.message?.includes("Keep working this ticket")),
      );
    }), { timeout: 10_000 }
  ).toBe(true);

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);
  await page.locator('[data-role="task-detail-tab-timeline"]').click();
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Lane lane-agent completed");
});

test("task detail requires a hold before delete and confirms removal in a modal", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Delete me");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="delete-task"]').dispatchEvent("pointerdown", { pointerType: "mouse" });
  await page.waitForTimeout(2100);
  await page.locator('[data-role="delete-task"]').dispatchEvent("pointerup", { pointerType: "mouse" });

  await expect(page.locator('[data-role="task-delete-confirm"]')).toBeVisible();
  await page.locator('[data-role="confirm-delete-task"]').click();

  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Delete me");
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
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="publish-task"]').click();

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
