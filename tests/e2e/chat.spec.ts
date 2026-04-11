import { expect, test } from "@playwright/test";

test("chat nav lists named agents and excludes roles", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await expect(page.locator('[data-role="project-switcher"]')).toBeVisible({ timeout: 10_000 });
  await expect(page.getByRole("button", { name: "Settings" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Reviewer");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();
  await expect(page.getByRole("heading", { name: "Reviewer" })).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.locator('[data-role="chat-agent-nav-supervisor"]')).toBeVisible();
  await expect(page.locator('[data-role="chat-agent-nav-data"]')).toBeVisible();
  await expect(page.getByRole("tab", { name: "Reviewer" })).toHaveCount(0);
});

test("chat composer autocompletes project tasks, agents, and roles and renders task mentions as links", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: /^Roles$/ }).click();
  await page.locator('[data-role="new-role"]').click();
  await page.locator('[data-role="role-name"]').fill("Reviewer");
  await page.getByLabel("Capacity").fill("1");
  await page.locator('[data-role="save-role"]').click();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Autocomplete navigation task");
  await page.locator('[data-role="save-task"]').click();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await page.locator('[data-role="composer-input"]').fill("Loop in @dat");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Data");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Agent · data");

  await page.locator('[data-role="composer-input"]').fill("Ask @rev");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Role · reviewer");

  await page.locator('[data-role="composer-input"]').fill("Please follow up on @auto");
  await expect(page.locator('[data-role="composer-mention-list"]')).toContainText("Autocomplete navigation task");
  await page.locator('[data-role="composer-mention-option"]').filter({ hasText: "Autocomplete navigation task" }).click();
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue(/Please follow up on @ORC-\d+\s/);

  await page.locator('[data-role="send-message"]').click();
  await expect(page.locator('[data-role="transcript-entry-rendered-markdown"]').last()).toContainText("Autocomplete navigation task");
  await expect(page.locator('[data-role="transcript-mention-link"]').filter({ hasText: "Autocomplete navigation task" }).last()).toBeVisible();
});

test("chat page opens an agent main session with focused chat controls while Sessions stays available", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await expect(page.getByRole("button", { name: "Chat" })).toBeVisible({ timeout: 10_000 });
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Session model" })).toBeVisible();
  await expect(page.locator('[data-role="session-wrap-toggle"]')).toBeVisible();
  await expect(page.locator('[data-role="session-scroll-lock-toggle"]')).toBeVisible();

  const firstSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(firstSessionId).toBeTruthy();

  const longLine = `CHAT-${"y".repeat(600)}`;
  await page.locator('[data-role="composer-input"]').fill(longLine);
  await page.locator('[data-role="send-message"]').click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-wrap-toggle"]');
  const firstMessage = transcript.locator(".transcript-event p").last();

  await expect(firstMessage).toContainText(longLine);
  await expect(toggle).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre-wrap");

  await toggle.click();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre");

  await page.evaluate((sessionId) => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== sessionId) {
        return session;
      }
      return {
        ...session,
        events: [],
        updatedAt: new Date().toISOString(),
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: [sessionId],
        reason: "test.chat_summary_refresh",
      },
    }));
    window.dispatchEvent(new Event("focus"));
  }, firstSessionId);

  await page.waitForTimeout(400);
  await expect(transcript).toContainText(longLine);

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const secondSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");

  expect(secondSessionId).toBe(firstSessionId);
});

test("chat page New session rotates the active agent session in place and leaves prior sessions in history", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");

  const firstSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(firstSessionId).toBeTruthy();

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-new"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(0);

  const secondSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(secondSessionId).toBeTruthy();
  expect(secondSessionId).not.toBe(firstSessionId);

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await expect(page.locator('[data-role="session-link"]').filter({ hasText: "Data main session" })).toHaveCount(2);

  const selectedSessionId = await page.locator('.session-list-link--active[data-role="session-link"]').getAttribute("data-session-id");
  expect(selectedSessionId).toBe(secondSessionId);
});

test("chat page reuses a cached main session from the session list before reopening the agent runtime", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.agents",
      JSON.stringify([
        {
          id: "agent-supervisor-fixed",
          slug: "supervisor",
          name: "Supervisor",
          description: "Built-in protected Orchestra supervisor agent.",
          systemPrompt: "Supervisor prompt",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: ["policy-supervisor"],
          directPermissions: [],
          system: true,
          immutable: true,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "agent-data-fixed",
          slug: "data",
          name: "Data",
          description: "Persistent collaborator for implementation and documentation work.",
          systemPrompt: "Keep context, preserve continuity, and move the project forward.",
          provider: "anthropic",
          model: "claude-sonnet-4-20250514",
          roleId: null,
          scope: "global",
          projectId: null,
          thinkingLevel: "medium",
          policyIds: [],
          directPermissions: [],
          system: false,
          immutable: false,
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.agent-runtimes",
      JSON.stringify([
        {
          projectId: "orchestra",
          agentId: "agent-supervisor-fixed",
          status: "idle",
          mainSessionId: null,
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          projectId: "orchestra",
          agentId: "agent-data-fixed",
          status: "idle",
          mainSessionId: "session-data-main",
          runtimeCwd: "/tmp/orchestra",
          currentQueueEntryId: null,
          lastDispatchAt: null,
          lastError: null,
          terminalAttached: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-data-main",
          title: "Cached data session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "cached-event-1",
              kind: "assistant",
              message: "Cached response from the existing main session.",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", "session-data-main");
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Cached response from the existing main session.");
});

test("chat page recovers the active agent session after a prolonged background refresh miss", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-supervisor"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await page.locator('[data-role="composer-input"]').focus();
  await page.locator('[data-role="composer-input"]').fill("Keep this chat session visible");

  const initialSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  expect(initialSessionId).toBeTruthy();

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = Date.now();
    Date.now = () => testWindow.__orchestraTestNow ?? 0;
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep this chat session visible");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = (testWindow.__orchestraTestNow ?? Date.now()) + 30_000;
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Supervisor chat");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", initialSessionId ?? "");
  await expect(page.locator('[data-role="composer-input"]')).toBeVisible();
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep this chat session visible");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();
});
