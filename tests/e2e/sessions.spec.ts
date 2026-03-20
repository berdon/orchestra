import { expect, test } from "@playwright/test";

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
