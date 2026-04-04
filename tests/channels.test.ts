import { beforeEach, describe, expect, test, vi } from "vitest";

const invokeMock = vi.fn();

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

vi.mock("../src/lib/tauri", () => ({
  isTauriAvailable: () => true,
}));

describe("channel API helpers", () => {
  beforeEach(() => {
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true });
  });

  test("normalizes blank Telegram API base URLs to null for validation", async () => {
    const { validateTelegramBot } = await import("../src/lib/channels");

    await validateTelegramBot("token", "   ");

    expect(invokeMock).toHaveBeenCalledWith("validate_telegram_bot", {
      botToken: "token",
      apiBaseUrl: null,
    });
  });

  test("normalizes blank Telegram API base URLs to null for chat detection", async () => {
    const { listTelegramChatCandidates } = await import("../src/lib/channels");

    await listTelegramChatCandidates("token", "");

    expect(invokeMock).toHaveBeenCalledWith("list_telegram_chat_candidates", {
      botToken: "token",
      apiBaseUrl: null,
    });
  });
});
