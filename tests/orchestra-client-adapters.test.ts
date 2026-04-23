import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";

const { invokeMock } = vi.hoisted(() => ({
  invokeMock: vi.fn(),
}));

vi.mock("@tauri-apps/api/core", () => ({
  invoke: invokeMock,
}));

import { ORCHESTRA_BROWSER_EVENT_NAMES, emitMockInboxChange, emitMockSessionChange, emitMockSessionStream, emitMockTaskChange } from "../src/lib/mockOrchestra/events";
import { ORCHESTRA_CLIENT_CONTRACT_VERSION } from "../src/lib/orchestraClient/bootstrap";
import { createMockOrchestraClient } from "../src/lib/orchestraClient/mockClient";
import { createTauriOrchestraClient } from "../src/lib/orchestraClient/tauriClient";
import { mockOrchestraClientServiceBindings } from "../src/lib/orchestraClient/mockBindings";
import { tauriOrchestraClientServiceBindings } from "../src/lib/orchestraClient/tauriBindings";
import type { OrchestraClientServiceBindings } from "../src/lib/orchestraClient/serviceBindings";
import type { AppInfo } from "../src/types";

class TestCustomEvent<T = unknown> extends Event {
  detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

function createTestWindow() {
  const target = new EventTarget();
  const storage = new Map<string, string>();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
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
    __TAURI_INTERNALS__: undefined as unknown,
  };
}

function createStubServices(environment: AppInfo["environment"]): OrchestraClientServiceBindings {
  return {
    app: {
      getInfo: vi.fn(async () => ({
        appName: "Orchestra",
        environment,
        backendStatus: environment === "tauri" ? "connected" : "mock",
        versionDisplay: "0.1.0-test",
        dispatchBlocked: false,
        dispatchBlockedReason: null,
      } as unknown as AppInfo)),
      reportError: vi.fn(async () => "reported"),
    },
    catalog: {} as OrchestraClientServiceBindings["catalog"],
    tasks: {} as OrchestraClientServiceBindings["tasks"],
    inbox: {} as OrchestraClientServiceBindings["inbox"],
    sessions: {} as OrchestraClientServiceBindings["sessions"],
  };
}

beforeEach(() => {
  vi.stubGlobal("window", createTestWindow());
  vi.stubGlobal("CustomEvent", TestCustomEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.clearAllMocks();
  invokeMock.mockReset();
});

describe("orchestra client adapters", () => {
  test("dedicated Tauri and mock adapters resolve the shared bootstrap with their host metadata", async () => {
    const tauriClient = createTauriOrchestraClient(createStubServices("tauri"));
    const mockClient = createMockOrchestraClient(createStubServices("browser"));

    await expect(tauriClient.getBootstrap()).resolves.toMatchObject({
      contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
      hostKind: "tauri",
      authMode: "desktop_session",
      featureFlags: {
        desktopWindows: true,
        agentTerminal: true,
      },
    });

    await expect(mockClient.getBootstrap()).resolves.toMatchObject({
      contractVersion: ORCHESTRA_CLIENT_CONTRACT_VERSION,
      hostKind: "mock",
      authMode: "none",
      featureFlags: {
        desktopWindows: false,
        agentTerminal: false,
      },
    });
  });

  test("browser event subscriptions deliver the shared discriminated event union", async () => {
    const tauriClient = createTauriOrchestraClient(createStubServices("tauri"));
    const mockClient = createMockOrchestraClient(createStubServices("browser"));
    const tauriEvents: string[] = [];
    const mockEvents: string[] = [];

    const stopTauri = await tauriClient.events.subscribe((event) => {
      tauriEvents.push(event.kind);
    });
    const stopMock = await mockClient.events.subscribe((event) => {
      mockEvents.push(event.kind);
    });

    emitMockSessionStream({
      sessionId: "session-1",
      runId: "run-1",
      event: { type: "assistant.delta", text: "hello" },
      receivedAt: "2026-04-23T00:00:00.000Z",
    });
    emitMockSessionChange({ sessionIds: ["session-1"], reason: "session.updated" });
    emitMockTaskChange({ taskIds: ["task-1"], reason: "task.updated" });
    emitMockInboxChange({ deliveryIds: ["delivery-1"], reason: "mail.read" });

    expect(tauriEvents).toEqual([
      "session.stream",
      "session.change",
      "task.change",
      "inbox.change",
    ]);
    expect(mockEvents).toEqual(tauriEvents);

    stopTauri();
    stopMock();

    window.dispatchEvent(new CustomEvent(ORCHESTRA_BROWSER_EVENT_NAMES.taskChange, {
      detail: { taskIds: ["task-2"], reason: "task.updated" },
    }));

    expect(tauriEvents).toHaveLength(4);
    expect(mockEvents).toHaveLength(4);
  });

  test("default client selection chooses Tauri only when Tauri internals are present", async () => {
    const tauriWindow = createTestWindow();
    tauriWindow.__TAURI_INTERNALS__ = {};
    vi.stubGlobal("window", tauriWindow);
    const tauriDefaultClient = await import("../src/lib/orchestraClient/defaultClient");

    expect(tauriDefaultClient.resolveDefaultOrchestraClientHostKind()).toBe("tauri");
    expect(tauriDefaultClient.createDefaultOrchestraClientBinding().bootstrap.hostKind).toBe("tauri");

    vi.resetModules();
    vi.stubGlobal("window", createTestWindow());
    vi.stubGlobal("CustomEvent", TestCustomEvent);
    const mockDefaultClient = await import("../src/lib/orchestraClient/defaultClient");

    expect(mockDefaultClient.resolveDefaultOrchestraClientHostKind()).toBe("mock");
    expect(mockDefaultClient.createDefaultOrchestraClientBinding().bootstrap.hostKind).toBe("mock");
  });

  test("tauri and mock default bindings resolve task commands through distinct transports", async () => {
    invokeMock.mockImplementation(async (command: string) => {
      if (command === "list_projects") {
        return [{ id: "project-1" }];
      }
      if (command === "list_tasks") {
        return [];
      }
      throw new Error(`unexpected invoke command: ${command}`);
    });

    const tauriResult = await tauriOrchestraClientServiceBindings.tasks.list({ includeArchived: false });

    expect(tauriResult).toEqual([]);
    expect(invokeMock).toHaveBeenNthCalledWith(1, "list_projects", undefined);
    expect(invokeMock).toHaveBeenNthCalledWith(2, "list_tasks", {
      projectId: "project-1",
      includeArchived: false,
      tags: undefined,
      tagMatch: "all",
      sortBy: "updatedAt",
      sortDirection: "desc",
    });

    invokeMock.mockClear();
    const mockResult = await mockOrchestraClientServiceBindings.tasks.list({ includeArchived: false });

    expect(Array.isArray(mockResult)).toBe(true);
    expect(invokeMock).not.toHaveBeenCalled();
  });
});
