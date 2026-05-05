import { expect, test } from "@playwright/test";

test("workflow lanes persist stable global worker references by slug", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Workflows" }).click();

  await expect(page.getByText("Orchestra includes ready-to-use Product Strategy, Planning, and Development workflows on first install. They're regular workflow records, so you can edit, duplicate, archive, or permanently delete them when nothing else still references them.")).toHaveCount(0);
  await expect(page.getByRole("link", { name: "Development" })).toBeVisible();

  const seededWorkflowRefs = await page.evaluate(() => {
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    const development = workflows.find((workflow: { name: string }) => workflow.name === "Development");
    return development?.lanes?.map((lane: { assignedEntityId: string | null }) => lane.assignedEntityId) ?? [];
  });

  expect(seededWorkflowRefs).toContain("architect");
  expect(seededWorkflowRefs).toContain("senior-developer");
  expect(seededWorkflowRefs).toContain("qa");
  expect(seededWorkflowRefs).not.toContain("developer-role");

  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Workflow name").fill("Agent Driven Flow");
  await page.locator('[data-role="workflow-detail-tab-lane"]').click();
  await page.getByLabel("Lane name").fill("Implement");
  await page.getByLabel("Lane key").fill("implement");
  await page.locator('[data-role="lane-owner-type"]').selectOption("agent");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("data");
  await page.locator('[data-role="lane-use-separate-worktree"]').check();
  await page.locator('[data-role="lane-success-review-required"]').check();
  await page.locator('[data-role="save-workflow"]').click();

  await expect(page.getByRole("heading", { name: "Agent Driven Flow" })).toBeVisible();

  const savedLane = await page.evaluate(() => {
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    const created = workflows.find((workflow: { name: string }) => workflow.name === "Agent Driven Flow");
    return created?.lanes?.[0] ?? null;
  });

  expect(savedLane?.assignedEntityId).toBe("data");
  expect(savedLane?.useSeparateWorktree).toBe(true);
  expect(savedLane?.requireUserApprovalOnSuccess).toBe(true);

  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete Agent Driven Flow?" })).toBeVisible();
  await expect(page.getByText("This permanently deletes the workflow definition and its lanes. This cannot be undone.")).toBeVisible();
  await page.getByRole("button", { name: "Delete workflow" }).click();

  await expect(page.getByRole("link", { name: "Agent Driven Flow" })).toHaveCount(0);
  const remainingWorkflows = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]"));
  expect(remainingWorkflows.some((workflow: { name: string }) => workflow.name === "Agent Driven Flow")).toBe(false);

  await page.getByRole("link", { name: "Development" }).click();
  await page.getByRole("button", { name: "Delete" }).click();
  await expect(page.getByRole("heading", { name: "Delete Development?" })).toBeVisible();
  await expect(page.getByText("This workflow is still referenced and cannot be permanently deleted safely.")).toBeVisible();
  await expect(page.locator('[data-role="workflow-delete-impact-list"]')).toContainText("Tasks: 3");
  await expect(page.getByRole("button", { name: "Delete workflow" })).toHaveCount(0);
});

test("workflow settings only show Needs Work routing for approval-gated lanes and persist the selection", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Workflows" }).click();
  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Workflow name").fill("Review Routing Flow");
  await page.locator('[data-role="workflow-detail-tab-lane"]').click();
  await page.getByLabel("Lane name").fill("Implement");
  await page.getByLabel("Lane key").fill("implement");
  await page.locator('[data-role="lane-owner-type"]').selectOption("role");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("senior-developer");
  await expect(page.locator('[data-role="lane-needs-work-target"]')).toHaveCount(0);

  await page.getByRole("button", { name: "Add lane" }).click();
  await page.locator('.workflow-board-lane').nth(1).click();
  await page.getByLabel("Lane name").fill("Fix");
  await page.getByLabel("Lane key").fill("fix");
  await page.locator('[data-role="lane-owner-type"]').selectOption("role");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("senior-developer");

  await page.locator('.workflow-board-lane').first().click();
  await page.locator('[data-role="lane-success-review-required"]').check();
  await expect(page.locator('[data-role="lane-needs-work-target"]')).toBeVisible();
  await page.locator('[data-role="lane-needs-work-target"]').selectOption({ label: "Fix" });
  await page.locator('[data-role="save-workflow"]').click();

  const savedWorkflow = await page.evaluate(() => {
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    return workflows.find((workflow: { name: string }) => workflow.name === "Review Routing Flow") ?? null;
  });

  expect(savedWorkflow?.lanes?.[0]?.needsWorkTargetLaneId).toBe(savedWorkflow?.lanes?.[1]?.id);

  await page.locator('[data-role="lane-success-review-required"]').uncheck();
  await expect(page.locator('[data-role="lane-needs-work-target"]')).toHaveCount(0);
  await page.locator('[data-role="save-workflow"]').click();

  const clearedWorkflow = await page.evaluate(() => {
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    return workflows.find((workflow: { name: string }) => workflow.name === "Review Routing Flow") ?? null;
  });

  expect(clearedWorkflow?.lanes?.[0]?.needsWorkTargetLaneId).toBeNull();
});
