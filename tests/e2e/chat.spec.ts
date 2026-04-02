import { expect, test } from "@playwright/test";

test("chat nav lists named agents and excludes roles", async ({ page }) => {
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
  await expect(page.getByRole("heading", { name: "Reviewer" })).toBeVisible();

  await page.getByRole("button", { name: "Chat" }).click();
  await expect(page.locator('[data-role="chat-agent-nav-supervisor"]')).toBeVisible();
  await expect(page.locator('[data-role="chat-agent-nav-data"]')).toBeVisible();
  await expect(page.getByRole("tab", { name: "Reviewer" })).toHaveCount(0);
});

test("chat page opens an agent main session with focused chat controls while Sessions stays available", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data chat");
  await expect(page.locator('[data-role="session-filter-active"]')).toHaveCount(0);
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "Session model" })).toBeVisible();
  await expect(page.locator('[data-role="session-wrap-toggle"]')).toBeVisible();

  const firstSessionId = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.find((session: { title?: string }) => session.title === "Data main session")?.id ?? null;
  });
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

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-filter-active"]')).toBeVisible();
  await expect(page.locator('[data-role="session-link"]').filter({ hasText: "Data main session" })).toHaveCount(1);

  await page.getByRole("button", { name: "Chat" }).click();
  await page.locator('[data-role="chat-agent-nav-data"]').click();

  const secondSessionId = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.find((session: { title?: string }) => session.title === "Data main session")?.id ?? null;
  });

  expect(secondSessionId).toBe(firstSessionId);
});
