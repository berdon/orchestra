import { afterEach, expect, vi } from "vitest";

import {
  createRemoteApiOrchestraClientBinding,
  type OrchestraClientBootstrap,
} from "../src/lib/orchestraClient";
import type { OrchestraClientContractHarness } from "./orchestra-client-contract-suite";
import { runOrchestraClientContractSuite } from "./orchestra-client-contract-suite";
import type { SessionRecord, TaskDetail } from "../src/types";

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
    queueMicrotask(() => {
      this.onopen?.({} as Event);
      this.emitConnected();
    });
  }

  send(data: string) {
    this.sent.push(data);
    try {
      const parsed = JSON.parse(data) as { type?: string; sessionId?: string };
      if (parsed.type === "session.subscribe" && parsed.sessionId) {
        queueMicrotask(() => {
          this.emitSubscriptionConfirmed(parsed.sessionId!, true);
        });
      }
      if (parsed.type === "session.unsubscribe" && parsed.sessionId) {
        queueMicrotask(() => {
          this.emitSubscriptionConfirmed(parsed.sessionId!, false);
        });
      }
    } catch {
      // noop for test helper
    }
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

const bootstrap: OrchestraClientBootstrap = {
  contractVersion: "2026-04-23",
  bootstrappedAt: "2026-04-23T00:00:00.000Z",
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

const taskDetail: TaskDetail = {
  id: "task-123",
  projectId: "project-1",
  number: "ORC-123",
  title: "Contract task",
  description: null,
  type: "task",
  status: "ready",
  priority: "P1",
  workflowId: null,
  currentLaneId: null,
  assigneeType: "unassigned",
  assigneeId: null,
  repositoryId: null,
  repositoryIds: [],
  parentTaskId: null,
  whipMaxAttempts: 10,
  archived: false,
  commentCount: 0,
  unreadCommentCount: 0,
  laneRunCount: 0,
  childCount: 0,
  completedChildCount: 0,
  inProgressChildCount: 0,
  blockedChildCount: 0,
  blockedByCount: 0,
  blockingCount: 0,
  attachmentCount: 0,
  dependencyBlocked: false,
  activeLaneAssignmentStatus: null,
  readyForDispatch: true,
  tags: [],
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
  parent: null,
  lineage: [],
  children: [],
  blockedBy: [],
  blocking: [],
  attachments: [],
  taskRepositories: [],
  fileReferences: [],
  comments: [],
  todos: [],
  laneRuns: [],
  activeLaneAssignment: null,
};

const sessionRecord: SessionRecord = {
  id: "session-123",
  title: "Contract session",
  status: "running",
  createdAt: "2026-04-23T00:00:00.000Z",
  updatedAt: "2026-04-23T00:00:00.000Z",
  subscribed: true,
  events: [],
};

afterEach(() => {
  FakeWebSocket.instances = [];
  vi.restoreAllMocks();
});

async function createHarness(): Promise<OrchestraClientContractHarness> {
  const requests: Array<{ method: string; url: string; body?: unknown }> = [];

  const fetchImpl = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const method = init?.method ?? "GET";
    const url = String(input);
    let body: unknown;
    if (typeof init?.body === "string") {
      body = JSON.parse(init.body);
    }
    requests.push({ method, url, body });

    if (url.endsWith("/api/v1/tasks?includeArchived=false&tagMatch=all&sortBy=updatedAt&sortDirection=desc")) {
      return jsonResponse([]);
    }
    if (url.endsWith("/api/v1/tasks/task-123/complete/success")) {
      return jsonResponse(taskDetail);
    }
    if (url.endsWith("/api/v1/tasks/task-123/complete/failure")) {
      return jsonResponse(taskDetail);
    }
    if (url.endsWith("/api/v1/tasks/task-123/complete/needs-user")) {
      return jsonResponse(taskDetail);
    }
    if (url.endsWith("/api/v1/sessions/session-123/subscribe")) {
      return jsonResponse(sessionRecord);
    }
    if (url.endsWith("/api/v1/sessions/session-123/unsubscribe")) {
      return jsonResponse({ ...sessionRecord, subscribed: false });
    }
    throw new Error(`Unexpected fetch: ${method} ${url}`);
  });

  const binding = createRemoteApiOrchestraClientBinding(bootstrap, {
    fetchImpl,
    webSocketFactory: (url) => new FakeWebSocket(url) as unknown as WebSocket,
  });

  const client = binding.client;

  return {
    adapterName: "remote_api",
    client,
    expectedBootstrap: {
      hostKind: "remote_api",
      authMode: "same_origin_cookie",
    },
    async verifyTaskListDefaults() {
      await expect(client.tasks.list()).resolves.toEqual([]);
      expect(requests).toEqual([
        {
          method: "GET",
          url: "https://orchestra.example.test/api/v1/tasks?includeArchived=false&tagMatch=all&sortBy=updatedAt&sortDirection=desc",
          body: undefined,
        },
      ]);
    },
    async verifyCompletionOutcomes() {
      await expect(client.tasks.complete("task-123", "success", "Looks good")).resolves.toEqual(taskDetail);
      await expect(client.tasks.complete("task-123", "failure", "Needs work")).resolves.toEqual(taskDetail);
      await expect(client.tasks.complete("task-123", "needs_user", "Need review")).resolves.toEqual(taskDetail);

      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://orchestra.example.test/api/v1/tasks/task-123/complete/success",
          body: { notes: "Looks good" },
        },
        {
          method: "POST",
          url: "https://orchestra.example.test/api/v1/tasks/task-123/complete/failure",
          body: { notes: "Needs work" },
        },
        {
          method: "POST",
          url: "https://orchestra.example.test/api/v1/tasks/task-123/complete/needs-user",
          body: { notes: "Need review" },
        },
      ]);
    },
    async verifySessionSubscriptionSemantics() {
      await expect(client.sessions.subscribe("session-123")).resolves.toMatchObject({
        id: "session-123",
        subscribed: true,
      });
      await expect(client.sessions.unsubscribe("session-123")).resolves.toMatchObject({
        id: "session-123",
        subscribed: false,
      });

      expect(requests).toEqual([
        {
          method: "POST",
          url: "https://orchestra.example.test/api/v1/sessions/session-123/subscribe",
          body: undefined,
        },
        {
          method: "POST",
          url: "https://orchestra.example.test/api/v1/sessions/session-123/unsubscribe",
          body: undefined,
        },
      ]);

      expect(FakeWebSocket.instances).toHaveLength(1);
      expect(FakeWebSocket.instances[0]?.sent).toEqual([
        JSON.stringify({ type: "session.subscribe", sessionId: "session-123" }),
        JSON.stringify({ type: "session.unsubscribe", sessionId: "session-123" }),
      ]);
    },
    async emitSharedEvents() {
      await client.sessions.subscribe("session-123");
      const socket = FakeWebSocket.instances[0];
      if (!socket) {
        throw new Error("Expected remote websocket to be connected before emitting events.");
      }
      socket.emitEvent({
        id: "remote-event-task",
        sequence: 1,
        topic: "task.updated",
        timestamp: "2026-04-23T00:00:00.000Z",
        payload: {
          taskIds: ["task-123"],
          reason: "task.updated",
        },
      });
      socket.emitEvent({
        id: "remote-event-session",
        sequence: 2,
        topic: "session.updated",
        timestamp: "2026-04-23T00:00:00.000Z",
        payload: {
          sessionIds: ["session-123"],
          reason: "session.updated",
        },
      });
      socket.emitEvent({
        id: "remote-event-stream",
        sequence: 3,
        topic: "session.stream",
        timestamp: "2026-04-23T00:00:00.000Z",
        payload: {
          sessionId: "session-123",
          runId: "run-123",
          event: { type: "assistant.delta", text: "hello" },
          receivedAt: "2026-04-23T00:00:00.000Z",
        },
      });
      socket.emitEvent({
        id: "remote-event-inbox",
        sequence: 4,
        topic: "inbox.updated",
        timestamp: "2026-04-23T00:00:00.000Z",
        payload: {
          deliveryIds: ["delivery-123"],
          reason: "mail.read",
        },
      });
    },
  };
}

function jsonResponse(body: unknown, status = 200): Response {
  return {
    ok: status >= 200 && status < 300,
    status,
    text: async () => JSON.stringify(body),
  } satisfies Partial<Response> as Response;
}

runOrchestraClientContractSuite("remote_api", createHarness);
