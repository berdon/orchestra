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
  await page.locator('[data-role="agent-provider"]').selectOption("anthropic");
  await page.locator('[data-role="agent-model"]').selectOption("claude-sonnet-4-20250514");
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

test("protected supervisor only allows provider/model/thinking and overlay edits", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByRole("link", { name: "Supervisor" }).click();

  await expect(page.locator('[data-role="agent-name"]')).toBeDisabled();
  await expect(page.getByRole("button", { name: "Archive agent" })).toHaveCount(0);

  await page.locator('[data-role="agent-provider"]').selectOption("openai-codex");
  await page.locator('[data-role="agent-model"]').selectOption("gpt-5.4");
  await page.locator('[data-role="agent-thinking"]').selectOption("high");
  await page.locator('[data-role="save-agent"]').click();

  await page.locator('[data-role="agent-overlay-prompt"]').fill("Use this project as the operational source of truth.");
  await page.locator('[data-role="save-agent-overlay"]').click();

  const storedState = await page.evaluate(() => {
    const agents = JSON.parse(window.localStorage.getItem("orchestra.mock.agents") ?? "[]");
    const projectSettings = JSON.parse(window.localStorage.getItem("orchestra.mock.project-settings") ?? "{}");
    return {
      agent: agents.find((agent: { slug: string }) => agent.slug === "supervisor") ?? null,
      overlay: projectSettings.agentOverlays?.supervisor ?? null,
    };
  });

  expect(storedState.agent?.name).toBe("Supervisor");
  expect(storedState.agent?.provider).toBe("openai-codex");
  expect(storedState.agent?.model).toBe("gpt-5.4");
  expect(storedState.agent?.thinkingLevel).toBe("high");
  expect(storedState.agent?.immutable).toBe(true);
  expect(storedState.overlay?.prompt).toBe("Use this project as the operational source of truth.");
});

test("agents page shows project-scoped agent runtime state from dispatched task work", async ({ page }) => {
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
  await page.locator('[data-role="task-title"]').fill("Agent runtime view task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="dispatch-task-lane"]').click();

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();

  await expect(page.getByRole("heading", { name: "Data" })).toBeVisible();
  await expect(page.locator('.status-badge').filter({ hasText: 'running' }).first()).toBeVisible();
  await expect(page.locator('.workflow-lane-card').filter({ hasText: 'Agent runtime view task' }).first()).toBeVisible();
});
