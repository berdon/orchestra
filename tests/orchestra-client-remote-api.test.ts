import { afterEach, describe, expect, test, vi } from "vitest";

import type { OrchestraClientBootstrap } from "../src/lib/orchestraClient";
import { createRemoteApiOrchestraClientBinding } from "../src/lib/orchestraClient";

class FakeWebSocket {
  static instances: FakeWebSocket[] = [];

  readonly url: string;
  readonly sent: string[] = [];
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;

  constructor(url: string) {
    this.url = url;
    FakeWebSocket.instances.push(this);
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.onclose?.({} as CloseEvent);
  }

  emitConnected(contractVersion = "2026-04-23") {
    this.onmessage?.({ data: JSON.stringify({ type: "connected", contractVersion }) } as MessageEvent);
  }

  emitSubscriptionConfirmed(sessionId: string, subscribed: boolean) {
    this.onmessage?.({
      data: JSON.stringify({
        type: "subscription.confirmed",
        subscriptionType: "session",
        sessionId,
        subscribed,
      }),
    } as MessageEvent);
  }

  emitEvent(event: unknown) {
    this.onmessage?.({
      data: JSON.stringify({ type: "event", event }),
    } as MessageEvent);
  }
}

function createBootstrap(authMode: OrchestraClientBootstrap["authMode"] = "same_origin_cookie"): OrchestraClientBootstrap {
  return {
    contractVersion: "2026-04-23",
    bootstrappedAt: "2026-04-23T00:00:00.000Z",
    hostKind: "remote_api",
    authMode,
    urls: {
      apiBaseUrl: "https://orchestra.example.test",
      websocketUrl: "wss://orchestra.example.test/api/v1/ws",
    },
    featureFlags: {
      sharedCatalog: true,
      sharedTasks: true,
      sharedInbox: true,
      sharedSessions: true,
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
        piExecutableDiagnostic: { availability: "unavailable", reason: "Desktop only" },
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
        logsWindow: { availability: "unavailable", reason: "Desktop only" },
        agentTerminal: { availability: "unavailable", reason: "Desktop only" },
        systemNotifications: { availability: "unavailable", reason: "Desktop only" },
        bridgeDiagnostics: { availability: "unavailable", reason: "Desktop only" },
        runtimeLogs: { availability: "unavailable", reason: "Desktop only" },
        harnessSettings: { availability: "unavailable", reason: "Desktop only" },
        remoteAccess: { availability: "unavailable", reason: "Desktop only" },
      },
    },
    appInfo: null,
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } satisfies Partial<Response> as Response;
}

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.useRealTimers();
});

describe("remote api orchestra client", () => {
  test("uses same-origin credentials for cookie-backed HTTP requests", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://orchestra.example.test/api/v1/tasks?includeArchived=false&tagMatch=all&sortBy=updatedAt&sortDirection=desc");
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
      });
      expect(init?.headers).toBeInstanceOf(Headers);
      return jsonResponse([]);
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    await expect(binding.client.tasks.list()).resolves.toEqual([]);
  });

  test("attaches bearer tokens to HTTP requests and websocket URLs", async () => {
    const fetchImpl = vi.fn(async (_input: RequestInfo | URL, init?: RequestInit) => {
      const headers = init?.headers as Headers;
      expect(headers.get("Authorization")).toBe("Bearer token-123");
      expect(init?.credentials).toBe("omit");
      return jsonResponse([]);
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("bearer_token"), {
      fetchImpl,
      getBearerToken: () => "token-123",
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });

    await expect(binding.client.tasks.list()).resolves.toEqual([]);

    const subscribePromise = binding.client.events.subscribe(() => undefined);
    expect(FakeWebSocket.instances).toHaveLength(1);
    expect(FakeWebSocket.instances[0]?.url).toBe("wss://orchestra.example.test/api/v1/ws?token=token-123");
    FakeWebSocket.instances[0]?.emitConnected();
    await expect(subscribePromise).resolves.toEqual(expect.any(Function));
  });

  test("normalizes HTTP authorization failures", async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ error: "Nope" }, 401));
    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    await expect(binding.client.tasks.list()).rejects.toMatchObject({
      name: "OrchestraClientError",
      code: "unauthorized",
      status: 401,
      source: "remote_api",
      operation: "tasks.list",
      message: "Nope",
    });
    expect(binding.client.connection.getSnapshot().hostState).toBe("online");
  });

  test("normalizes offline HTTP failures and marks the host offline", async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    await expect(binding.client.tasks.list()).rejects.toMatchObject({
      name: "OrchestraClientError",
      code: "offline",
      source: "remote_api",
      operation: "tasks.list",
    });
    expect(binding.client.connection.getSnapshot()).toMatchObject({
      hostState: "offline",
      liveState: "disconnected",
      degraded: true,
    });
  });

  test("maps remote websocket events and waits for explicit session subscription confirmation", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL) => {
      const url = String(input);
      if (url.endsWith("/api/v1/sessions/session-1/subscribe")) {
        return jsonResponse({
          id: "session-1",
          title: "Session 1",
          status: "running",
          createdAt: "2026-04-23T00:00:00.000Z",
          updatedAt: "2026-04-23T00:00:00.000Z",
          subscribed: true,
          events: [],
        });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });

    const received: Array<{ kind: string; id?: string; sessionId?: string }> = [];
    const unsubscribePromise = binding.client.events.subscribe((event) => {
      received.push({
        kind: event.kind,
        sessionId: "sessionId" in event ? event.sessionId : undefined,
      });
    });

    expect(FakeWebSocket.instances).toHaveLength(1);
    const socket = FakeWebSocket.instances[0]!;
    socket.emitConnected();
    await unsubscribePromise;

    socket.emitEvent({
      id: "remote-event-task",
      sequence: 1,
      topic: "task.updated",
      timestamp: "2026-04-23T00:00:00.000Z",
      payload: {
        taskIds: ["task-1"],
        reason: "task.updated",
      },
    });

    socket.emitEvent({
      id: "remote-event-stream-pre",
      sequence: 2,
      topic: "session.stream",
      timestamp: "2026-04-23T00:00:00.000Z",
      payload: {
        sessionId: "session-1",
        event: { type: "assistant.delta", text: "before" },
        receivedAt: "2026-04-23T00:00:00.000Z",
      },
    });

    const subscribePromise = binding.client.sessions.subscribe("session-1");
    await vi.waitFor(() => {
      expect(socket.sent.at(-1)).toBe(JSON.stringify({ type: "session.subscribe", sessionId: "session-1" }));
    });
    socket.emitSubscriptionConfirmed("session-1", true);
    await expect(subscribePromise).resolves.toMatchObject({ id: "session-1", subscribed: true });

    socket.emitEvent({
      id: "remote-event-stream-post",
      sequence: 3,
      topic: "session.stream",
      timestamp: "2026-04-23T00:00:00.000Z",
      payload: {
        sessionId: "session-1",
        event: { type: "assistant.delta", text: "after" },
        receivedAt: "2026-04-23T00:00:00.000Z",
      },
    });

    expect(received).toEqual([
      { kind: "task.change", sessionId: undefined },
      { kind: "session.stream", sessionId: "session-1" },
    ]);
  });

  test("times out when the websocket never confirms a session subscription", async () => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async () => jsonResponse({
      id: "session-1",
      title: "Session 1",
      status: "running",
      createdAt: "2026-04-23T00:00:00.000Z",
      updatedAt: "2026-04-23T00:00:00.000Z",
      subscribed: true,
      events: [],
    }));

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });

    const unsubscribePromise = binding.client.events.subscribe(() => undefined);
    const socket = FakeWebSocket.instances[0]!;
    socket.emitConnected();
    await unsubscribePromise;

    const subscribePromise = binding.client.sessions.subscribe("session-1");
    const rejection = expect(subscribePromise).rejects.toMatchObject({
      name: "OrchestraClientError",
      code: "timeout",
      operation: "sessions.subscribe",
    });

    await vi.advanceTimersByTimeAsync(5_000);
    await rejection;
  });

  test("exposes reconnecting live state when the websocket closes unexpectedly", async () => {
    vi.useFakeTimers();
    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl: vi.fn(async () => jsonResponse([])),
      webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
    });

    const unsubscribePromise = binding.client.events.subscribe(() => undefined);
    const firstSocket = FakeWebSocket.instances[0]!;
    firstSocket.emitConnected();
    const unsubscribe = await unsubscribePromise;
    expect(binding.client.connection.getSnapshot()).toMatchObject({
      hostState: "online",
      liveState: "connected",
      degraded: false,
      retryAttempt: 0,
    });

    firstSocket.close();
    expect(binding.client.connection.getSnapshot()).toMatchObject({
      hostState: "online",
      liveState: "reconnecting",
      degraded: true,
      retrying: true,
      retryAttempt: 1,
    });

    await vi.advanceTimersByTimeAsync(250);
    expect(FakeWebSocket.instances).toHaveLength(2);
    FakeWebSocket.instances[1]!.emitConnected();
    expect(binding.client.connection.getSnapshot()).toMatchObject({
      hostState: "online",
      liveState: "connected",
      degraded: false,
      retrying: false,
      retryAttempt: 0,
    });

    unsubscribe();
  });
});
