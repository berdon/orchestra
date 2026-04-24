import { afterEach, describe, expect, test, vi } from "vitest";

import {
  deliverNotificationIntent,
  loadStoredLocalNotificationsEnabled,
  LOCAL_NOTIFICATIONS_ENABLED_STORAGE_KEY,
  storeLocalNotificationsEnabled,
} from "../src/lib/localNotifications";
import type { NotificationIntent } from "../src/types";

function createTestWindow() {
  const storage = new Map<string, string>();
  return {
    focus: vi.fn(),
    location: { href: "https://orchestra.example.test/?page=tasks" },
    history: { state: null, replaceState: vi.fn() },
    localStorage: {
      getItem(key: string) {
        return storage.get(key) ?? null;
      },
      setItem(key: string, value: string) {
        storage.set(key, value);
      },
      removeItem(key: string) {
        storage.delete(key);
      },
      clear() {
        storage.clear();
      },
    },
  };
}

const intent: NotificationIntent = {
  id: "intent-1",
  eventType: "task.awaiting_user_approval",
  title: "Orchestra — Approval needed",
  body: "Body",
  tag: "task-attention:task.awaiting_user_approval:task-1",
  projectId: "project-1",
  taskId: "task-1",
  deliveryId: null,
  action: { type: "open_task", taskId: "task-1", target: "review" },
  occurredAt: "2026-04-24T00:00:00.000Z",
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("local notification helpers", () => {
  test("defaults local notifications to enabled until explicitly disabled", () => {
    vi.stubGlobal("window", createTestWindow());
    expect(loadStoredLocalNotificationsEnabled()).toBe(true);

    storeLocalNotificationsEnabled(false);
    expect(loadStoredLocalNotificationsEnabled()).toBe(false);
    expect(window.localStorage.getItem(LOCAL_NOTIFICATIONS_ENABLED_STORAGE_KEY)).toBe("disabled");
  });

  test("suppresses delivery when the local toggle is disabled", async () => {
    vi.stubGlobal("window", createTestWindow());
    const notifications = {
      deliver: vi.fn(async () => true),
    } as const;

    await expect(deliverNotificationIntent(notifications as never, intent, false)).resolves.toBe(false);
    expect(notifications.deliver).not.toHaveBeenCalled();
  });

  test("passes intent metadata through to the local notifications adapter", async () => {
    vi.stubGlobal("window", createTestWindow());
    const notifications = {
      deliver: vi.fn(async () => true),
    } as const;

    await expect(deliverNotificationIntent(notifications as never, intent, true)).resolves.toBe(true);
    expect(notifications.deliver).toHaveBeenCalledWith(expect.objectContaining({
      title: intent.title,
      body: intent.body,
      tag: intent.tag,
      onClick: expect.any(Function),
    }));
  });
});
