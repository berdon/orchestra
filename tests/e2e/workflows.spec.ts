import { expect, test } from "@playwright/test";

test("workflow lanes persist stable global worker references by slug", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Workflows" }).click();

  await expect(page.getByRole("link", { name: "Development" })).toBeVisible();

  const seededWorkflowRefs = await page.evaluate(() => {
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    const development = workflows.find((workflow: { name: string }) => workflow.name === "Development");
    return development?.lanes?.map((lane: { assignedEntityId: string | null }) => lane.assignedEntityId) ?? [];
  });

  expect(seededWorkflowRefs).toContain("developer");
  expect(seededWorkflowRefs).not.toContain("developer-role");

  await page.getByRole("button", { name: "New workflow" }).click();
  await page.getByLabel("Workflow name").fill("Agent Driven Flow");
  await page.getByLabel("Lane name").fill("Implement");
  await page.getByLabel("Lane key").fill("implement");
  await page.locator('[data-role="lane-owner-type"]').selectOption("agent");
  await page.locator('[data-role="lane-owner-reference"]').selectOption("data");
  await page.locator('[data-role="save-workflow"]').click();

  await expect(page.getByRole("heading", { name: "Agent Driven Flow" })).toBeVisible();

  const savedOwnerRef = await page.evaluate(() => {
    const workflows = JSON.parse(window.localStorage.getItem("orchestra.mock.workflows") ?? "[]");
    const created = workflows.find((workflow: { name: string }) => workflow.name === "Agent Driven Flow");
    return created?.lanes?.[0]?.assignedEntityId ?? null;
  });

  expect(savedOwnerRef).toBe("data");
});
