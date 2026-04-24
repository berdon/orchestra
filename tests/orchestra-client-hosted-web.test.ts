import { afterEach, describe, expect, test, vi } from "vitest";

import type { OrchestraClientBootstrap } from "../src/lib/orchestraClient";
import {
  HOSTED_WEB_BOOTSTRAP_PATH,
  createHostedWebBootstrapBinding,
  fetchHostedWebBootstrap,
  resolveOrchestraClientHostMode,
} from "../src/lib/orchestraClient";

const bootstrapFixture: OrchestraClientBootstrap = {
  contractVersion: "2026-04-23",
  bootstrappedAt: "2026-04-23T00:00:00.000Z",
  hostKind: "remote_api",
  authMode: "same_origin_cookie",
  urls: {
    apiBaseUrl: "https://orchestra.example.test",
    websocketUrl: "wss://orchestra.example.test/api/v1/ws",
  },
  featureFlags: {
    sharedCatalog: false,
    sharedTasks: false,
    sharedInbox: true,
    sharedSessions: true,
    taskSchedules: false,
    sessionStreaming: true,
    sessionControls: true,
    taskComments: false,
    taskFiles: false,
    desktopWindows: false,
    agentTerminal: false,
  },
  capabilities: {
    app: {
      bootstrap: { availability: "available" },
      errorReporting: { availability: "unavailable", reason: "Not implemented" },
    },
    catalog: {
      projects: { availability: "available" },
      agents: { availability: "unavailable", reason: "Not implemented" },
      roles: { availability: "unavailable", reason: "Not implemented" },
      workflows: { availability: "unavailable", reason: "Not implemented" },
    },
    admin: {
      projects: { availability: "available" },
      settings: { availability: "available" },
      workers: { availability: "unavailable", reason: "Not implemented" },
      workflows: { availability: "unavailable", reason: "Not implemented" },
      policies: { availability: "unavailable", reason: "Not implemented" },
      channels: { availability: "unavailable", reason: "Not implemented" },
      modelCatalog: { availability: "unavailable", reason: "Not implemented" },
      piExecutableDiagnostic: { availability: "unavailable", reason: "Desktop only" },
    },
    tasks: {
      read: { availability: "available" },
      write: { availability: "unavailable", reason: "Not implemented" },
      review: { availability: "available" },
      comments: { availability: "unavailable", reason: "Not implemented" },
      todos: { availability: "unavailable", reason: "Not implemented" },
      dependencies: { availability: "unavailable", reason: "Not implemented" },
      attachments: { availability: "unavailable", reason: "Not implemented" },
      fileReferences: { availability: "unavailable", reason: "Not implemented" },
      fileContents: { availability: "unavailable", reason: "Not implemented" },
      schedules: { availability: "unavailable", reason: "Not implemented" },
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
      modelSelection: { availability: "unavailable", reason: "Not implemented" },
    },
    host: {
      logsWindow: { availability: "unavailable", reason: "Desktop only" },
      agentTerminal: { availability: "unavailable", reason: "Desktop only" },
      systemNotifications: { availability: "unavailable", reason: "Desktop only" },
      bridgeDiagnostics: { availability: "unavailable", reason: "Desktop only" },
      runtimeLogs: { availability: "unavailable", reason: "Desktop only" },
      harnessSettings: { availability: "unavailable", reason: "Desktop only" },
      remoteAccess: { availability: "unavailable", reason: "Desktop only" },
    },
  },
  appInfo: {
    appName: "Orchestra",
    environment: "test",
    backendStatus: "ready",
    versionDisplay: "0.1.0",
    dispatchBlocked: false,
    dispatchBlockedReason: null,
    piRuntimeDiagnostics: {
      runtime: {
        available: true,
        source: "bundled",
        packagedMode: false,
        resolvedPath: null,
        error: null,
        message: "ready",
      },
      auth: {
        configured: false,
        agentDir: "/tmp/agent",
        authPath: "/tmp/auth.json",
        modelsPath: "/tmp/models.json",
        settingsPath: "/tmp/settings.json",
        authExists: false,
        modelsExists: false,
        legacyAgentDir: null,
        legacyAuthAvailable: false,
        legacyModelsAvailable: false,
        authImportedAt: null,
        modelsImportedAt: null,
        message: "ready",
      },
      addOns: {
        packagedMode: false,
        allowed: true,
        extraExtensions: [],
        blockedExtensions: [],
        message: "ready",
      },
    },
  },
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("hosted web orchestra client helpers", () => {
  test("resolves hosted-web mode from explicit browser injection", () => {
    vi.stubGlobal("window", {
      __ORCHESTRA_HOST_MODE__: "hosted_web",
      __TAURI_INTERNALS__: undefined,
    });

    expect(resolveOrchestraClientHostMode()).toBe("hosted_web");
  });

  test("fetches hosted-web bootstrap with same-origin credentials", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(HOSTED_WEB_BOOTSTRAP_PATH);
      expect(init).toMatchObject({
        credentials: "same-origin",
        headers: { Accept: "application/json" },
      });
      return {
        ok: true,
        json: async () => bootstrapFixture,
      } satisfies Partial<Response> as Response;
    });

    await expect(fetchHostedWebBootstrap(fetchImpl)).resolves.toEqual(bootstrapFixture);
  });

  test("creates a hosted-web binding that preserves the fetched bootstrap and uses the remote transport", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://orchestra.example.test/api/v1/tasks?includeArchived=false&tagMatch=all&sortBy=updatedAt&sortDirection=desc");
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
        headers: expect.any(Headers),
      });
      return {
        ok: true,
        text: async () => "[]",
      } satisfies Partial<Response> as Response;
    });

    const binding = createHostedWebBootstrapBinding(bootstrapFixture, { fetchImpl });

    await expect(binding.client.getBootstrap()).resolves.toEqual(bootstrapFixture);
    await expect(binding.client.app.getInfo()).resolves.toEqual(bootstrapFixture.appInfo);
    await expect(binding.client.tasks.list()).resolves.toEqual([]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });
});
