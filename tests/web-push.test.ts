// @vitest-environment jsdom

import { afterEach, describe, expect, test, vi } from "vitest";

import type { OrchestraClientBootstrap } from "../src/lib/orchestraClient";
import {
  serializeStoredWebPushSubscription,
  syncRemoteWebPushRegistration,
  supportsRemoteWebPushSession,
} from "../src/lib/webPush";

const bootstrap: OrchestraClientBootstrap = {
  contractVersion: "2026-05-10",
  bootstrappedAt: "2026-05-05T00:00:00.000Z",
  hostKind: "remote_api",
  authMode: "same_origin_cookie",
  urls: {
    apiBaseUrl: "https://orchestra.example.test",
    websocketUrl: "wss://orchestra.example.test/api/v1/ws",
  },
  featureFlags: {
    sharedCatalog: true,
    sharedTasks: true,
    sharedInbox: true,
    sharedSessions: true,
    sharedSkills: true,
    sharedNotes: true,
    taskSchedules: true,
    sessionStreaming: true,
    sessionControls: true,
    taskComments: true,
    taskFiles: true,
    desktopWindows: false,
    agentTerminal: false,
  },
  capabilities: {
    app: {
      bootstrap: { availability: "available" },
      errorReporting: { availability: "available" },
    },
    catalog: {
      projects: { availability: "available" },
      agents: { availability: "available" },
      roles: { availability: "available" },
      workflows: { availability: "available" },
    },
    admin: {
      projects: { availability: "available" },
      settings: { availability: "available" },
      workers: { availability: "available" },
      workflows: { availability: "available" },
      policies: { availability: "available" },
      channels: { availability: "available" },
      modelCatalog: { availability: "available" },
      piExecutableDiagnostic: { availability: "unavailable" },
    },
    skills: {
      read: { availability: "available" },
      create: { availability: "available" },
      update: { availability: "available" },
      archive: { availability: "available" },
      delete: { availability: "available" },
      assign: { availability: "available" },
    },
    notes: {
      read: { availability: "available" },
      write: { availability: "available" },
    },
    tasks: {
      read: { availability: "available" },
      write: { availability: "available" },
      review: { availability: "available" },
      comments: { availability: "available" },
      todos: { availability: "available" },
      dependencies: { availability: "available" },
      attachments: { availability: "available" },
      fileReferences: { availability: "available" },
      fileContents: { availability: "available" },
      schedules: { availability: "available" },
    },
    inbox: {
      read: { availability: "available" },
      write: { availability: "available" },
      archive: { availability: "available" },
    },
    sessions: {
      read: { availability: "available" },
      write: { availability: "available" },
      stream: { availability: "available" },
      runtimeControls: { availability: "available" },
      modelSelection: { availability: "available" },
    },
    host: {
      logsWindow: { availability: "unavailable" },
      agentTerminal: { availability: "unavailable" },
      systemNotifications: { availability: "available" },
      bridgeDiagnostics: { availability: "unavailable" },
      runtimeLogs: { availability: "unavailable" },
      harnessSettings: { availability: "unavailable" },
      remoteAccess: { availability: "unavailable" },
    },
  },
  appInfo: null,
};

function installWebPushBrowserSupport() {
  Object.defineProperty(window, "isSecureContext", {
    configurable: true,
    value: true,
  });
  Object.defineProperty(window, "Notification", {
    configurable: true,
    value: class Notification {},
  });
  Object.defineProperty(window, "PushManager", {
    configurable: true,
    value: class PushManager {},
  });
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("remote web push helpers", () => {
  test("recognizes hosted-web same-origin sessions as push-capable sessions", () => {
    expect(supportsRemoteWebPushSession(bootstrap)).toBe(true);
    expect(supportsRemoteWebPushSession({
      ...bootstrap,
      authMode: "none",
    })).toBe(false);
  });

  test("serializes browser subscriptions with an explicit web_push kind", () => {
    expect(serializeStoredWebPushSubscription({
      toJSON: () => ({
        endpoint: "https://push.example.test/send/1",
        expirationTime: null,
        keys: {
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      }),
    } as PushSubscription)).toContain('"kind":"web_push"');
  });

  test("registers a push subscription and posts it to the remote host", async () => {
    installWebPushBrowserSupport();
    const subscription = {
      toJSON: () => ({
        endpoint: "https://push.example.test/send/1",
        expirationTime: null,
        keys: {
          p256dh: "p256dh-key",
          auth: "auth-key",
        },
      }),
    } as PushSubscription;
    const subscribe = vi.fn(async () => subscription);
    const getSubscription = vi.fn(async () => null);
    const register = vi.fn(async () => ({
      pushManager: {
        getSubscription,
        subscribe,
      },
    }));
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        register,
        getRegistration: vi.fn(async () => null),
      },
    });

    const fetchMock = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: async () => ({
          supported: true,
          vapidPublicKey: "AQAB",
        }),
      })
      .mockResolvedValueOnce({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const notifications = {
      getPermissionState: vi.fn(async () => "granted"),
    } as const;

    const state = await syncRemoteWebPushRegistration({
      bootstrap,
      notifications: notifications as never,
      enabled: true,
    });

    expect(state.status).toBe("subscribed");
    expect(register).toHaveBeenCalledWith("/orchestra-sw.js");
    expect(subscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenNthCalledWith(
      2,
      "https://orchestra.example.test/api/v1/devices/push-token",
      expect.objectContaining({
        method: "POST",
        credentials: "include",
      }),
    );
    const postedBody = JSON.parse(String(fetchMock.mock.calls[1]?.[1]?.body)) as { pushToken: string };
    expect(JSON.parse(postedBody.pushToken)).toMatchObject({ kind: "web_push" });
  });

  test("unsubscribes and clears the remote token when local notifications are disabled", async () => {
    installWebPushBrowserSupport();
    const unsubscribe = vi.fn(async () => true);
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {
        getRegistration: vi.fn(async () => ({
          pushManager: {
            getSubscription: vi.fn(async () => ({
              unsubscribe,
            })),
          },
        })),
      },
    });

    const fetchMock = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal("fetch", fetchMock);

    const state = await syncRemoteWebPushRegistration({
      bootstrap,
      notifications: {
        getPermissionState: vi.fn(async () => "granted"),
      } as never,
      enabled: false,
    });

    expect(state.status).toBe("disabled");
    expect(unsubscribe).toHaveBeenCalledTimes(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "https://orchestra.example.test/api/v1/devices/push-token",
      expect.objectContaining({
        method: "POST",
      }),
    );
    expect(String(fetchMock.mock.calls[0]?.[1]?.body)).toContain('"pushToken":null');
  });

  test("reports unsupported on insecure origins without trying to fetch config", async () => {
    Object.defineProperty(window, "isSecureContext", {
      configurable: true,
      value: false,
    });
    Object.defineProperty(window, "Notification", {
      configurable: true,
      value: class Notification {},
    });
    Object.defineProperty(window, "PushManager", {
      configurable: true,
      value: class PushManager {},
    });
    Object.defineProperty(window.navigator, "serviceWorker", {
      configurable: true,
      value: {},
    });

    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const state = await syncRemoteWebPushRegistration({
      bootstrap,
      notifications: {
        getPermissionState: vi.fn(async () => "granted"),
      } as never,
      enabled: true,
    });

    expect(state.status).toBe("unsupported");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
