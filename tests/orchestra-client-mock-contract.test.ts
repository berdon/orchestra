import { afterEach, beforeEach, expect, vi } from "vitest";

import {
  emitMockInboxChange,
  emitMockSessionChange,
  emitMockSessionStream,
  emitMockTaskChange,
} from "../src/lib/mockOrchestra/events";
import { createMockOrchestraClient } from "../src/lib/orchestraClient/mockClient";
import type { OrchestraClientContractHarness } from "./orchestra-client-contract-suite";
import { runOrchestraClientContractSuite } from "./orchestra-client-contract-suite";
import type { OrchestraClientServiceBindings } from "../src/lib/orchestraClient/serviceBindings";
import type { AppInfo, SessionRecord, TaskDetail, TaskListOptions, TaskSummary } from "../src/types";

class TestCustomEvent<T = unknown> extends Event {
  detail: T;

  constructor(type: string, init?: CustomEventInit<T>) {
    super(type);
    this.detail = init?.detail as T;
  }
}

function createTestWindow() {
  const target = new EventTarget();
  return {
    addEventListener: target.addEventListener.bind(target),
    removeEventListener: target.removeEventListener.bind(target),
    dispatchEvent: target.dispatchEvent.bind(target),
  } as Pick<Window, "addEventListener" | "removeEventListener" | "dispatchEvent">;
}

const taskListResult: TaskSummary[] = [];
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

function createStubServices(): {
  services: OrchestraClientServiceBindings;
  taskListCalls: TaskListOptions[];
  completionCalls: Array<{ taskId: string; outcome: string; notes?: string }>;
  sessionCalls: Array<{ operation: "subscribe" | "unsubscribe"; sessionId: string }>;
} {
  const taskListCalls: TaskListOptions[] = [];
  const completionCalls: Array<{ taskId: string; outcome: string; notes?: string }> = [];
  const sessionCalls: Array<{ operation: "subscribe" | "unsubscribe"; sessionId: string }> = [];
  const appInfo: AppInfo = {
    appName: "Orchestra",
    environment: "browser",
    backendStatus: "mock",
    versionDisplay: "0.1.0-test",
    dispatchBlocked: false,
    dispatchBlockedReason: null,
    piRuntimeDiagnostics: null,
  };

  return {
    services: {
      app: {
        getInfo: vi.fn(async () => appInfo),
        reportError: vi.fn(async () => "reported"),
      },
      catalog: {
        listProjects: vi.fn(async () => []),
        getProject: vi.fn(async () => { throw new Error("unused"); }),
        listAgents: vi.fn(async () => []),
        listRoles: vi.fn(async () => []),
        listWorkflows: vi.fn(async () => []),
        getWorkflow: vi.fn(async () => { throw new Error("unused"); }),
      },
      projects: {} as OrchestraClientServiceBindings["projects"],
      settings: {} as OrchestraClientServiceBindings["settings"],
      workers: {} as OrchestraClientServiceBindings["workers"],
      workflows: {} as OrchestraClientServiceBindings["workflows"],
      policies: {} as OrchestraClientServiceBindings["policies"],
      channels: {} as OrchestraClientServiceBindings["channels"],
      skills: {} as OrchestraClientServiceBindings["skills"],
      tasks: {
        list: vi.fn(async (options?: TaskListOptions) => {
          taskListCalls.push(options ?? {});
          return taskListResult;
        }),
        get: vi.fn(async () => taskDetail),
        create: vi.fn(async () => taskDetail),
        update: vi.fn(async () => taskDetail),
        remove: vi.fn(async () => taskDetail),
        listTodos: vi.fn(async () => []),
        listUnfinishedTodos: vi.fn(async () => []),
        addTodo: vi.fn(async () => { throw new Error("unused"); }),
        markTodoFinished: vi.fn(async () => { throw new Error("unused"); }),
        markTodoUnfinished: vi.fn(async () => { throw new Error("unused"); }),
        deleteTodo: vi.fn(async () => { throw new Error("unused"); }),
        listComments: vi.fn(async () => []),
        comment: vi.fn(async () => { throw new Error("unused"); }),
        updateComment: vi.fn(async () => { throw new Error("unused"); }),
        deleteComment: vi.fn(async () => { throw new Error("unused"); }),
        markCommentsRead: vi.fn(async () => taskDetail),
        searchCommentFileMentions: vi.fn(async () => []),
        listMessages: vi.fn(async () => []),
        addDependency: vi.fn(async () => { throw new Error("unused"); }),
        removeDependency: vi.fn(async () => { throw new Error("unused"); }),
        listFileReferences: vi.fn(async () => []),
        addFileReference: vi.fn(async () => { throw new Error("unused"); }),
        setDefaultFileReference: vi.fn(async () => { throw new Error("unused"); }),
        removeFileReference: vi.fn(async () => { throw new Error("unused"); }),
        getFileContent: vi.fn(async () => ""),
        addAttachment: vi.fn(async () => { throw new Error("unused"); }),
        downloadAttachment: vi.fn(async () => undefined),
        removeAttachment: vi.fn(async () => { throw new Error("unused"); }),
        listSchedules: vi.fn(async () => []),
        getSchedule: vi.fn(async () => { throw new Error("unused"); }),
        createSchedule: vi.fn(async () => { throw new Error("unused"); }),
        updateSchedule: vi.fn(async () => { throw new Error("unused"); }),
        deleteSchedule: vi.fn(async () => { throw new Error("unused"); }),
        dispatch: vi.fn(async () => taskDetail),
        complete: vi.fn(async (taskId, outcome, notes) => {
          completionCalls.push({ taskId, outcome, notes });
          return taskDetail;
        }),
        approveReview: vi.fn(async () => taskDetail),
        approveCompletion: vi.fn(async () => taskDetail),
        markNeedsWork: vi.fn(async () => taskDetail),
        resume: vi.fn(async () => taskDetail),
        pause: vi.fn(async () => taskDetail),
        stopActivity: vi.fn(async () => taskDetail),
        reassign: vi.fn(async () => taskDetail),
        manualWhip: vi.fn(async () => taskDetail),
        resetRuntime: vi.fn(async () => taskDetail),
      },
      inbox: {
        list: vi.fn(async () => []),
        send: vi.fn(async () => { throw new Error("unused"); }),
        markRead: vi.fn(async () => []),
        archive: vi.fn(async () => []),
      },
      sessions: {
        list: vi.fn(async () => []),
        get: vi.fn(async () => sessionRecord),
        getRuntimeDetails: vi.fn(async () => { throw new Error("unused"); }),
        getStats: vi.fn(async () => { throw new Error("unused"); }),
        create: vi.fn(async () => sessionRecord),
        createContextual: vi.fn(async () => sessionRecord),
        remove: vi.fn(async () => undefined),
        resume: vi.fn(async () => sessionRecord),
        subscribe: vi.fn(async (sessionId: string) => {
          sessionCalls.push({ operation: "subscribe", sessionId });
          return { ...sessionRecord, id: sessionId, subscribed: true };
        }),
        unsubscribe: vi.fn(async (sessionId: string) => {
          sessionCalls.push({ operation: "unsubscribe", sessionId });
          return { ...sessionRecord, id: sessionId, subscribed: false };
        }),
        stopRuntime: vi.fn(async () => sessionRecord),
        getModelState: vi.fn(async () => { throw new Error("unused"); }),
        setModel: vi.fn(async () => { throw new Error("unused"); }),
        compact: vi.fn(async () => sessionRecord),
        reload: vi.fn(async () => sessionRecord),
        sendMessage: vi.fn(async () => { throw new Error("unused"); }),
      },
    },
    taskListCalls,
    completionCalls,
    sessionCalls,
  };
}

beforeEach(() => {
  vi.stubGlobal("window", createTestWindow());
  vi.stubGlobal("CustomEvent", TestCustomEvent);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

async function createHarness(): Promise<OrchestraClientContractHarness> {
  const { services, taskListCalls, completionCalls, sessionCalls } = createStubServices();
  const client = createMockOrchestraClient(services);

  return {
    client,
    expectedBootstrap: {
      hostKind: "mock",
      authMode: "none",
    },
    async verifyTaskListDefaults() {
      await expect(client.tasks.list()).resolves.toEqual(taskListResult);
      expect(taskListCalls).toEqual([{}]);
    },
    async verifyCompletionOutcomes() {
      await expect(client.tasks.complete("task-123", "success", "Looks good")).resolves.toEqual(taskDetail);
      await expect(client.tasks.complete("task-123", "failure", "Needs work")).resolves.toEqual(taskDetail);
      await expect(client.tasks.complete("task-123", "needs_user", "Need review")).resolves.toEqual(taskDetail);
      expect(completionCalls).toEqual([
        { taskId: "task-123", outcome: "success", notes: "Looks good" },
        { taskId: "task-123", outcome: "failure", notes: "Needs work" },
        { taskId: "task-123", outcome: "needs_user", notes: "Need review" },
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
      expect(sessionCalls).toEqual([
        { operation: "subscribe", sessionId: "session-123" },
        { operation: "unsubscribe", sessionId: "session-123" },
      ]);
    },
    async emitSharedEvents() {
      emitMockTaskChange({ taskIds: ["task-123"], reason: "task.updated" });
      emitMockSessionChange({ sessionIds: ["session-123"], reason: "session.updated" });
      emitMockSessionStream({
        sessionId: "session-123",
        runId: "run-123",
        event: { type: "assistant.delta", text: "hello" },
        receivedAt: "2026-04-23T00:00:00.000Z",
      });
      emitMockInboxChange({ deliveryIds: ["delivery-123"], reason: "mail.read" });
    },
  };
}

runOrchestraClientContractSuite("mock", createHarness);
