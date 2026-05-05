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

  emitConnected(contractVersion = "2026-05-02") {
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
    contractVersion: "2026-05-02",
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
        piExecutableDiagnostic: { availability: "unavailable", reason: "Desktop only" },
      },
      skills: {
        read: { availability: "available" },
        create: { availability: "available" },
        update: { availability: "available" },
        archive: { availability: "available" },
        delete: { availability: "available" },
        assign: { availability: "available" },
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
        harnessSettings: { availability: "available" },
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
  vi.unstubAllGlobals();
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

  test("uploads task attachments through the remote multipart route", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://orchestra.example.test/api/v1/tasks/task-1/attachments");
      expect(init).toMatchObject({
        method: "POST",
        credentials: "same-origin",
      });
      expect(init?.headers).toBeInstanceOf(Headers);
      expect((init?.headers as Headers).get("Content-Type")).toBeNull();
      expect(init?.body).toBeInstanceOf(FormData);

      const formData = init?.body as FormData;
      expect(formData.get("mediaType")).toBe("audio/wav");
      expect(formData.get("caption")).toBe("Meeting recording");
      const uploadedFile = formData.get("file");
      expect(uploadedFile).toBeInstanceOf(File);
      expect((uploadedFile as File).name).toBe("meeting.wav");
      expect(await (uploadedFile as File).text()).toBe("RIFF-WAVE");

      return jsonResponse({
        id: "task-attachment-1",
        taskId: "task-1",
        fileName: "meeting.wav",
        mediaType: "audio/wav",
        byteSize: 9,
        storedPath: "/tmp/meeting.wav",
        caption: "Meeting recording",
        previewText: null,
        imageDataUrl: null,
        createdAt: "2026-05-04T00:00:00.000Z",
      });
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    await expect(binding.client.tasks.addAttachment("task-1", {
      fileName: "meeting.wav",
      mediaType: "audio/wav",
      file: new File(["RIFF-WAVE"], "meeting.wav", { type: "audio/wav" }),
      caption: "Meeting recording",
    })).resolves.toMatchObject({
      id: "task-attachment-1",
      mediaType: "audio/wav",
      fileName: "meeting.wav",
    });
  });

  test("downloads task attachments through the remote binary route", async () => {
    const anchor = {
      click: vi.fn(),
      remove: vi.fn(),
      style: { display: "" },
      href: "",
      download: "",
    };
    const appendChild = vi.fn();
    const createElement = vi.fn(() => anchor);
    const createObjectURL = vi.fn(() => "blob:attachment-download");
    const revokeObjectURL = vi.fn();

    vi.stubGlobal("document", {
      createElement,
      body: { appendChild },
    });
    const originalCreateObjectUrl = URL.createObjectURL;
    const originalRevokeObjectUrl = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: revokeObjectURL });

    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe("https://orchestra.example.test/api/v1/task-attachments/task-attachment-1/content");
      expect(init).toMatchObject({
        method: "GET",
        credentials: "same-origin",
      });
      return {
        ok: true,
        status: 200,
        headers: new Headers({
          "Content-Disposition": 'attachment; filename="notes.txt"',
          "Content-Type": "text/plain",
        }),
        blob: async () => new Blob(["downloaded attachment"], { type: "text/plain" }),
        text: async () => "",
      } satisfies Partial<Response> as Response;
    });

    try {
      const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
        fetchImpl,
      });

      await expect(binding.client.tasks.downloadAttachment("task-attachment-1")).resolves.toBeUndefined();
      expect(createElement).toHaveBeenCalledWith("a");
      expect(anchor.href).toBe("blob:attachment-download");
      expect(anchor.download).toBe("notes.txt");
      expect(appendChild).toHaveBeenCalledWith(anchor);
      expect(anchor.click).toHaveBeenCalledTimes(1);
      expect(anchor.remove).toHaveBeenCalledTimes(1);
      await Promise.resolve();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:attachment-download");
    } finally {
      if (originalCreateObjectUrl) {
        Object.defineProperty(URL, "createObjectURL", { configurable: true, writable: true, value: originalCreateObjectUrl });
      } else {
        delete (URL as typeof URL & { createObjectURL?: typeof createObjectURL }).createObjectURL;
      }
      if (originalRevokeObjectUrl) {
        Object.defineProperty(URL, "revokeObjectURL", { configurable: true, writable: true, value: originalRevokeObjectUrl });
      } else {
        delete (URL as typeof URL & { revokeObjectURL?: typeof revokeObjectURL }).revokeObjectURL;
      }
    }
  });

  test("routes shared managed-skills methods through the remote API surface", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      if (url === "https://orchestra.example.test/api/v1/skills?includeArchived=true") {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse([]);
      }
      if (url === "https://orchestra.example.test/api/v1/skills/skill-1") {
        expect(init?.method).toBe("PATCH");
        return jsonResponse({ id: "skill-1", sourceKind: "local", bindings: [], bindingSummary: { totalCount: 0, scopeCounts: [] } });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    await expect(binding.client.skills.listSkills(true)).resolves.toEqual([]);
    await expect(binding.client.skills.updateLocalSkill("skill-1", { name: "Skill", slug: "skill", markdownBody: "# Skill" })).resolves.toMatchObject({ id: "skill-1" });
  });

  test("routes project secret settings CRUD through the remote API surface", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as Record<string, unknown> : undefined;
      if (url === "https://orchestra.example.test/api/v1/project-settings/secrets?projectSlug=test-project") {
        expect(init?.method ?? "GET").toBe("GET");
        return jsonResponse({ projectSlug: "test-project", availability: { status: "available", message: null }, secrets: [] });
      }
      if (url === "https://orchestra.example.test/api/v1/project-settings/secrets" && (init?.method ?? "GET") === "POST") {
        expect(body).toEqual({ projectSlug: "test-project", secretKey: "OPENAI_API_KEY", description: "Primary", value: "sk-create" });
        return jsonResponse({ projectSlug: "test-project", availability: { status: "available", message: null }, secrets: [{ secretKey: "OPENAI_API_KEY", description: "Primary", valueState: "ready" }] });
      }
      if (url === "https://orchestra.example.test/api/v1/project-settings/secrets/OPENAI_API_KEY" && init?.method === "PATCH") {
        expect(body).toEqual({ projectSlug: "test-project", description: "Rotated", value: "sk-update" });
        return jsonResponse({ projectSlug: "test-project", availability: { status: "available", message: null }, secrets: [{ secretKey: "OPENAI_API_KEY", description: "Rotated", valueState: "ready" }] });
      }
      if (url === "https://orchestra.example.test/api/v1/project-settings/secrets/OPENAI_API_KEY?projectSlug=test-project") {
        expect(init?.method).toBe("DELETE");
        return jsonResponse({ projectSlug: "test-project", availability: { status: "available", message: null }, secrets: [] });
      }
      throw new Error(`Unexpected fetch: ${url}`);
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    await expect(binding.client.settings.getProjectSecrets("test-project")).resolves.toMatchObject({ projectSlug: "test-project" });
    await expect(binding.client.settings.createProjectSecret({ secretKey: "OPENAI_API_KEY", description: "Primary", value: "sk-create" }, "test-project")).resolves.toMatchObject({
      projectSlug: "test-project",
      secrets: [expect.objectContaining({ secretKey: "OPENAI_API_KEY", description: "Primary" })],
    });
    await expect(binding.client.settings.updateProjectSecret({ secretKey: "OPENAI_API_KEY", description: "Rotated", value: "sk-update" }, "test-project")).resolves.toMatchObject({
      projectSlug: "test-project",
      secrets: [expect.objectContaining({ secretKey: "OPENAI_API_KEY", description: "Rotated" })],
    });
    await expect(binding.client.settings.deleteProjectSecret("OPENAI_API_KEY", "test-project")).resolves.toMatchObject({
      projectSlug: "test-project",
      secrets: [],
    });
  });

  test("routes hosted-web Harness host-admin methods through the remote API surface", async () => {
    const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const method = init?.method ?? "GET";
      const body = typeof init?.body === "string" ? JSON.parse(init.body) as unknown : undefined;

      if (url === "https://orchestra.example.test/api/v1/harness/runtime-settings" && method === "GET") {
        return jsonResponse({ extraExtensions: [], defaultCompactionWindow: "10%", updatedAt: null });
      }
      if (url === "https://orchestra.example.test/api/v1/harness/runtime-settings" && method === "PATCH") {
        expect(body).toEqual({ extraExtensions: ["./mobile.ts"], defaultCompactionWindow: "16000" });
        return jsonResponse({ extraExtensions: ["./mobile.ts"], defaultCompactionWindow: "16000", updatedAt: "now" });
      }
      if (url === "https://orchestra.example.test/api/v1/harness/setup-state" && method === "GET") {
        return jsonResponse({ status: "ready", availableProviders: [] });
      }
      if (url === "https://orchestra.example.test/api/v1/harness/provider-api-key" && method === "POST") {
        expect(body).toEqual({ providerId: "anthropic", apiKey: "sk-test" });
        return jsonResponse({ status: "ready", availableProviders: [{ id: "anthropic", connected: true }] });
      }
      if (url === "https://orchestra.example.test/api/v1/harness/models-json" && method === "GET") {
        return jsonResponse("{\"providers\":[]}");
      }
      if (url === "https://orchestra.example.test/api/v1/harness/models-json" && method === "POST") {
        expect(body).toEqual({ content: "{}" });
        return jsonResponse({ status: "ready", availableProviders: [] });
      }
      if (url === "https://orchestra.example.test/api/v1/harness/oauth/start" && method === "POST") {
        expect(body).toEqual({ providerId: "github-copilot", methodId: "device" });
        return jsonResponse({ providerId: "github-copilot", status: "running" });
      }
      throw new Error(`Unexpected fetch: ${method} ${url}`);
    });

    const binding = createRemoteApiOrchestraClientBinding(createBootstrap("same_origin_cookie"), {
      fetchImpl,
    });

    expect(binding.client.hostAdmin?.harness.getSetupState).toBeDefined();
    await expect(binding.client.hostAdmin!.harness.getRuntimeSettings()).resolves.toMatchObject({ defaultCompactionWindow: "10%" });
    await expect(binding.client.hostAdmin!.harness.updateRuntimeSettings({ extraExtensions: ["./mobile.ts"], defaultCompactionWindow: "16000" })).resolves.toMatchObject({ extraExtensions: ["./mobile.ts"] });
    await expect(binding.client.hostAdmin!.harness.getSetupState()).resolves.toMatchObject({ status: "ready" });
    await expect(binding.client.hostAdmin!.harness.setProviderApiKey("anthropic", "sk-test")).resolves.toMatchObject({ status: "ready" });
    await expect(binding.client.hostAdmin!.harness.getModelsJson()).resolves.toBe("{\"providers\":[]}");
    await expect(binding.client.hostAdmin!.harness.saveModelsJson("{}")).resolves.toMatchObject({ status: "ready" });
    await expect(binding.client.hostAdmin!.harness.startOAuthFlow("github-copilot", "device")).resolves.toMatchObject({ providerId: "github-copilot" });
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
