import { expect, test } from "@playwright/test";

test("settings agents panel creates a global agent definition with access controls and overlay", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible();
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.locator('[data-role="new-agent"]').click();

  await page.locator('[data-role="agent-name"]').fill("Architect");
  await page.locator('[data-role="agent-provider"]').selectOption("anthropic");
  await page.locator('[data-role="agent-model"]').selectOption("claude-sonnet-4-20250514");
  await page.locator('[data-role="agent-supervisor-toggle"]').check();
  await page.locator('[data-role="agent-permission-roles.dispatch"]').check();
  await page.locator('[data-role="save-agent"]').click();

  await expect(page.getByRole("heading", { name: "Architect" })).toBeVisible();
  await expect(page.locator('[data-role="agent-memory-root"]')).toContainText("/mock/agents/architect");
  await expect(page.locator('[data-role="agent-effective-access"]')).toContainText("Full access");

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
  expect(storedState.agent?.policyIds).toContain("policy-supervisor");
  expect(storedState.agent?.directPermissions).toContain("roles.dispatch");
  expect(storedState.overlay?.prompt).toBe("In this project, optimize for small focused commits.");
});

test("protected supervisor keeps access locked while allowing model and overlay edits", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await expect(page.getByRole("tab", { name: "Agents" })).toBeVisible();
  await page.getByRole("tab", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Supervisor/i }).click();

  await expect(page.locator('[data-role="agent-protected-badge"]')).toBeVisible();
  await expect(page.locator('[data-role="agent-supervisor-toggle"]')).toBeChecked();
  await expect(page.locator('[data-role="agent-supervisor-toggle"]')).toBeDisabled();
  await expect(page.locator('[data-role="agent-permission-roles.dispatch"]')).toBeDisabled();
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
  expect(storedState.agent?.policyIds).toContain("policy-supervisor");
  expect(storedState.overlay?.prompt).toBe("Use this project as the operational source of truth.");
});

test("agents page launches and reuses a persistent agent session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();
  await page.locator('[data-role="open-agent-session"]').click();

  await expect(page.getByRole("button", { name: "Sessions" })).toHaveClass(/nav-item--active/);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();
  await page.locator('[data-role="open-agent-session"]').click();

  await expect(page.locator('[data-role="session-link"]').filter({ hasText: "Data main session" })).toHaveCount(1);
});

test("agents page opens an embedded terminal window and locks the session chat until it closes", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();

  const [popup] = await Promise.all([
    page.waitForEvent("popup"),
    page.locator('[data-role="open-agent-session-terminal"]').click(),
  ]);

  await expect(page.getByRole("button", { name: "Sessions" })).toHaveClass(/nav-item--active/);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");
  await expect(page.locator('[data-role="session-terminal-readonly"]')).toContainText("embedded terminal window");
  await expect(page.locator('[data-role="send-message"]')).toBeDisabled();
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-terminal-attached", "true");

  await popup.waitForLoadState();
  await expect.poll(() => popup.url()).toContain("view=agent-terminal");

  await popup.close();
  await page.bringToFront();

  await expect(page.locator('[data-role="session-terminal-readonly"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-terminal-attached", "false");
  await page.locator('[data-role="composer-input"]').fill("Back in chat");
  await expect(page.locator('[data-role="send-message"]')).toBeEnabled();
});

test("agents page deletes queued work items from an agent queue", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const now = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.agents",
      JSON.stringify([
        {
          id: "agent-delete-queue",
          slug: "queue-cleaner",
          name: "Queue Cleaner",
          description: "Agent used to verify queued work deletion.",
          provider: null,
          model: null,
          roleId: null,
          thinkingLevel: "medium",
          policyIds: [],
          directPermissions: [],
          system: false,
          immutable: false,
          archived: false,
          createdAt: now,
          updatedAt: now,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.agent-queue",
      JSON.stringify([
        {
          id: "agent-queue-delete-me",
          projectId: "orchestra",
          agentId: "agent-delete-queue",
          status: "queued",
          sourceType: "manual",
          sourceTaskId: null,
          sourceWorkflowId: null,
          sourceLaneId: null,
          deliveryMode: "follow_up",
          title: "Queued cleanup item",
          message: "Remove this queued work item.",
          sessionId: null,
          runId: null,
          dispatchedAt: null,
          completedAt: null,
          createdAt: now,
          updatedAt: now,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Queue Cleaner/i }).click();
  await page.locator('[data-role="agent-work-filter-queued"]').click();
  await expect(page.locator('.workflow-lane-card')).toContainText("Queued cleanup item");
  await page.locator('[data-role="delete-agent-queue-entry-agent-queue-delete-me"]').click();
  await expect(page.locator('.workflow-lane-card')).toHaveCount(0);

  const storedQueue = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.agent-queue") ?? "[]"));
  expect(storedQueue).toHaveLength(0);
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
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="publish-task"]').click();

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();

  await expect(page.getByRole("heading", { name: "Data" })).toBeVisible();
  await expect(page.locator(".status-badge").filter({ hasText: "running" }).first()).toBeVisible();
  await expect(page.locator(".workflow-lane-card").filter({ hasText: "Agent runtime view task" }).first()).toBeVisible();
});
