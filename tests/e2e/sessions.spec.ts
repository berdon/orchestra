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

  const createSessionButton = page.locator('[data-role="create-session"]');
  await expect(createSessionButton).toBeVisible();
  const previousSessionCount = await page.locator('[data-role="session-link"]').count();
  await createSessionButton.click();

  await expect(page.locator('[data-role="session-link"]')).toHaveCount(previousSessionCount + 1);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("New session");

  await page.locator('[data-role="composer-input"]').fill("Hello from Playwright");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Hello from Playwright", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Acknowledged: Hello from Playwright", { timeout: 20_000 });
});

test("sessions list uses deterministic task ordering and delays the dismiss affordance until hover settles", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-late",
          title: "runtime-z",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
          taskId: "task-10",
          taskNumber: "ORC-10",
          taskTitle: "Tenth task",
          workerType: "agent",
          workerName: "Reviewer",
        },
        {
          id: "session-early",
          title: "runtime-a",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
          taskId: "task-2",
          taskNumber: "ORC-2",
          taskTitle: "Second task",
          workerType: "agent",
          workerName: "Builder",
        },
      ]),
    );
  });

  await page.goto("/");
  await expect(page.locator('[data-role="session-link"]').first()).toContainText("ORC-2");
  await expect(page.locator('[data-role="session-link"]').first()).toContainText("Second task");

  const firstRow = page.locator('.session-list-row').first();
  const dismissButton = firstRow.locator('.session-delete-button');
  await expect(dismissButton).toHaveJSProperty('tabIndex', -1);
  await firstRow.hover();
  await page.waitForTimeout(2100);
  await expect(firstRow).toHaveClass(/session-list-row--actions-visible/);
  await expect(dismissButton).toHaveJSProperty('tabIndex', 0);
});

test("sessions secondary nav width is resizable and persists", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  const panel = page.locator('.session-list-panel');
  const handle = page.locator('[data-role="secondary-nav-resize-handle"]').first();
  const initialWidth = await panel.evaluate((node) => node.getBoundingClientRect().width);
  const handleBox = await handle.boundingBox();
  if (!handleBox) {
    throw new Error('Expected resize handle bounding box');
  }
  await page.mouse.move(handleBox.x + handleBox.width / 2, handleBox.y + handleBox.height / 2);
  await page.mouse.down();
  await page.mouse.move(handleBox.x + handleBox.width / 2 + 72, handleBox.y + handleBox.height / 2, { steps: 6 });
  await page.mouse.up();

  const resizedWidth = await panel.evaluate((node) => node.getBoundingClientRect().width);
  expect(resizedWidth).toBeGreaterThan(initialWidth + 40);

  const storedWidth = await page.evaluate(() => window.localStorage.getItem('orchestra.layout.sessions.secondary-nav-width'));
  expect(Number(storedWidth)).toBeGreaterThan(initialWidth + 40);
});

test("sessions composer model selector is compact, fixed-width, and unlabeled", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await expect(page.locator('[data-role="create-session"]')).toBeVisible();
  await page.locator('[data-role="create-session"]').click();

  const modelSelect = page.locator('select[aria-label="Session model"]');
  const cogButton = page.locator('[data-role="session-actions-trigger"]');
  const sendButton = page.locator('[data-role="send-message"]');
  await expect(modelSelect).toBeVisible();
  await expect(cogButton).toBeVisible();
  await expect(page.locator('.session-model-field .field-group__label')).toHaveCount(0);

  const modelWidth = await modelSelect.evaluate((node) => node.getBoundingClientRect().width);
  expect(modelWidth).toBeGreaterThanOrEqual(140);
  expect(modelWidth).toBeLessThanOrEqual(190);

  const layout = await page.evaluate(() => {
    const footer = document.querySelector('.composer__footer') as HTMLDivElement | null;
    const actions = document.querySelector('.composer__actions') as HTMLDivElement | null;
    const cog = document.querySelector('[data-role="session-actions-trigger"]') as HTMLButtonElement | null;
    const send = document.querySelector('[data-role="send-message"]') as HTMLButtonElement | null;
    if (!footer || !actions || !cog || !send) {
      return null;
    }
    const footerRect = footer.getBoundingClientRect();
    const actionsRect = actions.getBoundingClientRect();
    const cogRect = cog.getBoundingClientRect();
    const sendRect = send.getBoundingClientRect();
    return {
      actionsRightGap: Math.abs(footerRect.right - actionsRect.right),
      cogWidth: Math.round(cogRect.width),
      cogHeight: Math.round(cogRect.height),
      sendHeight: Math.round(sendRect.height),
    };
  });

  expect(layout).not.toBeNull();
  expect(layout?.actionsRightGap ?? 999).toBeLessThanOrEqual(2);
  expect(layout?.cogWidth).toBe(layout?.cogHeight);
  expect(layout?.cogHeight).toBe(layout?.sendHeight);
});

test("sessions composer session actions can reload, compact the current session, and create a new one", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();
  const initialCount = await page.locator('[data-role="session-link"]').count();

  await page.locator('[data-role="session-actions-trigger"]').click();
  await expect(page.locator('[data-role="session-actions-menu"]')).toBeVisible();
  await page.locator('[data-role="session-action-compact"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session compacted.");

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-new"]').click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(initialCount + 1);
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session is active. Send a message to begin the interaction loop.");
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText("Session compacted.");

  const reloadedSessionId = await page.locator('[data-role="session-chat-panel"]').getAttribute("data-session-id");
  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-reload"]').click();
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("/reload");
  await expect(page.locator('[data-role="session-chat-panel"]')).toHaveAttribute("data-session-id", reloadedSessionId ?? "");
});

test("sessions composer New session rotates a selected worker-owned session instead of creating a generic detached session", async ({ page }) => {
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
          title: "Data main session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: true,
          events: [
            {
              id: "seed-event-1",
              kind: "assistant",
              message: "Current Data session.",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");

  await page.locator('[data-role="session-actions-trigger"]').click();
  await page.locator('[data-role="session-action-new"]').click();

  await expect(page.locator('[data-role="session-link"]').filter({ hasText: "Data main session" })).toHaveCount(2);
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Fresh session is active.");
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText("Current Data session.");
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
  await expect(page.locator('[data-role="send-message"]')).toContainText("Send");
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("First queued message", { timeout: 10_000 });
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Second queued message", { timeout: 10_000 });
});

test("sessions stop button stops an active mock run", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.locator('[data-role="create-session"]').click();

  const longMessage = "Please keep thinking for a while ".repeat(40).trim();
  await page.locator('[data-role="composer-input"]').fill(longMessage);
  await page.locator('[data-role="composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="stop-session-runtime"]')).toBeEnabled();
  await page.locator('[data-role="stop-session-runtime"]').click();

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Session run stopped by operator.");
  await expect(page.locator('[data-role="stop-session-runtime"]')).toBeDisabled();

  await page.waitForTimeout(1200);
  await expect(page.locator('[data-role="session-transcript"]')).not.toContainText(`Acknowledged: ${longMessage}`);
});

test("sessions UI shows tool call composition before tool execution starts", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-toolcall",
          title: "Tool call stream",
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
  await page.getByRole("link", { name: "Tool call stream" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-toolcall",
          runId: "run-toolcall",
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
          sessionId: "session-toolcall",
          runId: "run-toolcall",
          receivedAt,
          event: {
            type: "message_update",
            message: {
              role: "assistant",
              content: [
                {
                  type: "toolCall",
                  toolCallId: "call-compose-1",
                  toolName: "write_file",
                  input: { path: "src/live.ts", content: "const answer = 42;" },
                },
              ],
            },
            assistantMessageEvent: { type: "toolcall_end", contentIndex: 0, partial: {} },
          },
        },
      }),
    );
  });

  const transcript = page.locator('[data-role="session-transcript"]');
  await expect(transcript).toContainText("write_file(");
  await expect(transcript).toContainText("src/live.ts");
  await expect(page.locator('[data-role="transcript-event"][data-event-id="tool-execution-call-compose-1"]')).toHaveAttribute("data-event-kind", "system");
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

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("complete_lane_as_success");
  await expect(page.locator('[data-role="session-transcript"]')).toContainText("task-1");
});

test("sessions UI shows compact live thinking updates while assistant text streams", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-thinking",
          title: "Thinking stream",
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
  await page.getByRole("link", { name: "Thinking stream" }).click();

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
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
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "thinking", thinking: "First line\nSecond line" }] },
            assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line" }] },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "\nThird line\nFourth line", partial: {} },
          },
        },
      }),
    );
  });

  const thinkingPreview = page.locator('[data-role="transcript-thinking-preview"]').last();
  await expect(thinkingPreview).toContainText("Fourth line");
  const previewTextContent = await thinkingPreview.evaluate((node) => node.textContent || "");
  expect(previewTextContent).toContain("Third line");
  expect(previewTextContent).toContain("Fourth line");
  const webkitLineClamp = await thinkingPreview.evaluate((node) => getComputedStyle(node).getPropertyValue("-webkit-line-clamp"));
  expect(webkitLineClamp.trim()).toBe("3");

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "message_update",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line\nFifth line" },
                { type: "text", text: "Visible answer" },
              ],
            },
            assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Visible answer", partial: {} },
          },
        },
      }),
    );
    window.dispatchEvent(
      new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-thinking",
          runId: "run-thinking",
          receivedAt,
          event: {
            type: "turn_end",
            message: {
              role: "assistant",
              content: [
                { type: "thinking", thinking: "First line\nSecond line\nThird line\nFourth line\nFifth line" },
                { type: "text", text: "Visible answer" },
              ],
            },
          },
        },
      }),
    );
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("Visible answer");
  await expect(thinkingPreview).toContainText("Fifth line");
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

test("sessions composer keeps focus while the viewed session refreshes", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-focus-refresh",
          title: "Focus refresh",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "user-1",
              kind: "user",
              message: "Keep typing while this session updates",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Focus refresh" }).click();
  await page.locator('[data-role="composer-input"]').focus();
  await page.locator('[data-role="composer-input"]').fill("Draft that should keep focus");

  await page.evaluate(() => {
    window.setTimeout(() => {
      const timestamp = new Date().toISOString();
      window.localStorage.setItem(
        "orchestra.mock.sessions.orchestra",
        JSON.stringify([
          {
            id: "session-focus-refresh",
            title: "Focus refresh",
            status: "idle",
            createdAt: timestamp,
            updatedAt: timestamp,
            subscribed: true,
            events: [
              {
                id: "user-1",
                kind: "user",
                message: "Keep typing while this session updates",
                timestamp,
              },
              {
                id: "assistant-1",
                kind: "assistant",
                message: "This refresh should not steal focus.",
                timestamp,
              },
            ],
          },
        ]),
      );
    }, 150);
  });

  await expect(page.locator('[data-role="session-transcript"]')).toContainText("This refresh should not steal focus.", { timeout: 4000 });
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Draft that should keep focus");
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

test("subscribed active sessions do not keep polling session records every second", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-subscribed-active",
          title: "Subscribed active",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: true,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Live updates already subscribed",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Subscribed active" }).click();

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && String(entry.message ?? "").includes("session-subscribed-active")).length;
  }).toBeGreaterThan(0);

  const baselineCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && String(entry.message ?? "").includes("session-subscribed-active")).length;
  });

  await page.waitForTimeout(2500);

  const finalCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string; message?: string }) => entry.target === "sessions.record" && String(entry.message ?? "").includes("session-subscribed-active")).length;
  });

  expect(finalCount).toBe(baselineCount);
});

test("session-change bursts debounce to one background session list refresh", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-debounce",
          title: "Debounce me",
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
  await page.getByRole("link", { name: "Debounce me" }).click();

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBeGreaterThan(0);

  const baselineCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  });

  await page.evaluate(() => {
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new CustomEvent("orchestra:session-change", {
        detail: { sessionIds: ["session-debounce"], reason: `burst-${index}` },
      }));
    }
  });

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBe(baselineCount + 1);
});

test("streaming updates for a newly discovered session debounce into one background session list refresh", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-known",
          title: "Known session",
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
  await page.getByRole("link", { name: "Known session" }).click();

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBeGreaterThan(0);

  const baselineCount = await page.evaluate(() => {
    const logs = JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]");
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  });

  await page.evaluate(() => {
    const receivedAt = new Date().toISOString();
    for (let index = 0; index < 5; index += 1) {
      window.dispatchEvent(new CustomEvent("orchestra:session-stream", {
        detail: {
          sessionId: "session-new-streaming",
          runId: `run-${index}`,
          receivedAt,
          event: {
            type: "message_update",
            message: { role: "assistant", content: [{ type: "text", text: `chunk-${index}` }] },
            assistantMessageEvent: { type: "text_delta", delta: `chunk-${index}`, contentIndex: 0, partial: {} },
          },
        },
      }));
    }
  });

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.list").length;
  }).toBe(baselineCount + 1);
});

test("sessions page keeps the viewed session stable during a prolonged background refresh miss", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-refresh-miss",
          title: "Refresh miss",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "user-1",
              kind: "user",
              message: "Keep this session open while the list refreshes",
              timestamp,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Refresh miss" }).click();
  await page.locator('[data-role="composer-input"]').focus();
  await page.locator('[data-role="composer-input"]').fill("Keep typing through the refresh miss");

  await expect.poll(async () => {
    const logs = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]"));
    return logs.filter((entry: { target?: string }) => entry.target === "sessions.subscribe").length;
  }).toBe(1);

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = Date.now();
    Date.now = () => testWindow.__orchestraTestNow ?? 0;
    window.localStorage.setItem("orchestra.mock.sessions.orchestra", JSON.stringify([]));
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Refresh miss");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep typing through the refresh miss");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();

  await page.evaluate(() => {
    const testWindow = window as Window & { __orchestraTestNow?: number };
    testWindow.__orchestraTestNow = (testWindow.__orchestraTestNow ?? Date.now()) + 30_000;
    window.dispatchEvent(new Event("focus"));
  });

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Refresh miss");
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(1);
  await expect(page.locator('[data-role="composer-input"]')).toHaveValue("Keep typing through the refresh miss");
  await expect(page.locator('[data-role="composer-input"]')).toBeFocused();

  const sessionLogTargets = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.logs") ?? "[]")
    .map((entry: { target?: string }) => entry.target)
    .filter((target: string | undefined) => typeof target === "string" && target.startsWith("sessions.")));
  expect(sessionLogTargets.filter((target: string) => target === "sessions.unsubscribe")).toHaveLength(0);
  expect(sessionLogTargets.filter((target: string) => target === "sessions.subscribe")).toHaveLength(1);
});

test("sessions page filters active and closed task sessions", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-active",
          title: "Active task session",
          status: "active",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
        {
          id: "session-closed",
          title: "Implementation · Closable session task",
          status: "closed",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveAttribute("aria-selected", "true");
  await expect(page.locator('[data-role="session-link"]').first()).toContainText("Active task session");

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

test("session dismiss hides a closed session without deleting its stored record", async ({ page }) => {
  test.setTimeout(60_000);
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-dismiss-me",
          title: "Dismissable closed session",
          status: "closed",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            { id: "assistant-1", kind: "assistant", message: "Already finished.", timestamp },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.locator('[data-role="session-filter-closed"]').click();
  await expect(page.locator('[data-role="session-link"]')).toContainText("Dismissable closed session");
  await page.getByRole("button", { name: "Dismiss Dismissable closed session" }).evaluate((element: HTMLButtonElement) => element.click());

  const stored = await page.evaluate(() => ({
    sessions: JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]"),
    dismissed: JSON.parse(window.localStorage.getItem("orchestra.mock.dismissed-sessions.orchestra") ?? "[]"),
  }));
  expect(stored.sessions).toHaveLength(1);
  expect(stored.sessions[0]?.id).toBe("session-dismiss-me");
  expect(stored.dismissed).toContain("session-dismiss-me");

});

test("sessions page hides debug paths behind a dev-only toggle below the chat panel", async ({ page }) => {
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
  const debugToggle = page.locator('[data-role="show-session-debug"]');
  const debugPanel = page.locator('[data-role="session-debug-paths"]');
  const debugHeading = page.getByRole("heading", { name: "Resolved runtime paths" });

  await expect(transcript).toBeVisible();
  await expect(debugToggle).toBeVisible();
  await expect(debugToggle).toContainText("Show debug information");
  await expect(debugPanel).toHaveCount(0);

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
      bottom: rect.bottom,
      resize: style.resize,
      minHeight: style.minHeight,
    };
  });
  const debugToggleMetrics = await debugToggle.evaluate((node) => {
    const rect = (node as HTMLElement).getBoundingClientRect();
    return { y: rect.y };
  });

  expect(chatPanelMetrics).not.toBeNull();
  expect(debugToggleMetrics.y).toBeGreaterThanOrEqual(chatPanelMetrics!.bottom - 1);
  expect(chatPanelMetrics!.resize).toBe("vertical");
  expect(Number.parseFloat(chatPanelMetrics!.minHeight)).toBeGreaterThanOrEqual(560);

  const transcriptWrapMinHeight = await transcript.evaluate((node) => window.getComputedStyle(node.parentElement as HTMLElement).minHeight);
  expect(Number.parseFloat(transcriptWrapMinHeight)).toBeGreaterThanOrEqual(240);

  await debugToggle.click();
  await expect(debugToggle).toHaveCount(0);
  await expect(debugHeading).toBeVisible();
});

test("sessions page can open runtime details and show loaded extensions for the selected session", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.harness-settings",
      JSON.stringify({
        extraExtensions: ["npm:pi-example", "./extensions/local-extra.ts"],
        updatedAt: timestamp,
      }),
    );
    window.localStorage.setItem(
      "orchestra.mock.sessions.orchestra",
      JSON.stringify([
        {
          id: "session-runtime-details",
          title: "Runtime details session",
          status: "idle",
          createdAt: timestamp,
          updatedAt: timestamp,
          subscribed: false,
          events: [
            {
              id: "assistant-1",
              kind: "assistant",
              message: "Runtime details are available.",
              timestamp,
            },
          ],
          debugInfo: {
            projectRoot: "/tmp/orchestra/projects/demo",
            sessionCwd: "/tmp/orchestra/projects/demo/worktrees/agent-02",
          },
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("link", { name: "Runtime details session" }).click();
  await page.locator('[data-role="open-session-runtime-details"]').click();

  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toBeVisible();
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText("Disabled by --no-extensions");
  await expect(page.locator('[data-role="session-runtime-loaded-extensions"]')).toContainText("extensions/orchestra-tools.ts");
  await expect(page.locator('[data-role="session-runtime-loaded-extensions"]')).toContainText("npm:pi-example");
  await expect(page.locator('[data-role="session-runtime-loaded-extensions"]')).toContainText("./extensions/local-extra.ts");
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toContainText("Disabled by --no-extensions");

  await page.locator('[data-role="close-session-runtime-details"]').click();
  await expect(page.locator('[data-role="session-runtime-details-dialog"]')).toHaveCount(0);
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

test("sessions transcript exposes an auto-scroll toggle that pauses and resumes following live updates", async ({ page }) => {
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
          id: "session-auto-scroll-toggle",
          title: "Auto-scroll toggle",
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
  await page.getByRole("link", { name: "Auto-scroll toggle" }).click();

  const transcript = page.locator('[data-role="session-transcript"]');
  const toggle = page.locator('[data-role="session-scroll-lock-toggle"]');

  await transcript.waitFor();
  await expect(toggle).toBeVisible();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "on");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "true");

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "off");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "false");

  const baselineRefreshCount = await page.evaluate(() => {
    const testWindow = window as typeof window & {
      __orchestraTestSessionRefreshStats?: () => { listRefreshCount: number };
    };
    return testWindow.__orchestraTestSessionRefreshStats ? testWindow.__orchestraTestSessionRefreshStats().listRefreshCount : 0;
  });

  await page.evaluate(() => {
    const storageKey = "orchestra.mock.sessions.orchestra";
    const sessions = JSON.parse(window.localStorage.getItem(storageKey) ?? "[]");
    const nextSessions = sessions.map((session: { id: string; events: unknown[]; updatedAt: string }) => {
      if (session.id !== "session-auto-scroll-toggle") {
        return session;
      }
      return {
        ...session,
        updatedAt: new Date().toISOString(),
        events: [
          ...session.events,
          {
            id: "event-new",
            kind: "assistant",
            message: "Newest transcript event",
            timestamp: new Date().toISOString(),
          },
        ],
      };
    });
    window.localStorage.setItem(storageKey, JSON.stringify(nextSessions));
    window.dispatchEvent(new CustomEvent("orchestra:session-change", {
      detail: {
        sessionIds: ["session-auto-scroll-toggle"],
        reason: "test.auto_scroll_toggle",
      },
    }));
  });

  await expect.poll(async () => {
    return page.evaluate(() => {
      const testWindow = window as typeof window & {
        __orchestraTestSessionRefreshStats?: () => { listRefreshCount: number };
      };
      return testWindow.__orchestraTestSessionRefreshStats ? testWindow.__orchestraTestSessionRefreshStats().listRefreshCount : 0;
    });
  }).toBe(baselineRefreshCount + 1);

  await expect(transcript).toContainText("Newest transcript event");
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

  await toggle.click();
  await expect(toggle).toHaveAttribute("data-auto-scroll-mode", "on");
  await expect(transcript).toHaveAttribute("data-scroll-locked", "true");
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
  await page.locator('[data-role="supervisor-composer-input"]').press("Control+Enter");

  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Check the current project status", { timeout: 10_000 });
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Check the current project status", { timeout: 20_000 });

  await page.getByRole("button", { name: "Close" }).click();
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toHaveCount(0);

  await triggerShortcut(page, "t");
  await expect(page.locator('[data-role="supervisor-quick-chat"]')).toBeVisible();
  await expect(page.locator('[data-role="supervisor-transcript"]')).toContainText("Acknowledged: Check the current project status");
});
