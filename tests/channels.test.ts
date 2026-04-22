import { beforeEach, describe, expect, test, vi } from "vitest";

const invokeMock = vi.fn();

async function importChannelsModule(isTauriAvailable: boolean) {
  vi.resetModules();
  vi.doMock("@tauri-apps/api/core", () => ({
    invoke: invokeMock,
  }));
  vi.doMock("../src/lib/tauri", () => ({
    isTauriAvailable: () => isTauriAvailable,
  }));
  return import("../src/lib/channels");
}

describe("channel API helpers", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
        clear: () => {
          store.clear();
        },
      },
    });
    invokeMock.mockReset();
    invokeMock.mockResolvedValue({ ok: true });
  });

  test("normalizes blank Telegram API base URLs to null for validation", async () => {
    const { validateTelegramBot } = await importChannelsModule(true);

    await validateTelegramBot("token", "   ");

    expect(invokeMock).toHaveBeenCalledWith("validate_telegram_bot", {
      botToken: "token",
      apiBaseUrl: null,
    });
  });

  test("normalizes blank Telegram API base URLs to null for chat detection", async () => {
    const { listTelegramChatCandidates } = await importChannelsModule(true);

    await listTelegramChatCandidates("token", "");

    expect(invokeMock).toHaveBeenCalledWith("list_telegram_chat_candidates", {
      botToken: "token",
      apiBaseUrl: null,
    });
  });

  test("mock channel creation defaults Telegram notification scope to all projects", async () => {
    const { createChannel } = await importChannelsModule(false);

    const channel = await createChannel({
      name: "Telegram Ops",
      telegram: {
        botToken: "mock-token",
        chatId: "chat-1",
        commandsEnabled: true,
      },
    });

    expect(channel.telegram?.notificationScope).toBe("all_projects");
    const stored = JSON.parse(window.localStorage.getItem("orchestra.mock.channels") ?? "[]");
    expect(stored[0]?.telegram?.notificationScope).toBe("all_projects");
  });

  test("mock channel updates persist explicit Telegram notification scope changes", async () => {
    const { createChannel, updateChannel } = await importChannelsModule(false);

    const channel = await createChannel({
      name: "Telegram Ops",
      telegram: {
        botToken: "mock-token",
        chatId: "chat-1",
        commandsEnabled: true,
      },
    });

    const updated = await updateChannel(channel.id, {
      telegram: {
        commandsEnabled: true,
        notificationScope: "active_project",
      },
    });

    expect(updated.telegram?.notificationScope).toBe("active_project");
    const stored = JSON.parse(window.localStorage.getItem("orchestra.mock.channels") ?? "[]");
    expect(stored[0]?.telegram?.notificationScope).toBe("active_project");
  });
});
