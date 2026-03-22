import { expect, test } from "@playwright/test";

async function triggerShortcut(page: import("@playwright/test").Page, key: string) {
  await page.evaluate((nextKey) => {
    window.dispatchEvent(new KeyboardEvent("keydown", { key: nextKey, ctrlKey: true, bubbles: true }));
  }, key);
}

test("sessions UI creates a session and streams a mock reply", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  const previousSessionCount = await page.locator('[data-role="session-link"]').count();
  await page.locator('[data-role="create-session"]').click();

  await expect(page.locator('[data-role="session-link"]')).toHaveCount(previousSessionCount + 1);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("New session");

  await page.locator('[data-role="composer-input"]').fill("Hello from Playwright");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from Playwright", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Acknowledged: Hello from Playwright", { timeout: 20_000 });
});

test("sessions composer stays enabled while earlier messages are still pending", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  await page.locator('[data-role="composer-input"]').fill("First queued message");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await page.locator('[data-role="composer-input"]').fill("Second queued message");
  await expect(page.locator('[data-role="send-message"]')).toBeEnabled();
  await expect(page.locator('[data-role="send-message"]')).toContainText("Send message");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("First queued message", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Second queued message", { timeout: 10_000 });
});

test("sessions UI shows tool invocations in the transcript", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-tools",
          title: "Show tools",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Show tools" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-tools",
          runId: "run-tools",
          receivedAt,
          event: {
            type: "tool_execution_start",
            toolCallId: "call-1",
            toolName: "complete_lane_as_success",
            args: { taskId: "task-1", notes: "Ship it" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-tools",
          runId: "run-tools",
          receivedAt,
          event: {
            type: "tool_execution_end",
            toolCallId: "call-1",
            toolName: "complete_lane_as_success",
            args: { taskId: "task-1", notes: "Ship it" },
            result: {
              content: [{ type: "text", text: '{"id":"task-1","status":"done"}' }],
            },
            isError: false,
          },
        },
      }),
    );
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Tool result: complete_lane_as_success");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("task-1");
});

test("sessions UI shows streamed assistant text when rejoining an active session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-rejoin",
          title: "Rejoin me",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Rejoin me" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-rejoin",
          runId: "run-rejoin",
          receivedAt,
          event: {
            type: "message_start",
            message: { role: "assistant" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-rejoin",
          runId: "run-rejoin",
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: "Hello from rejoined stream" }] },
            assistantMessageEvent: { type: "text_delta", delta: "Hello from rejoined stream" },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-rejoin",
          runId: "run-rejoin",
          receivedAt,
          event: {
            type: "turn_end",
            message: { content: [{ type: "text", text: "Hello from rejoined stream" }] },
          },
        },
      }),
    );
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from rejoined stream");
});

test("sessions UI refreshes an active session after opening even without a local send", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-active-refresh",
          title: "Active refresh",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "user-1",
              kind: "user",
              message: "Keep watching this session",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Active refresh" }).click();

  await page.evaluate(() => {
    window.setTimeout(() => {
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        "orchestra.mock.sessions.orchestra",
        JSON.stringify([
          {
            id: "session-active-refresh",
            title: "Active refresh",
            status: "idle",
            createdAt: timestamp,
            updatedAt: timestamp,
            subscribed: true,
            events: [
              {
                id: "user-1",
                kind: "user",
                message: "Keep watching this session",
                timestamp,
              },
              {
                id: "assistant-1",
                kind: "assistant",
                message: "This reply arrived after the session was opened.",
                timestamp,
              },
            ],
          },
        ]),
      );
    }, 150);
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("This reply arrived after the session was opened.", { timeout: 4000 });
});

test("sessions page filters active and closed task sessions", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-role-terminal",
          slug: "role-terminal",
          name: "Role Terminal",
          description: "Single role-owned lane that ends the task.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-role-terminal",
              key: "implement",
              name: "Implementation",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Finish the task.",
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
  await page.locator('[data-role="task-title"]').fill("Closable session task");
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-role-terminal");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Closable session task" }).click();
  await page.locator('[data-role="dispatch-task-lane"]').click();
  await page.locator('[data-role="complete-task-success"]').click();

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);

  const closedSessionLinks = page.locator('[data-role="session-link"]');
  await page.locator('[data-role="session-filter-closed"]').click();
  await expect(closedSessionLinks).toHaveCount(1);
  await expect(closedSessionLinks).toContainText("Implementation · Closable session task");
  await page.waitForTimeout(500);
  await expect(page.locator('[data-role="session-filter-closed"]')).toHaveAttribute("aria-selected", "true");
  await expect(closedSessionLinks).toHaveCount(1);

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "Sessions" }).click();
  await page.locator('[data-role="session-filter-closed"]').click();
  await expect(closedSessionLinks).toHaveCount(1);
  await expect(closedSessionLinks).toContainText("Implementation · Closable session task");
});

test("sessions page renders debug paths below a vertically resizable chat panel", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-debug-paths",
          title: "Debug path layout",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Session loaded with debug info.",
              timestamp,
            },
          ],
          debugInfo: {
            projectRoot: "/tmp/orchestra/projects/demo",
            managedRepositoryPath: "/tmp/orchestra/projects/demo/repositories/repository",
            worktreePath: "/tmp/orchestra/projects/demo/worktrees/agent-02",
            sessionCwd: "/tmp/orchestra/projects/demo/worktrees/agent-02",
          },
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Debug path layout" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const debugHeading = page.getByRole("heading", { name: "Resolved runtime paths" });

  await expect(transcript).toBeVisible();
  await expect(debugHeading).toBeVisible();

  const chatPanelMetrics = await transcript.evaluate((node) => {
    const panel = node.closest(".panel") as HTMLElement | null;
    if (!panel) {
      return null;
    }

    const rect = panel.getBoundingClientRect();
    const style = window.getComputedStyle(panel);
    return {
      y: rect.y,
      height: rect.height,
      resize: style.resize,
      minHeight: style.minHeight,
    };
  });
  const debugPanelMetrics = await debugHeading.evaluate((node) => {
    const panel = node.closest(".panel, .task-section") as HTMLElement | null;
    if (!panel) {
      return null;
    }

    const rect = panel.getBoundingClientRect();
    return {
      y: rect.y,
      height: rect.height,
    };
  });

  expect(chatPanelMetrics).not.toBeNull();
  expect(debugPanelMetrics).not.toBeNull();
  expect(debugPanelMetrics!.y).toBeGreaterThanOrEqual(chatPanelMetrics!.y + chatPanelMetrics!.height - 1);
  expect(chatPanelMetrics!.resize).toBe("vertical");
  expect(Number.parseFloat(chatPanelMetrics!.minHeight)).toBeGreaterThanOrEqual(560);

  const transcriptWrapMinHeight = await transcript.evaluate((node) => window.getComputedStyle(node.parentElement as HTMLElement).minHeight);
  expect(Number.parseFloat(transcriptWrapMinHeight)).toBeGreaterThanOrEqual(240);
});

test("sessions transcript wraps long lines by default and can toggle to no-wrap", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const longLine = `LONG-${"x".repeat(600)}`;
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-wrap-toggle",
          title: "Wrap toggle",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: longLine,
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Wrap toggle" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-wrap-toggle"]');
  const firstMessage = transcript.locator(".transcript-event p").first();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre-wrap");

  const wrappedMetrics = await transcript.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(wrappedMetrics.scrollWidth).toBeLessThanOrEqual(wrappedMetrics.clientWidth + 4);

  await toggle.click();

  await expect(toggle).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(transcript).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(firstMessage).toHaveCSS("white-space", "pre");

  const nowrapMetrics = await transcript.evaluate((node) => ({
    clientWidth: node.clientWidth,
    scrollWidth: node.scrollWidth,
  }));
  expect(nowrapMetrics.scrollWidth).toBeGreaterThan(nowrapMetrics.clientWidth + 20);
});

test("sessions transcript unlocks on manual scroll and relocks at bottom", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const events = Array.from({ length: 40 }, (_, index) => ({
      id: `event-${index}`,
      kind: index % 2 === 0 ? "assistant" : "user",
      message: `Transcript event ${index}`,
      timestamp,
    }));

    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-scroll-lock",
          title: "Scroll lock",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Scroll lock" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');

  await transcript.waitFor();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Scroll lock");

  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.scrollHeight > metrics.clientHeight && metrics.top + metrics.clientHeight >= metrics.scrollHeight - 24;
    })
  ).toBe(true);

  await transcript.evaluate((node) => {
    node.scrollTop = Math.max(0, node.scrollHeight - node.clientHeight - 160);
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight < metrics.scrollHeight - 24;
    })
  ).toBe(true);

  await transcript.evaluate((node) => {
    node.scrollTop = node.scrollHeight;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
  });

  await expect.poll(async () =>
    transcript.evaluate((node) => {
      const metrics = {
        top: node.scrollTop,
        clientHeight: node.clientHeight,
        scrollHeight: node.scrollHeight,
      };
      return metrics.top + metrics.clientHeight >= metrics.scrollHeight - 24;
    })
  ).toBe(true);
});

test("ctrl+t opens a persistent supervisor quick chat modal", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();

  await page.locator('[data-role="supervisor-composer-input"]').fill("Check the current project status");
  await page.locator('[data-role="supervisor-send-message"]').click();

  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Check the current project status", { timeout: 10_000 });
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Check the current project status", { timeout: 20_000 });

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toHaveCount(0);

  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Check the current project status");
});
