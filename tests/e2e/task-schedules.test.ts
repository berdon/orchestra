import { expect, test } from "@playwright/test";

function seedWorkflow() {
  const timestamp = new Date().toISOString();
  window.localStorage.setItem(
    "orchestra.mock.workflows",
    JSON.stringify([
      {
        id: "workflow-scheduled",
        slug: "scheduled-flow",
        name: "Scheduled Flow",
        description: "Flow used by scheduled task browser coverage.",
        archived: false,
        createdAt: timestamp,
        updatedAt: timestamp,
        lanes: [
          {
            id: "lane-plan",
            key: "plan",
            name: "Plan",
            description: null,
            order: 0,
            assignedEntityType: "user",
            assignedEntityId: null,
            entryPromptTemplate: "Plan scheduled work.",
            useSeparateWorktree: false,
            requireUserApprovalOnSuccess: false,
            successTransitionType: "end",
            successTargetLaneId: null,
            failureTransitionType: "end",
            failureTargetLaneId: null,
          },
        ],
      },
    ]),
  );
}

function utcDateTimeLocalValue(offsetMinutes: number) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

test("time-based scheduled tasks materialize fresh workflow tasks in browser mode", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-scheduled",
          slug: "scheduled-flow",
          name: "Scheduled Flow",
          description: "Flow used by scheduled task browser coverage.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-plan",
              key: "plan",
              name: "Plan",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Plan scheduled work.",
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
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
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-create-scheduled-toggle"]').check();

  await page.locator('[data-role="task-title"]').fill("Time schedule task");
  await page.locator('[data-role="task-description"]').fill("Created from a past-due time schedule.");
  await page.locator('[data-role="task-workflow"]').selectOption({ label: "Scheduled Flow" });
  await page.locator('[data-role="task-schedule-trigger-kind"]').selectOption("once");
  await page.locator('[data-role="task-schedule-trigger-at"]').fill(utcDateTimeLocalValue(-2));
  await page.locator('[data-role="create-task-schedule"]').click();

  await expect(page.getByRole("heading", { name: "Time schedule task" })).toBeVisible();
  await expect(page.locator('[data-role="task-schedule-materialized-tasks"]')).toContainText("Time schedule task");

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await expect(page.locator('[data-role="task-schedule-section"]')).toContainText("Time schedule task");
  await expect(page.locator('[data-role="task-card"]').filter({ hasText: "Time schedule task" })).toHaveCount(1);
});

test("event-triggered schedules can create another task for each matching event in browser mode", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-scheduled",
          slug: "scheduled-flow",
          name: "Scheduled Flow",
          description: "Flow used by scheduled task browser coverage.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-plan",
              key: "plan",
              name: "Plan",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Plan scheduled work.",
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
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
  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-create-scheduled-toggle"]').check();

  await page.locator('[data-role="task-title"]').fill("Generated follow-up");
  await page.locator('[data-role="task-description"]').fill("Spawned whenever another task is created.");
  await page.locator('[data-role="task-workflow"]').selectOption({ label: "Scheduled Flow" });
  await page.locator('[data-role="task-schedule-overlap-policy"]').selectOption("create_another");
  await page.locator('[data-role="task-schedule-trigger-type"]').selectOption("event");
  await page.locator('[data-role="task-schedule-trigger-event-key"]').fill("task.created");
  await page.locator('[data-role="create-task-schedule"]').click();

  await page.getByRole("button", { name: "Tasks", exact: true }).click();

  for (const seedTitle of ["Seed task one", "Seed task two"]) {
    await page.getByRole("button", { name: "New task" }).click();
    await page.locator('[data-role="task-title"]').fill(seedTitle);
    await page.locator('[data-role="task-description"]').fill(`Trigger ${seedTitle}`);
    await page.locator('[data-role="task-workflow"]').selectOption({ label: "Scheduled Flow" });
    await page.locator('[data-role="publish-task"]').click();
    await page.getByRole("button", { name: "Tasks", exact: true }).click();
  }

  await expect.poll(async () => page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]") as Array<{ title?: string }>;
    return tasks.filter((task) => task.title === "Generated follow-up").length;
  })).toBe(2);
});
