import { afterEach, describe, expect, test, vi } from "vitest";

import type { OrchestraClientBootstrap } from "../src/lib/orchestraClient";
import {
  HOSTED_WEB_BOOTSTRAP_PATH,
  HOSTED_WEB_PAIR_COMPLETE_PATH,
  completeHostedWebPairing,
  createHostedWebBootstrapBinding,
  fetchHostedWebBootstrap,
  resolveOrchestraClientHostMode,
} from "../src/lib/orchestraClient";

const bootstrapFixture: OrchestraClientBootstrap = {
  contractVersion: "2026-05-02",
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
    sharedSkills: false,
    sharedNotes: false,
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
    skills: {
      read: { availability: "unavailable", reason: "Not implemented" },
      create: { availability: "unavailable", reason: "Not implemented" },
      update: { availability: "unavailable", reason: "Not implemented" },
      archive: { availability: "unavailable", reason: "Not implemented" },
      delete: { availability: "unavailable", reason: "Not implemented" },
      assign: { availability: "unavailable", reason: "Not implemented" },
    },
    notes: {
      read: { availability: "unavailable", reason: "Not implemented" },
      write: { availability: "unavailable", reason: "Not implemented" },
    },
    tasks: {
      read: { availability: "available" },
      write: { availability: "unavailable", reason: "Not implemented" },
      review: { availability: "available" },
      comments: { availability: "unavailable", reason: "Not implemented" },
      commentDelete: { availability: "unavailable", reason: "Not implemented" },
      commentDeleteImpact: { availability: "unavailable", reason: "Not implemented" },
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
      harnessSettings: { availability: "available" },
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

  test("posts hosted-web pairing completion with same-origin credentials", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(input).toBe(HOSTED_WEB_PAIR_COMPLETE_PATH);
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          code: "ABCD-EFGH",
          label: "QA Browser",
          platform: "browser",
          pushToken: null,
        }),
      });
      return {
        ok: true,
        json: async () => ({
          token: "token-123",
          baseUrl: "https://orchestra.example.test",
          websocketUrl: "wss://orchestra.example.test/api/v1/ws",
        }),
      } satisfies Partial<Response> as Response;
    });

    await expect(completeHostedWebPairing({
      code: "ABCD-EFGH",
      label: "QA Browser",
      platform: "browser",
      pushToken: null,
    }, fetchImpl)).resolves.toMatchObject({ token: "token-123" });
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
