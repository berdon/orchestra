import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type {
  ChannelActivityEntry,
  ChannelDetail,
  ChannelSummary,
  ChannelUpsertInput,
  TelegramBotValidation,
  TelegramChatCandidate,
} from "../types";

const CHANNEL_STORAGE_KEY = "orchestra.mock.channels";
const CHANNEL_ACTIVITY_STORAGE_KEY = "orchestra.mock.channel-activity";

export function normalizeOptionalString(value?: string | null) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function nowIso() {
  return new Date().toISOString();
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function getStoredChannels() {
  const value = window.localStorage.getItem(CHANNEL_STORAGE_KEY);
  return value ? (JSON.parse(value) as ChannelDetail[]) : [];
}

function saveStoredChannels(channels: ChannelDetail[]) {
  window.localStorage.setItem(CHANNEL_STORAGE_KEY, JSON.stringify(channels));
}

function getStoredChannelActivity() {
  const value = window.localStorage.getItem(CHANNEL_ACTIVITY_STORAGE_KEY);
  return value ? (JSON.parse(value) as ChannelActivityEntry[]) : [];
}

function saveStoredChannelActivity(entries: ChannelActivityEntry[]) {
  window.localStorage.setItem(CHANNEL_ACTIVITY_STORAGE_KEY, JSON.stringify(entries));
}

export async function listChannels(): Promise<ChannelSummary[]> {
  if (!isTauriAvailable()) {
    return getStoredChannels();
  }
  return invoke<ChannelSummary[]>("list_channels");
}

export async function getChannel(channelId: string): Promise<ChannelDetail> {
  if (!isTauriAvailable()) {
    const channel = getStoredChannels().find((entry) => entry.id === channelId);
    if (!channel) {
      throw new Error(`Channel ${channelId} was not found.`);
    }
    return channel;
  }
  return invoke<ChannelDetail>("get_channel", { channelId });
}

export async function listChannelActivity(channelId: string, limit = 50): Promise<ChannelActivityEntry[]> {
  if (!isTauriAvailable()) {
    return getStoredChannelActivity().filter((entry) => entry.channelId === channelId).slice(0, limit);
  }
  return invoke<ChannelActivityEntry[]>("list_channel_activity", { channelId, limit });
}

export async function createChannel(input: ChannelUpsertInput): Promise<ChannelDetail> {
  if (!isTauriAvailable()) {
    const timestamp = nowIso();
    const channel: ChannelDetail = {
      id: createId("channel"),
      kind: input.kind ?? "telegram",
      name: input.name?.trim() || "Telegram",
      enabled: Boolean(input.enabled),
      status: input.telegram?.botToken && input.telegram?.chatId ? "ready" : "needs_setup",
      targetAgentId: input.targetAgentId ?? "agent-supervisor",
      defaultProjectId: input.defaultProjectId ?? "orchestra",
      defaultProjectName: input.defaultProjectId ?? "orchestra",
      secretConfigured: Boolean(input.telegram?.botToken),
      telegram: {
        botUsername: null,
        apiBaseUrl: normalizeOptionalString(input.telegram?.apiBaseUrl),
        chatId: input.telegram?.chatId ?? null,
        chatTitle: input.telegram?.chatTitle ?? null,
        chatType: input.telegram?.chatType ?? null,
        commandsEnabled: input.telegram?.commandsEnabled ?? true,
      },
      lastError: null,
      lastActivityAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    saveStoredChannels([channel, ...getStoredChannels()]);
    return channel;
  }
  return invoke<ChannelDetail>("create_channel", { input });
}

export async function updateChannel(channelId: string, input: ChannelUpsertInput): Promise<ChannelDetail> {
  if (!isTauriAvailable()) {
    const channels = getStoredChannels();
    const existing = channels.find((entry) => entry.id === channelId);
    if (!existing) {
      throw new Error(`Channel ${channelId} was not found.`);
    }
    const updated: ChannelDetail = {
      ...existing,
      name: input.name?.trim() || existing.name,
      enabled: input.enabled ?? existing.enabled,
      defaultProjectId: input.defaultProjectId ?? existing.defaultProjectId,
      secretConfigured: existing.secretConfigured || Boolean(input.telegram?.botToken),
      telegram: {
        ...(existing.telegram ?? {
          botUsername: null,
          apiBaseUrl: null,
          chatId: null,
          chatTitle: null,
          chatType: null,
          commandsEnabled: true,
        }),
        apiBaseUrl: normalizeOptionalString(input.telegram?.apiBaseUrl) ?? existing.telegram?.apiBaseUrl ?? null,
        chatId: input.telegram?.chatId ?? existing.telegram?.chatId ?? null,
        chatTitle: input.telegram?.chatTitle ?? existing.telegram?.chatTitle ?? null,
        chatType: input.telegram?.chatType ?? existing.telegram?.chatType ?? null,
        commandsEnabled: input.telegram?.commandsEnabled ?? existing.telegram?.commandsEnabled ?? true,
      },
      status: (existing.secretConfigured || Boolean(input.telegram?.botToken)) && (input.telegram?.chatId ?? existing.telegram?.chatId)
        ? "ready"
        : "needs_setup",
      updatedAt: nowIso(),
    };
    saveStoredChannels(channels.map((entry) => (entry.id === channelId ? updated : entry)));
    return updated;
  }
  return invoke<ChannelDetail>("update_channel", { channelId, input });
}

export async function deleteChannel(channelId: string): Promise<void> {
  if (!isTauriAvailable()) {
    saveStoredChannels(getStoredChannels().filter((entry) => entry.id !== channelId));
    saveStoredChannelActivity(getStoredChannelActivity().filter((entry) => entry.channelId !== channelId));
    return;
  }
  await invoke("delete_channel", { channelId });
}

export async function validateTelegramBot(botToken: string, apiBaseUrl?: string | null): Promise<TelegramBotValidation> {
  if (!isTauriAvailable()) {
    return {
      botId: "mock-bot",
      username: "mock_orchestra_bot",
      displayName: "Mock Orchestra Bot",
    };
  }
  return invoke<TelegramBotValidation>("validate_telegram_bot", {
    botToken,
    apiBaseUrl: normalizeOptionalString(apiBaseUrl),
  });
}

export async function listTelegramChatCandidates(botToken: string, apiBaseUrl?: string | null): Promise<TelegramChatCandidate[]> {
  if (!isTauriAvailable()) {
    return [
      {
        chatId: "mock-chat",
        title: "Mock Telegram Chat",
        chatType: "private",
        username: "mock-user",
        lastMessageText: "/start",
        lastMessageAt: nowIso(),
      },
    ];
  }
  return invoke<TelegramChatCandidate[]>("list_telegram_chat_candidates", {
    botToken,
    apiBaseUrl: normalizeOptionalString(apiBaseUrl),
  });
}
