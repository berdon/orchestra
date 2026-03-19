import { expect, test } from "@playwright/test";

test("settings agents panel creates a global agent definition and shows bootstrap paths", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.locator('[data-role="new-agent"]').click();

  await page.locator('[data-role="agent-name"]').fill("Architect");
  await page.getByLabel("Provider").fill("anthropic");
  await page.getByLabel("Model").fill("claude-sonnet-4-20250514");
  await page.locator('[data-role="save-agent"]').click();

  await expect(page.getByRole("heading", { name: "Architect" })).toBeVisible();
  await expect(page.locator('[data-role="agent-memory-root"]')).toContainText("/mock/agents/architect");

  await page.locator('[data-role="agent-overlay-prompt"]').fill("In this project, optimize for small focused commits.");
  await page.locator('[data-role="save-agent-overlay"]').click();

  const storedState = await page.evaluate(() => {
    const agents = JSON.parse(window.localStorage.getItem("orchestra.mock.agents") ?? "[]");
    const projectSettings = JSON.parse(window.localStorage.getItem("orchestra.mock.project-settings") ?? "{}");
    return {
      agent: agents.find((agent: { name: string }) => agent.name === "Architect") ?? null,
      overlay: projectSettings.agentOverlays?.architect ?? null,
    };
  });

  expect(storedState.agent?.slug).toBe("architect");
  expect(storedState.agent?.provider).toBe("anthropic");
  expect(storedState.agent?.model).toBe("claude-sonnet-4-20250514");
  expect(storedState.overlay?.prompt).toBe("In this project, optimize for small focused commits.");
});
