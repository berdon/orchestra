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
  await page.locator('[data-role="send-message"]').click();

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from Playwright", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Acknowledged: Hello from Playwright", { timeout: 20_000 });
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
