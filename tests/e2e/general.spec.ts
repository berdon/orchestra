import { expect, test } from "@playwright/test";

test("settings general renders bridge diagnostics and session prompt controls", async ({ page }) => {
  await page.addInitScript(() => {
    if (window.localStorage.getItem("orchestra.test.general.seeded") === "true") {
      return;
    }
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.test.general.seeded", "true");
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.bridge-diagnostics",
      JSON.stringify({
        instance: {
          instanceId: "bridge-instance-browser",
          url: "http://127.0.0.1:43123",
          ownerPid: 4321,
          startedAt: timestamp,
          heartbeatAt: timestamp,
          metadataPath: "/mock/.orchestra/bridge/bridge-instance-browser.json",
          activeClientCount: 2,
          inFlightRequestCount: 1,
        },
        clients: [
          {
            clientId: "client-1",
            sessionId: "session-1",
            actorType: "role",
            actorId: "developer",
            requestCount: 3,
            inFlightRequestCount: 1,
            lastSeenAt: timestamp,
            lastCommand: "get_task_context",
            lastError: null,
            active: true,
            bridgeInstanceId: "bridge-instance-browser",
          },
        ],
        recentRequests: [
          {
            requestId: "request-1",
            clientId: "client-1",
            sessionId: "session-1",
            command: "get_task_context",
            startedAt: timestamp,
            finishedAt: timestamp,
            durationMs: 12,
            success: true,
            error: null,
          },
        ],
        recentCleanupEvents: [],
      }),
    );
    window.localStorage.setItem(
      "orchestra.mock.project-settings",
      JSON.stringify({
        general: {
          taskSessionContextTemplate: "Task {TASK.ID} {TASK.NAME}",
          updatedAt: timestamp,
        },
      }),
    );
    window.localStorage.setItem(
      "orchestra.mock.harness-settings",
      JSON.stringify({
        extraExtensions: ["npm:pi-example", "./extensions/local-extra.ts"],
        updatedAt: timestamp,
      }),
    );
    window.localStorage.setItem(
      "orchestra.mock.logs",
      JSON.stringify([
        {
          id: "log-1",
          level: "debug",
          target: "sessions.rpc.event",
          message: "Session session-1 received turn_start",
          timestamp,
        },
        {
          id: "log-2",
          level: "info",
          target: "tool.bridge",
          message: "Bridge   status\n updated",
          timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("tab", { name: "General" }).evaluate((element) => { (element as HTMLButtonElement).click(); });

  await expect(page.locator('[data-role="theme-select"]')).toHaveValue("orchestra-dark");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "orchestra-dark");
  await expect(page.locator("html")).toHaveAttribute("data-explanatory-tooltips", "enabled");
  await expect(page.locator('[data-role="explanatory-tooltips-toggle"]')).toBeChecked();
  await page.locator('[data-role="theme-select"]').selectOption("catppuccin-latte");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "catppuccin-latte");
  await expect(page.locator('[data-role="theme-current-kind"]')).toContainText("light");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("orchestra.preferences.theme"))).toBe("catppuccin-latte");
  await page.locator('[data-role="theme-select"]').selectOption("dracula");
  await expect(page.locator("html")).toHaveAttribute("data-theme", "dracula");
  await expect(page.locator('[data-role="theme-current-kind"]')).toContainText("dark");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("orchestra.preferences.theme"))).toBe("dracula");

  await page.locator('[data-role="explanatory-tooltips-toggle"]').uncheck();
  await expect(page.locator("html")).toHaveAttribute("data-explanatory-tooltips", "disabled");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("orchestra.preferences.explanatory-tooltips"))).toBe("disabled");
  await page.reload();
  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("tab", { name: "General" }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  await expect(page.locator('[data-role="explanatory-tooltips-toggle"]')).not.toBeChecked();
  await expect(page.locator("html")).toHaveAttribute("data-explanatory-tooltips", "disabled");

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await expect.poll(() => page.locator('[data-role="task-workflow"]').evaluate((element) => element.closest('label')?.getAttribute('data-tooltip') ?? null)).toBeNull();

  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("tab", { name: "General" }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  await page.locator('[data-role="explanatory-tooltips-toggle"]').check();
  await expect(page.locator("html")).toHaveAttribute("data-explanatory-tooltips", "enabled");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("orchestra.preferences.explanatory-tooltips"))).toBe("enabled");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="new-task"]').click();
  await expect.poll(() => page.locator('[data-role="task-workflow"]').evaluate((element) => element.closest('label')?.getAttribute('data-tooltip') ?? null)).toBe("Choose which workflow owns this task's lane transitions.");

  await page.locator('[data-role="nav-item-settings"]').click();
  await page.getByRole("tab", { name: "General" }).evaluate((element) => { (element as HTMLButtonElement).click(); });
  await expect(page.getByRole("heading", { name: "Session prompt" })).toBeVisible();
  await expect(page.locator('[data-role="session-prompt-template"]')).toHaveValue("Task {TASK.ID} {TASK.NAME}");
  await expect(page.locator('[data-role="session-prompt-token-table"]')).toContainText("{TASK.ID}");
  await page.locator('[data-role="session-prompt-template"]').fill("Task {TASK.ID} {TASK.STATUS}");
  await page.locator('[data-role="save-session-prompt-template"]').click();
  await expect(page.locator('[data-role="session-prompt-template"]')).toHaveValue("Task {TASK.ID} {TASK.STATUS}");
  await page.locator('[data-role="reset-session-prompt-template"]').click();
  await expect(page.locator('[data-role="session-prompt-template"]')).toContainText("As you do work - periodically comment on tasks to give an update on what you’re doing.");

  await expect(page.getByRole("heading", { name: "PI settings" })).toBeVisible();
  await expect(page.locator('[data-role="pi-runtime-extensions"]')).toHaveValue("npm:pi-example\n./extensions/local-extra.ts");
  await page.locator('[data-role="pi-runtime-extensions"]').fill("npm:pi-example\n./extensions/second-extra.ts\n./extensions/second-extra.ts");
  await page.locator('[data-role="save-pi-runtime-extensions"]').click();
  await expect(page.locator('[data-role="pi-runtime-extensions"]')).toHaveValue("npm:pi-example\n./extensions/second-extra.ts");
  await expect.poll(() => page.evaluate(() => window.localStorage.getItem("orchestra.mock.harness-settings"))).toContain("./extensions/second-extra.ts");
  await page.locator('[data-role="reset-pi-runtime-extensions"]').click();
  await page.locator('[data-role="save-pi-runtime-extensions"]').click();
  await expect(page.locator('[data-role="pi-runtime-extensions"]')).toHaveValue("");

  await expect(page.getByRole("heading", { name: "Bridge diagnostics" })).toBeVisible();
  await expect(page.locator('[data-role="bridge-instance-id"]')).toContainText("bridge-instance-browser");
  await expect(page.locator('[data-role="bridge-active-client-count"]')).toContainText("2");
  await expect(page.locator('[data-role="bridge-clients-table"]')).toContainText("client-1");
  await expect(page.locator('[data-role="bridge-requests-table"]')).toContainText("get_task_context");

  await page.locator('[data-role="cleanup-stale-bridges"]').click();
  await expect(page.locator('[data-role="bridge-cleanup-table"]')).toContainText("cleanup_requested");

  await expect(page.locator('[data-role="runtime-log-list"]')).toBeVisible();
  await expect(page.locator('[data-role="runtime-log-level-filter"]')).toHaveValue("info");
  await expect(page.locator('[data-role="runtime-log-list"]')).toContainText("(tool.bridge): Bridge status updated");
  await expect(page.locator('[data-role="runtime-log-list"]')).not.toContainText("(sessions.rpc.event): Session session-1 received turn_start");
  await expect(page.locator('[data-role="runtime-log-line"]', { hasText: "(tool.bridge): Bridge status updated" })).toHaveText(/^\[I\]\s.+\s\(tool\.bridge\):\sBridge status updated$/);

  await page.locator('[data-role="runtime-log-level-filter"]').selectOption("debug");
  await expect(page.locator('[data-role="runtime-log-list"]')).toContainText("(sessions.rpc.event): Session session-1 received turn_start");
  await expect(page.locator('[data-role="runtime-log-line"]', { hasText: "(sessions.rpc.event): Session session-1 received turn_start" })).toHaveText(/^\[D\]\s.+\s\(sessions\.rpc\.event\):\sSession session-1 received turn_start$/);
});
