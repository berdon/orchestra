import { expect, test } from "@playwright/test";

test.setTimeout(120_000);

test("settings channels panel creates a Telegram channel", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Channels" }).click();
  await page.locator('[data-role="new-channel"]').click();

  await page.locator('[data-role="channel-name"]').fill("Telegram Ops");
  await page.locator('[data-role="channel-detail-tab-bot"]').click();
  await page.locator('[data-role="telegram-bot-token"]').fill("mock-token");
  await page.locator('[data-role="validate-telegram-bot"]').click();
  await expect(page.locator('[data-role="telegram-bot-validation"]')).toContainText("mock_orchestra_bot");

  await page.locator('[data-role="channel-detail-tab-chat"]').click();
  await page.locator('[data-role="detect-telegram-chats"]').click();
  await page.locator('[data-role="telegram-chat-select"]').selectOption({ label: "Mock Telegram Chat" });
  await page.locator('[data-role="channel-detail-tab-behavior"]').click();
  await expect(page.locator('[data-role="telegram-notification-scope"]')).toHaveValue("all_projects");
  await page.locator('[data-role="telegram-notification-scope"]').selectOption("active_project");
  await page.locator('[data-role="channel-enabled"]').check();
  await page.locator('[data-role="save-channel"]').click();

  await expect(page.locator('[data-role="channel-list"]')).toContainText("Telegram Ops");
  const stored = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.channels") ?? "[]"));
  expect(stored).toHaveLength(1);
  expect(stored[0]?.name).toBe("Telegram Ops");
  expect(stored[0]?.telegram?.chatId).toBe("mock-chat");
  expect(stored[0]?.telegram?.notificationScope).toBe("active_project");
});
