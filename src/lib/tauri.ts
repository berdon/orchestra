import { invoke } from "@tauri-apps/api/core";
import { sortSessionRecords } from "./sessionList";
import { getActiveProjectId, getProjectRuntimeCwd } from "./projects";
import type {
  AgentSummary,
  AppInfo,
  ArchiveMailboxMessagesInput,
  BridgeCleanupEvent,
  PiExecutableDiagnostic,
  BridgeDiagnostics,
  DomainEvent,
  InboxChangeEvent,
  JsonValue,
  LogEntry,
  LogLevel,
  MailboxMessage,
  MarkMailboxMessagesReadInput,
  QueuedSessionMessage,
  RoleSummary,
  SendMailboxMessageInput,
  SessionChangeEvent,
  SessionEvent,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionStreamEnvelope,
  TaskAttachment,
  TaskAttachmentInput,
  TaskFileReference,
  TaskFileReferenceInput,
  TaskComment,
  TaskCommentFileMentionCandidate,
  TaskChangeEvent,
  TaskCommentInput,
  TaskCommentUpdateInput,
  TaskDependency,
  TaskDetail,
  TaskLaneAssignment,
  TaskLaneRun,
  TaskScheduleDetail,
  TaskScheduleOccurrence,
  TaskScheduleSummary,
  TaskScheduleTrigger,
  TaskScheduleUpsertInput,
  TaskSummary,
  TaskTodo,
  TaskTodoInput,
  TaskUpsertInput,
  WorkflowDefinition,
  WorkflowLane,
  WorkflowSummary,
  WorkflowUpsertInput,
  WorkflowValidationResult,
} from "../types";

const LOG_STORAGE_KEY = "orchestra.mock.logs";
const SESSION_STORAGE_KEY = "orchestra.mock.sessions";
const SESSION_MODEL_STORAGE_KEY = "orchestra.mock.session-models";
const WORKFLOW_STORAGE_KEY = "orchestra.mock.workflows";
const TASK_STORAGE_KEY = "orchestra.mock.tasks";
const TASK_FILE_CONTENT_STORAGE_KEY = "orchestra.mock.file-contents";
const TASK_DEPENDENCY_STORAGE_KEY = "orchestra.mock.task-dependencies";
const MAILBOX_STORAGE_KEY = "orchestra.mock.mailbox";
const AGENT_STORAGE_KEY = "orchestra.mock.agents";
const AGENT_RUNTIME_STORAGE_KEY = "orchestra.mock.agent-runtimes";
const AGENT_QUEUE_STORAGE_KEY = "orchestra.mock.agent-queue";
const ROLE_STORAGE_KEY = "orchestra.mock.roles";
const ROLE_QUEUE_STORAGE_KEY = "orchestra.mock.role-queue";
const ROLE_INSTANCE_STORAGE_KEY = "orchestra.mock.role-instances";
const BRIDGE_DIAGNOSTICS_STORAGE_KEY = "orchestra.mock.bridge-diagnostics";
const ACTIVE_RUN_STORAGE_KEY = "orchestra.mock.active-session-runs";
const DISMISSED_SESSION_STORAGE_KEY = "orchestra.mock.dismissed-sessions";
const PROJECT_SETTINGS_STORAGE_KEY = "orchestra.mock.project-settings";
const TASK_SCHEDULE_STORAGE_KEY = "orchestra.mock.task-schedules";
const DOMAIN_EVENT_STORAGE_KEY = "orchestra.mock.domain-events";
const CURRENT_PROJECT_ID = "orchestra";

type OrchestraWindowGlobals = Window & {
  __ORCHESTRA_WINDOW_KIND__?: string;
  __ORCHESTRA_AGENT_TERMINAL_SESSION_ID__?: string;
};

function getInjectedWindowKind() {
  const windowKind = (window as OrchestraWindowGlobals).__ORCHESTRA_WINDOW_KIND__;
  return typeof windowKind === "string" ? windowKind : null;
}

function getStoredMockProjectSettings() {
  const value = window.localStorage.getItem(PROJECT_SETTINGS_STORAGE_KEY);
  return value ? (JSON.parse(value) as { general?: { autoDispatchOnBlockerCompletion?: boolean } }) : {};
}

function getStoredMockProjectsForSettings() {
  const value = window.localStorage.getItem("orchestra.mock.projects");
  return value
    ? (JSON.parse(value) as Array<{ id: string; slug: string }>)
    : [{ id: CURRENT_PROJECT_ID, slug: CURRENT_PROJECT_ID }];
}

export function getInitialLogsWindowFlag() {
  return getInjectedWindowKind() === "logs" || new URLSearchParams(window.location.search).get("view") === "logs";
}

export function getInitialAgentTerminalWindowFlag() {
  return getInjectedWindowKind() === "agent-terminal" || new URLSearchParams(window.location.search).get("view") === "agent-terminal";
}

export function getInitialAgentTerminalSessionId() {
  const injectedSessionId = (window as OrchestraWindowGlobals).__ORCHESTRA_AGENT_TERMINAL_SESSION_ID__;
  if (typeof injectedSessionId === "string" && injectedSessionId.length > 0) {
    return injectedSessionId;
  }
  return new URLSearchParams(window.location.search).get("sessionId");
}

function sessionStorageKey(projectId?: string | null) {
  return `${SESSION_STORAGE_KEY}.${projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID}`;
}

function sessionModelStorageKey(projectId?: string | null) {
  return `${SESSION_MODEL_STORAGE_KEY}.${projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID}`;
}

function dismissedSessionStorageKey(projectId?: string | null) {
  return `${DISMISSED_SESSION_STORAGE_KEY}.${projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID}`;
}

const MOCK_MODELS: SessionModel[] = [
  {
    id: "claude-sonnet-4-20250514",
    name: "Claude Sonnet 4",
    provider: "anthropic",
    api: "anthropic-messages",
    reasoning: true,
  },
  {
    id: "gpt-5.4",
    name: "GPT-5.4",
    provider: "openai-codex",
    api: "openai-codex-responses",
    reasoning: true,
  },
  {
    id: "gemini-2.5-pro",
    name: "Gemini 2.5 Pro",
    provider: "google",
    api: "google-generative-ai",
    reasoning: true,
  },
];

export function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function slugify(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "workflow";
}

function normalizeLogLevel(_level: LogLevel, target: string): LogLevel {
  if (target === "sessions.rpc.event") {
    return "debug";
  }

  return "info";
}

function normalizeLogEntry(entry: LogEntry): LogEntry {
  const normalizedLevel = normalizeLogLevel(entry.level, entry.target);
  return normalizedLevel === entry.level ? entry : { ...entry, level: normalizedLevel };
}

function createLogEntry(level: LogLevel, target: string, message: string): LogEntry {
  return {
    id: createId("log"),
    level: normalizeLogLevel(level, target),
    target,
    message,
    timestamp: nowIso(),
  };
}

function createEvent(kind: SessionEvent["kind"], message: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: createId("event"),
    kind,
    message,
    timestamp: nowIso(),
    ...overrides,
  };
}

function getStoredValue<T>(key: string): T | null {
  const value = window.localStorage.getItem(key);
  return value ? (JSON.parse(value) as T) : null;
}

function setStoredValue<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function getStoredMailboxMessages() {
  return getStoredValue<MailboxMessage[]>(MAILBOX_STORAGE_KEY) ?? [];
}

function saveStoredMailboxMessages(messages: MailboxMessage[]) {
  setStoredValue(MAILBOX_STORAGE_KEY, messages);
}

function emitMockSessionStream(event: SessionStreamEnvelope) {
  window.dispatchEvent(new CustomEvent("orchestra:session-stream", { detail: event }));
}

export function emitMockSessionChange(event: SessionChangeEvent) {
  window.dispatchEvent(new CustomEvent("orchestra:session-change", { detail: event }));
}

function emitMockInboxChange(event: InboxChangeEvent) {
  window.dispatchEvent(new CustomEvent("orchestra:inbox-change", { detail: event }));
}

function emitMockTaskChange(event: TaskChangeEvent) {
  window.dispatchEvent(new CustomEvent("orchestra:task-change", { detail: event }));
}

function createMockSessionEnvelope(sessionId: string, runId: string, event: JsonValue): SessionStreamEnvelope {
  return {
    sessionId,
    runId,
    event,
    receivedAt: nowIso(),
  };
}

function seedMockLogs(): LogEntry[] {
  return [
    createLogEntry("info", "app.bootstrap", "Frontend scaffold initialized"),
    createLogEntry("info", "session.mock", "Using browser-backed session fallback until Tauri backend is running"),
  ];
}

function seedMockSessions(): SessionRecord[] {
  const timestamp = nowIso();
  return [
    {
      id: createId("session"),
      title: "Session-first spike",
      status: "idle",
      createdAt: timestamp,
      updatedAt: timestamp,
      subscribed: false,
      events: [
        createEvent("system", "Mock session created in browser fallback mode."),
        createEvent("assistant", "Ready when you are. Create a session, resume it, or send me a message."),
      ],
    },
  ];
}

function seedMockWorkflows(): WorkflowDefinition[] {
  const timestamp = nowIso();
  const planId = createId("lane");
  const buildId = createId("lane");
  const reviewId = createId("lane");

  return [
    {
      id: createId("workflow"),
      slug: "development",
      name: "Development",
      description: "Plan, implement, and review work in a lightweight reusable flow.",
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
      lanes: [
        {
          id: planId,
          key: "plan",
          name: "Plan",
          order: 0,
          assignedEntityType: "user",
          assignedEntityId: null,
          entryPromptTemplate: "Define the approach before implementation begins.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "lane",
          successTargetLaneId: buildId,
          failureTransitionType: "user_intervention",
          failureTargetLaneId: null,
        },
        {
          id: buildId,
          key: "implement",
          name: "Implement",
          order: 1,
          assignedEntityType: "role",
          assignedEntityId: "developer",
          entryPromptTemplate: "Carry out the approved implementation plan.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "lane",
          successTargetLaneId: reviewId,
          failureTransitionType: "lane",
          failureTargetLaneId: planId,
        },
        {
          id: reviewId,
          key: "review",
          name: "Review",
          order: 2,
          assignedEntityType: "user",
          assignedEntityId: null,
          entryPromptTemplate: "Check the completed work and decide what happens next.",
          useSeparateWorktree: false,
          requireUserApprovalOnSuccess: false,
          successTransitionType: "end",
          successTargetLaneId: null,
          failureTransitionType: "lane",
          failureTargetLaneId: buildId,
        },
      ],
    },
  ];
}

function ensureMockLogs() {
  const existing = getStoredValue<LogEntry[]>(LOG_STORAGE_KEY);
  if (existing) {
    const normalized = existing.map(normalizeLogEntry);
    const changed = normalized.some((entry, index) => entry.level !== existing[index]?.level);
    if (changed) {
      setStoredValue(LOG_STORAGE_KEY, normalized);
    }
    return normalized;
  }

  const seeded = seedMockLogs();
  setStoredValue(LOG_STORAGE_KEY, seeded);
  return seeded;
}

function ensureMockSessions(projectId?: string | null) {
  const existing = getStoredValue<SessionRecord[]>(sessionStorageKey(projectId));
  if (existing) {
    return existing;
  }

  const resolvedProjectId = projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID;
  if (projectId && projectId !== (getActiveProjectId() ?? CURRENT_PROJECT_ID)) {
    return [];
  }

  const seeded = seedMockSessions();
  setStoredValue(sessionStorageKey(resolvedProjectId), seeded);
  return seeded;
}

function ensureMockBridgeDiagnostics(): BridgeDiagnostics {
  const existing = getStoredValue<BridgeDiagnostics>(BRIDGE_DIAGNOSTICS_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const timestamp = nowIso();
  const seeded: BridgeDiagnostics = {
    instance: {
      instanceId: "bridge-instance-browser",
      url: "http://127.0.0.1:0",
      ownerPid: 0,
      startedAt: timestamp,
      heartbeatAt: timestamp,
      metadataPath: "/mock/.orchestra/bridge/bridge-instance-browser.json",
      activeClientCount: 0,
      inFlightRequestCount: 0,
    },
    clients: [],
    recentRequests: [],
    recentCleanupEvents: [],
  };
  setStoredValue(BRIDGE_DIAGNOSTICS_STORAGE_KEY, seeded);
  return seeded;
}

function getStoredMockAgents() {
  return getStoredValue<AgentSummary[]>(AGENT_STORAGE_KEY) ?? [];
}

function getStoredMockAgentRuntimes() {
  return getStoredValue<Array<Record<string, unknown>>>(AGENT_RUNTIME_STORAGE_KEY) ?? [];
}

function saveStoredMockAgentRuntimes(runtimes: Array<Record<string, unknown>>) {
  setStoredValue(AGENT_RUNTIME_STORAGE_KEY, runtimes);
}

function getStoredMockAgentQueue() {
  return getStoredValue<Array<Record<string, unknown>>>(AGENT_QUEUE_STORAGE_KEY) ?? [];
}

function saveStoredMockAgentQueue(entries: Array<Record<string, unknown>>) {
  setStoredValue(AGENT_QUEUE_STORAGE_KEY, entries);
}

function getStoredMockRoles() {
  return getStoredValue<RoleSummary[]>(ROLE_STORAGE_KEY) ?? [];
}

function getStoredMockRoleQueue() {
  return getStoredValue<Array<Record<string, unknown>>>(ROLE_QUEUE_STORAGE_KEY) ?? [];
}

function saveStoredMockRoleQueue(entries: Array<Record<string, unknown>>) {
  setStoredValue(ROLE_QUEUE_STORAGE_KEY, entries);
}

function getStoredMockRoleInstances() {
  return getStoredValue<Array<Record<string, unknown>>>(ROLE_INSTANCE_STORAGE_KEY) ?? [];
}

function saveStoredMockRoleInstances(instances: Array<Record<string, unknown>>) {
  setStoredValue(ROLE_INSTANCE_STORAGE_KEY, instances);
}

function migrateMockWorkflowWorkerRefs(workflows: WorkflowDefinition[]) {
  const agentRefs = new Map<string, string>(getStoredMockAgents().map((agent) => [agent.id, agent.slug]));
  const roleRefs = new Map<string, string>(getStoredMockRoles().map((role) => [role.id, role.slug]));

  return workflows.map((workflow) => ({
    ...workflow,
    lanes: workflow.lanes.map((lane): WorkflowLane => {
      if (lane.assignedEntityType === "agent" && lane.assignedEntityId && agentRefs.has(lane.assignedEntityId)) {
        return {
          ...lane,
          assignedEntityId: agentRefs.get(lane.assignedEntityId) ?? lane.assignedEntityId,
        };
      }

      if (lane.assignedEntityType === "role" && lane.assignedEntityId && roleRefs.has(lane.assignedEntityId)) {
        return {
          ...lane,
          assignedEntityId: roleRefs.get(lane.assignedEntityId) ?? lane.assignedEntityId,
        };
      }

      return lane;
    }),
  }));
}

function ensureMockWorkflows() {
  const existing = getStoredValue<WorkflowDefinition[]>(WORKFLOW_STORAGE_KEY);
  if (existing) {
    const migrated = migrateMockWorkflowWorkerRefs(existing);
    if (JSON.stringify(migrated) !== JSON.stringify(existing)) {
      setStoredValue(WORKFLOW_STORAGE_KEY, migrated);
    }
    return migrated;
  }

  const seeded = seedMockWorkflows();
  setStoredValue(WORKFLOW_STORAGE_KEY, seeded);
  return seeded;
}

function saveMockWorkflows(workflows: WorkflowDefinition[]) {
  setStoredValue(WORKFLOW_STORAGE_KEY, workflows);
}

function getMockSessionModels() {
  return getStoredValue<Record<string, SessionModel>>(sessionModelStorageKey()) ?? {};
}

function setMockSessionModels(models: Record<string, SessionModel>) {
  setStoredValue(sessionModelStorageKey(), models);
}

function getMockActiveSessionRuns() {
  return getStoredValue<Record<string, string>>(ACTIVE_RUN_STORAGE_KEY) ?? {};
}

function setMockActiveSessionRuns(runs: Record<string, string>) {
  setStoredValue(ACTIVE_RUN_STORAGE_KEY, runs);
}

function isMockRunStillActive(sessionId: string, runId: string) {
  return getMockActiveSessionRuns()[sessionId] === runId;
}

function ensureMockSessionModel(sessionId: string) {
  const models = getMockSessionModels();
  if (!models[sessionId]) {
    models[sessionId] = MOCK_MODELS[0]!;
    setMockSessionModels(models);
  }
  return models[sessionId]!;
}

function appendMockLog(level: LogLevel, target: string, message: string) {
  const logs = ensureMockLogs();
  const updated = [createLogEntry(level, target, message), ...logs].slice(0, 200);
  setStoredValue(LOG_STORAGE_KEY, updated);
}

function getDismissedMockSessionIds(projectId?: string | null) {
  return new Set(getStoredValue<string[]>(dismissedSessionStorageKey(projectId)) ?? []);
}

function saveDismissedMockSessionIds(ids: Iterable<string>, projectId?: string | null) {
  setStoredValue(dismissedSessionStorageKey(projectId), Array.from(new Set(ids)).sort());
}

function saveMockSessions(sessions: SessionRecord[], projectId?: string | null) {
  setStoredValue(sessionStorageKey(projectId), sessions);
}

function attachMockSessionTaskMetadata(session: SessionRecord, task: Pick<TaskDetail, "id" | "number" | "title">, workerType: string, workerName?: string | null) {
  return {
    ...session,
    taskId: task.id,
    taskNumber: task.number,
    taskTitle: task.title,
    workerType,
    workerName: workerName ?? null,
  } satisfies SessionRecord;
}

export function upsertMockSession(session: SessionRecord) {
  const sessions = ensureMockSessions().filter((entry) => entry.id !== session.id);
  saveMockSessions(sortSessions([session, ...sessions]));
}

export function createMockSessionRecord(title: string, openingAssistantMessage: string): SessionRecord {
  const timestamp = nowIso();
  return {
    id: createId("session"),
    title,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    subscribed: false,
    events: [
      createEvent("system", `${title} created from Orchestra runtime.`),
      createEvent("assistant", openingAssistantMessage),
    ],
  };
}

function ensureMockAgentMainSession(agentSlug: string, agentId: string) {
  const runtime = getStoredMockAgentRuntimes().find((entry) => entry.agentId === agentId && entry.projectId === CURRENT_PROJECT_ID) ?? null;
  const existingSessionId = typeof runtime?.mainSessionId === "string" ? runtime.mainSessionId : null;
  const existingSession = existingSessionId ? ensureMockSessions().find((entry) => entry.id === existingSessionId) ?? null : null;
  const session = existingSession ?? createMockSessionRecord(
    `${agentSlug} main session`.replace(/(^|\s)\S/g, (value) => value.toUpperCase()),
    `${agentSlug} is ready. This persistent session keeps the agent context for dispatched work.`,
  );

  ensureMockSessionModel(session.id);
  upsertMockSession(session);
  saveStoredMockAgentRuntimes(
    getStoredMockAgentRuntimes().map((entry) =>
      entry.agentId === agentId && entry.projectId === CURRENT_PROJECT_ID
        ? {
            ...entry,
            mainSessionId: session.id,
            runtimeCwd: (typeof entry.runtimeCwd === "string" && entry.runtimeCwd) ? entry.runtimeCwd : getProjectRuntimeCwd(CURRENT_PROJECT_ID),
            status: entry.currentQueueEntryId ? "running" : "idle",
            updatedAt: nowIso(),
          }
        : entry,
    ),
  );

  return session;
}

function updateMockSession(sessionId: string, updater: (session: SessionRecord) => SessionRecord) {
  const sessions = ensureMockSessions();
  const updated = sessions.map((session) => (session.id === sessionId ? updater(session) : session));
  saveMockSessions(updated);
  return updated.find((session) => session.id === sessionId) ?? null;
}

function sortSessions(sessions: SessionRecord[]) {
  return sortSessionRecords(sessions);
}

function generateAssistantReply(message: string) {
  return `Acknowledged: ${message}\n\nThis is the mock session layer. The UI flow for create, resume, subscribe, interaction, and model switching is wired and ready for the real pi backend.`;
}

function buildMockModelState(sessionId: string): SessionModelState {
  return {
    sessionId,
    currentModel: ensureMockSessionModel(sessionId),
    currentThinkingLevel: "medium",
    availableModels: MOCK_MODELS,
  };
}

function summarizeWorkflow(workflow: WorkflowDefinition): WorkflowSummary {
  return {
    id: workflow.id,
    slug: workflow.slug,
    name: workflow.name,
    description: workflow.description,
    archived: workflow.archived,
    laneCount: workflow.lanes.length,
    createdAt: workflow.createdAt,
    updatedAt: workflow.updatedAt,
  };
}

function seedMockTasks(): TaskDetail[] {
  const timestamp = nowIso();
  const workflow = ensureMockWorkflows()[0];
  const firstLane = workflow?.lanes[0];
  const secondLane = workflow?.lanes[1];

  const epicTaskId = createId("task");
  const planningTaskId = createId("task");
  const blockedTaskId = createId("task");
  const planningSessionId = createId("session");

  const tasks: TaskDetail[] = [
    {
      id: epicTaskId,
      projectId: CURRENT_PROJECT_ID,
      number: "ORC-1",
      title: "Define Orchestra task system",
      description: "Document the task model including hierarchy, dependencies, attachments, and task tools.",
      type: "epic",
      status: "ready",
      priority: "P1",
      workflowId: workflow?.id ?? null,
      currentLaneId: firstLane?.id ?? null,
      assigneeType: "user",
      assigneeId: null,
      repositoryId: null,
      repositoryIds: [],
      parentTaskId: null,
      archived: false,
      commentCount: 0,
      laneRunCount: 0,
      childCount: 0,
      completedChildCount: 0,
      inProgressChildCount: 0,
      blockedChildCount: 0,
      blockedByCount: 0,
      blockingCount: 0,
      attachmentCount: 0,
      dependencyBlocked: false,
      readyForDispatch: true,
      parent: null,
      lineage: [],
      children: [],
      blockedBy: [],
      blocking: [],
      attachments: [],
      taskRepositories: [],
      fileReferences: [],
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
      todos: [],
      laneRuns: [],
    },
    {
      id: planningTaskId,
      projectId: CURRENT_PROJECT_ID,
      number: "ORC-2",
      title: "Implement task foundation shell",
      description: "Add the first real Tasks page with list/detail editing so task orchestration can move out of placeholders.",
      type: "feature",
      status: "in_progress",
      priority: "P1",
      workflowId: workflow?.id ?? null,
      currentLaneId: secondLane?.id ?? null,
      assigneeType: "role",
      assigneeId: "developer",
      repositoryId: null,
      repositoryIds: [],
      parentTaskId: epicTaskId,
      archived: false,
      commentCount: 1,
      laneRunCount: 1,
      childCount: 0,
      completedChildCount: 0,
      inProgressChildCount: 0,
      blockedChildCount: 0,
      blockedByCount: 0,
      blockingCount: 0,
      attachmentCount: 0,
      dependencyBlocked: false,
      readyForDispatch: true,
      parent: null,
      lineage: [],
      children: [],
      blockedBy: [],
      blocking: [],
      attachments: [],
      taskRepositories: [],
      fileReferences: [],
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [
        {
          id: createId("task-comment"),
          taskId: planningTaskId,
          author: "User",
          message: "Start with persistence and a task list/detail shell before layering on graph features.",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ],
      todos: [],
      laneRuns: secondLane
        ? [
            {
              id: createId("lane-run"),
              taskId: planningTaskId,
              laneId: secondLane.id,
              sessionId: planningSessionId,
              result: "needs_user",
              notes: "Waiting on task persistence APIs.",
              startedAt: timestamp,
              completedAt: null,
            } satisfies TaskLaneRun,
          ]
        : [],
    },
    {
      id: blockedTaskId,
      projectId: CURRENT_PROJECT_ID,
      number: "ORC-3",
      title: "Plan hierarchy rollups",
      description: "Use the epic container to summarize child task progress and expose lineage in the task detail pane.",
      type: "task",
      status: "ready",
      priority: "P2",
      workflowId: workflow?.id ?? null,
      currentLaneId: firstLane?.id ?? null,
      assigneeType: "user",
      assigneeId: null,
      repositoryId: null,
      repositoryIds: [],
      parentTaskId: epicTaskId,
      archived: false,
      commentCount: 0,
      laneRunCount: 0,
      childCount: 0,
      completedChildCount: 0,
      inProgressChildCount: 0,
      blockedChildCount: 0,
      blockedByCount: 0,
      blockingCount: 0,
      attachmentCount: 0,
      dependencyBlocked: false,
      readyForDispatch: true,
      parent: null,
      lineage: [],
      children: [],
      blockedBy: [],
      blocking: [],
      attachments: [],
      taskRepositories: [],
      fileReferences: [],
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
      todos: [],
      laneRuns: [],
    },
  ];

  const dependencies: TaskDependency[] = [
    {
      id: createId("task-dependency"),
      blockerTaskId: planningTaskId,
      blockedTaskId,
      blocker: summarizeTask(tasks[1]!),
      blocked: summarizeTask(tasks[2]!),
      createdAt: timestamp,
    },
  ];

  saveMockTaskDependencies(dependencies);
  return enrichMockTasks(tasks, dependencies);
}

function ensureMockTaskDependencies() {
  return getStoredValue<TaskDependency[]>(TASK_DEPENDENCY_STORAGE_KEY) ?? [];
}

function saveMockTaskDependencies(dependencies: TaskDependency[]) {
  setStoredValue(TASK_DEPENDENCY_STORAGE_KEY, dependencies);
}

interface StoredTaskScheduleRecord {
  id: string;
  projectId: string;
  taskBlueprint: TaskUpsertInput;
  enabled: boolean;
  oneShot: boolean;
  overlapPolicy: string;
  trigger: TaskScheduleTrigger;
  nextFireAt?: string | null;
  lastFiredAt?: string | null;
  lastMaterializedTaskId?: string | null;
  lastError?: string | null;
  occurrences: TaskScheduleOccurrence[];
  createdAt: string;
  updatedAt: string;
}

function ensureMockDomainEvents() {
  return getStoredValue<DomainEvent[]>(DOMAIN_EVENT_STORAGE_KEY) ?? [];
}

function saveMockDomainEvents(events: DomainEvent[]) {
  setStoredValue(DOMAIN_EVENT_STORAGE_KEY, events);
}

function appendMockDomainEvent(
  topic: DomainEvent["topic"],
  entityType: string,
  entityId: string,
  payload: JsonValue,
  projectId?: string | null,
) {
  const events = ensureMockDomainEvents();
  const event: DomainEvent = {
    sequence: ((events.length > 0 ? events[events.length - 1]?.sequence : 0) ?? 0) + 1,
    id: createId("domain-event"),
    projectId: projectId ?? null,
    topic,
    entityType,
    entityId,
    payload,
    createdAt: nowIso(),
  };
  saveMockDomainEvents([...events, event]);
  return event;
}

function ensureMockTaskSchedules() {
  return getStoredValue<StoredTaskScheduleRecord[]>(TASK_SCHEDULE_STORAGE_KEY) ?? [];
}

function saveMockTaskSchedules(schedules: StoredTaskScheduleRecord[]) {
  setStoredValue(TASK_SCHEDULE_STORAGE_KEY, schedules);
}

function normalizeScheduleBlueprint(task: TaskUpsertInput): TaskUpsertInput {
  return {
    ...task,
    status: "ready",
    archived: false,
    currentLaneId: null,
  };
}

function parseTimeOfDayParts(value: string) {
  const match = value.trim().match(/^(\d{2}):(\d{2})$/);
  if (!match) {
    return null;
  }
  const hours = Number(match[1]);
  const minutes = Number(match[2]);
  if (!Number.isInteger(hours) || !Number.isInteger(minutes) || hours < 0 || hours > 23 || minutes < 0 || minutes > 59) {
    return null;
  }
  return { hours, minutes };
}

function getTimeZoneDateParts(date: Date, timeZone: string) {
  const formatter = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  });
  const parts = Object.fromEntries(formatter.formatToParts(date).map((part) => [part.type, part.value]));
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour),
    minute: Number(parts.minute),
  };
}

function addDaysToLocalDate(year: number, month: number, day: number, dayOffset: number) {
  const date = new Date(Date.UTC(year, month - 1, day + dayOffset));
  return {
    year: date.getUTCFullYear(),
    month: date.getUTCMonth() + 1,
    day: date.getUTCDate(),
  };
}

function daysInMonthUtc(year: number, month: number) {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function addMonthsToLocalDate(year: number, month: number, day: number, monthsToAdd: number) {
  const base = new Date(Date.UTC(year, month - 1 + monthsToAdd, 1));
  const nextYear = base.getUTCFullYear();
  const nextMonth = base.getUTCMonth() + 1;
  return {
    year: nextYear,
    month: nextMonth,
    day: Math.min(day, daysInMonthUtc(nextYear, nextMonth)),
  };
}

function zonedLocalDateTimeToUtcDate(year: number, month: number, day: number, hours: number, minutes: number, timeZone: string) {
  let utcMillis = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);
  const desiredUtc = Date.UTC(year, month - 1, day, hours, minutes, 0, 0);

  for (let attempt = 0; attempt < 4; attempt += 1) {
    const observed = getTimeZoneDateParts(new Date(utcMillis), timeZone);
    const observedUtc = Date.UTC(observed.year, observed.month - 1, observed.day, observed.hour, observed.minute, 0, 0);
    const diff = desiredUtc - observedUtc;
    if (diff === 0) {
      break;
    }
    utcMillis += diff;
  }

  return new Date(utcMillis);
}

function nextMockTimeFireAt(trigger: TaskScheduleTrigger, referenceIso: string) {
  if (trigger.type !== "time") {
    return null;
  }

  const reference = new Date(referenceIso);
  if (Number.isNaN(reference.getTime())) {
    throw new Error("trigger: Unable to parse schedule time trigger reference.");
  }

  switch (trigger.kind) {
    case "once":
      return trigger.at;
    case "everyMinutes":
      return new Date(reference.getTime() + Math.max(1, trigger.everyMinutes) * 60_000).toISOString();
    case "daily": {
      const parts = parseTimeOfDayParts(trigger.timeOfDay);
      if (!parts) {
        throw new Error("trigger.timeOfDay: Expected HH:MM in 24 hour time.");
      }
      const localReference = getTimeZoneDateParts(reference, trigger.timezone);
      for (let offset = 0; offset <= 7; offset += 1) {
        const localDate = addDaysToLocalDate(localReference.year, localReference.month, localReference.day, offset);
        const candidate = zonedLocalDateTimeToUtcDate(localDate.year, localDate.month, localDate.day, parts.hours, parts.minutes, trigger.timezone);
        if (candidate.getTime() > reference.getTime()) {
          return candidate.toISOString();
        }
      }
      throw new Error("trigger.timeOfDay: Unable to compute next daily fire time.");
    }
    case "weekly": {
      const parts = parseTimeOfDayParts(trigger.timeOfDay);
      if (!parts) {
        throw new Error("trigger.timeOfDay: Expected HH:MM in 24 hour time.");
      }
      if (!trigger.daysOfWeek.length) {
        throw new Error("trigger.daysOfWeek: Select at least one weekday.");
      }
      const localReference = getTimeZoneDateParts(reference, trigger.timezone);
      const sortedDays = [...trigger.daysOfWeek].sort((left, right) => left - right);
      for (let offset = 0; offset <= 14; offset += 1) {
        const localDate = addDaysToLocalDate(localReference.year, localReference.month, localReference.day, offset);
        const weekday = new Date(Date.UTC(localDate.year, localDate.month - 1, localDate.day)).getUTCDay() as 0 | 1 | 2 | 3 | 4 | 5 | 6;
        if (!sortedDays.includes(weekday)) {
          continue;
        }
        const candidate = zonedLocalDateTimeToUtcDate(localDate.year, localDate.month, localDate.day, parts.hours, parts.minutes, trigger.timezone);
        if (candidate.getTime() > reference.getTime()) {
          return candidate.toISOString();
        }
      }
      throw new Error("trigger.daysOfWeek: Unable to compute next weekly fire time.");
    }
    case "monthly": {
      const parts = parseTimeOfDayParts(trigger.timeOfDay);
      if (!parts) {
        throw new Error("trigger.timeOfDay: Expected HH:MM in 24 hour time.");
      }
      const localReference = getTimeZoneDateParts(reference, trigger.timezone);
      const targetDay = Math.min(Math.max(1, trigger.dayOfMonth), 31);
      for (let offset = 0; offset < 24; offset += 1) {
        const localDate = addMonthsToLocalDate(localReference.year, localReference.month, targetDay, offset);
        const candidate = zonedLocalDateTimeToUtcDate(localDate.year, localDate.month, localDate.day, parts.hours, parts.minutes, trigger.timezone);
        if (candidate.getTime() > reference.getTime()) {
          return candidate.toISOString();
        }
      }
      throw new Error("trigger.dayOfMonth: Unable to compute next monthly fire time.");
    }
    default:
      return null;
  }
}

function createScheduleOccurrence(scheduleId: string, occurrenceKey: string, scheduledAt?: string | null, eventId?: string | null): TaskScheduleOccurrence {
  const timestamp = nowIso();
  return {
    id: createId("task-schedule-occurrence"),
    scheduleId,
    occurrenceKey,
    scheduledAt: scheduledAt ?? null,
    eventId: eventId ?? null,
    status: "pending",
    taskId: null,
    error: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

function scheduleOpenMaterializedTaskCount(schedule: StoredTaskScheduleRecord, tasks: TaskDetail[]) {
  const materializedTaskIds = new Set(
    schedule.occurrences
      .filter((occurrence) => occurrence.status === "materialized" && occurrence.taskId)
      .map((occurrence) => occurrence.taskId as string),
  );
  return tasks.filter((task) => materializedTaskIds.has(task.id) && !["completed", "canceled"].includes(task.status)).length;
}

function summarizeTaskSchedule(schedule: StoredTaskScheduleRecord, tasks: TaskDetail[]): TaskScheduleSummary {
  const recentMaterializedTaskIds = schedule.occurrences
    .filter((occurrence) => occurrence.status === "materialized" && occurrence.taskId)
    .map((occurrence) => occurrence.taskId as string);
  return {
    id: schedule.id,
    projectId: schedule.projectId,
    title: schedule.taskBlueprint.title,
    description: schedule.taskBlueprint.description ?? null,
    type: schedule.taskBlueprint.type,
    priority: schedule.taskBlueprint.priority,
    workflowId: schedule.taskBlueprint.workflowId ?? null,
    repositoryIds: schedule.taskBlueprint.repositoryIds ?? [],
    enabled: schedule.enabled,
    oneShot: schedule.oneShot,
    overlapPolicy: schedule.overlapPolicy,
    trigger: schedule.trigger,
    nextFireAt: schedule.nextFireAt ?? null,
    lastFiredAt: schedule.lastFiredAt ?? null,
    lastMaterializedTaskId: schedule.lastMaterializedTaskId ?? recentMaterializedTaskIds[0] ?? null,
    lastError: schedule.lastError ?? null,
    materializedTaskCount: recentMaterializedTaskIds.length,
    openMaterializedTaskCount: scheduleOpenMaterializedTaskCount(schedule, tasks),
    createdAt: schedule.createdAt,
    updatedAt: schedule.updatedAt,
  };
}

function hydrateTaskScheduleDetail(schedule: StoredTaskScheduleRecord, tasks: TaskDetail[]): TaskScheduleDetail {
  const summary = summarizeTaskSchedule(schedule, tasks);
  const recentMaterializedTasks = schedule.occurrences
    .filter((occurrence) => occurrence.status === "materialized" && occurrence.taskId)
    .slice()
    .reverse()
    .map((occurrence) => tasks.find((task) => task.id === occurrence.taskId) ?? null)
    .filter((task): task is TaskDetail => Boolean(task))
    .map((task) => summarizeTask(task))
    .slice(0, 10);

  return {
    ...summary,
    taskBlueprint: { ...schedule.taskBlueprint },
    recentMaterializedTasks,
    recentOccurrences: schedule.occurrences.slice(-20).reverse(),
  };
}

function isValidTimeZone(value: string) {
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: value }).format(new Date());
    return true;
  } catch {
    return false;
  }
}

function validateMockTaskScheduleInput(input: TaskScheduleUpsertInput, scheduleId?: string) {
  const errors: Array<{ path: string; message: string }> = [];
  const taskValidation = validateMockTaskInput(normalizeScheduleBlueprint(input.task), scheduleId);
  errors.push(...taskValidation);

  if (!["skip", "create_another"].includes(input.overlapPolicy)) {
    errors.push({ path: "overlapPolicy", message: "Expected skip or create_another." });
  }

  if (input.trigger.type === "event") {
    if (!input.trigger.eventKey.trim()) {
      errors.push({ path: "trigger.eventKey", message: "Event trigger key is required." });
    }
  } else if (input.trigger.kind === "once") {
    if (!input.trigger.timezone.trim()) {
      errors.push({ path: "trigger.timezone", message: "Timezone is required." });
    } else if (!isValidTimeZone(input.trigger.timezone.trim())) {
      errors.push({ path: "trigger.timezone", message: "Expected a valid IANA timezone such as UTC or America/New_York." });
    }
    if (Number.isNaN(Date.parse(input.trigger.at))) {
      errors.push({ path: "trigger.at", message: "Expected an RFC3339 datetime." });
    }
  } else if (input.trigger.kind === "everyMinutes") {
    if (input.trigger.everyMinutes < 1) {
      errors.push({ path: "trigger.everyMinutes", message: "Must be at least 1 minute." });
    }
  } else if (input.trigger.kind === "daily") {
    if (!parseTimeOfDayParts(input.trigger.timeOfDay)) {
      errors.push({ path: "trigger.timeOfDay", message: "Expected HH:MM in 24 hour time." });
    }
    if (!input.trigger.timezone.trim()) {
      errors.push({ path: "trigger.timezone", message: "Timezone is required." });
    } else if (!isValidTimeZone(input.trigger.timezone.trim())) {
      errors.push({ path: "trigger.timezone", message: "Expected a valid IANA timezone such as UTC or America/New_York." });
    }
  } else if (input.trigger.kind === "weekly") {
    if (!parseTimeOfDayParts(input.trigger.timeOfDay)) {
      errors.push({ path: "trigger.timeOfDay", message: "Expected HH:MM in 24 hour time." });
    }
    if (!input.trigger.timezone.trim()) {
      errors.push({ path: "trigger.timezone", message: "Timezone is required." });
    } else if (!isValidTimeZone(input.trigger.timezone.trim())) {
      errors.push({ path: "trigger.timezone", message: "Expected a valid IANA timezone such as UTC or America/New_York." });
    }
    if (!input.trigger.daysOfWeek.length || input.trigger.daysOfWeek.some((day) => day < 0 || day > 6)) {
      errors.push({ path: "trigger.daysOfWeek", message: "Select one or more weekdays between Sunday and Saturday." });
    }
  } else if (input.trigger.kind === "monthly") {
    if (!parseTimeOfDayParts(input.trigger.timeOfDay)) {
      errors.push({ path: "trigger.timeOfDay", message: "Expected HH:MM in 24 hour time." });
    }
    if (!input.trigger.timezone.trim()) {
      errors.push({ path: "trigger.timezone", message: "Timezone is required." });
    } else if (!isValidTimeZone(input.trigger.timezone.trim())) {
      errors.push({ path: "trigger.timezone", message: "Expected a valid IANA timezone such as UTC or America/New_York." });
    }
    if (input.trigger.dayOfMonth < 1 || input.trigger.dayOfMonth > 31) {
      errors.push({ path: "trigger.dayOfMonth", message: "Expected a day between 1 and 31." });
    }
  }

  return errors;
}

function normalizeMockTaskScheduleInput(input: TaskScheduleUpsertInput, existing?: StoredTaskScheduleRecord, projectId?: string | null): StoredTaskScheduleRecord {
  const timestamp = nowIso();
  const taskBlueprint = normalizeScheduleBlueprint(input.task);
  const nextFireAt = input.trigger.type === "time"
    ? existing?.nextFireAt ?? nextMockTimeFireAt(input.trigger, timestamp)
    : null;

  return {
    id: existing?.id ?? createId("task-schedule"),
    projectId: existing?.projectId ?? projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID,
    taskBlueprint,
    enabled: input.enabled ?? existing?.enabled ?? true,
    oneShot: input.oneShot,
    overlapPolicy: input.overlapPolicy,
    trigger: input.trigger,
    nextFireAt,
    lastFiredAt: existing?.lastFiredAt ?? null,
    lastMaterializedTaskId: existing?.lastMaterializedTaskId ?? null,
    lastError: existing?.lastError ?? null,
    occurrences: existing?.occurrences ?? [],
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function processMockTaskSchedules(projectId?: string | null) {
  const targetProjectId = projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID;
  const schedules = ensureMockTaskSchedules();
  const domainEvents = ensureMockDomainEvents();
  let tasks = ensureMockTasks();
  let schedulesChanged = false;
  let tasksChanged = false;

  const materializeScheduleTask = (schedule: StoredTaskScheduleRecord) => {
    const task = normalizeMockTaskInput({ ...schedule.taskBlueprint, status: "ready", archived: false }, undefined, schedule.projectId);
    tasks = [task, ...tasks].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
    tasksChanged = true;
    return task;
  };

  for (const schedule of schedules) {
    if (schedule.projectId !== targetProjectId || !schedule.enabled) {
      continue;
    }

    if (schedule.trigger.type === "time") {
      if (schedule.enabled && schedule.nextFireAt && Date.parse(schedule.nextFireAt) <= Date.now()) {
        const occurrence = createScheduleOccurrence(schedule.id, schedule.nextFireAt, schedule.nextFireAt, null);
        const openCount = scheduleOpenMaterializedTaskCount(schedule, tasks);
        if (schedule.overlapPolicy === "skip" && openCount > 0) {
          occurrence.status = "skipped";
          occurrence.error = "Skipped because an open materialized task already exists.";
          occurrence.updatedAt = nowIso();
          schedule.lastError = occurrence.error;
        } else {
          const task = materializeScheduleTask(schedule);
          occurrence.status = "materialized";
          occurrence.taskId = task.id;
          occurrence.updatedAt = nowIso();
          schedule.lastMaterializedTaskId = task.id;
          schedule.lastError = null;
          appendMockDomainEvent("task.created", "task", task.id, {
            taskId: task.id,
            taskNumber: task.number,
            status: task.status,
            workflowId: task.workflowId ?? null,
            laneId: task.currentLaneId ?? null,
            sourceScheduleId: schedule.id,
            sourceScheduleOccurrenceId: occurrence.id,
          }, schedule.projectId);
          appendMockLog("info", "task.schedule.materialized", `Materialized task ${task.id} from schedule ${schedule.id}`);
        }
        schedule.lastFiredAt = occurrence.scheduledAt ?? occurrence.updatedAt;
        schedule.occurrences = [...schedule.occurrences, occurrence];
        schedule.updatedAt = nowIso();
        schedule.nextFireAt = schedule.oneShot || schedule.trigger.kind === "once"
          ? null
          : nextMockTimeFireAt(schedule.trigger, occurrence.scheduledAt ?? occurrence.updatedAt);
        if (schedule.oneShot || schedule.trigger.kind === "once") {
          schedule.enabled = false;
        }
        schedulesChanged = true;
      }
      continue;
    }

    const processedEventIds = new Set(schedule.occurrences.map((occurrence) => occurrence.eventId).filter((value): value is string => Boolean(value)));
    for (const event of domainEvents) {
      if (!schedule.enabled) {
        break;
      }
      if (processedEventIds.has(event.id) || event.topic !== schedule.trigger.eventKey) {
        continue;
      }
      if (event.projectId && event.projectId !== schedule.projectId) {
        continue;
      }
      if (Date.parse(event.createdAt) <= Date.parse(schedule.updatedAt)) {
        continue;
      }
      if (typeof (event.payload as { sourceScheduleId?: string | null }).sourceScheduleId === "string") {
        continue;
      }

      const occurrence = createScheduleOccurrence(schedule.id, event.id, null, event.id);
      const openCount = scheduleOpenMaterializedTaskCount(schedule, tasks);
      if (schedule.overlapPolicy === "skip" && openCount > 0) {
        occurrence.status = "skipped";
        occurrence.error = `Skipped ${event.topic} because an open materialized task already exists.`;
        schedule.lastError = occurrence.error;
      } else {
        const task = materializeScheduleTask(schedule);
        occurrence.status = "materialized";
        occurrence.taskId = task.id;
        schedule.lastMaterializedTaskId = task.id;
        schedule.lastError = null;
        appendMockDomainEvent("task.created", "task", task.id, {
          taskId: task.id,
          taskNumber: task.number,
          status: task.status,
          workflowId: task.workflowId ?? null,
          laneId: task.currentLaneId ?? null,
          sourceScheduleId: schedule.id,
          sourceScheduleOccurrenceId: occurrence.id,
        }, schedule.projectId);
        appendMockLog("info", "task.schedule.materialized", `Materialized task ${task.id} from schedule ${schedule.id}`);
      }
      occurrence.updatedAt = nowIso();
      schedule.lastFiredAt = event.createdAt;
      schedule.occurrences = [...schedule.occurrences, occurrence];
      schedule.updatedAt = nowIso();
      if (schedule.oneShot) {
        schedule.enabled = false;
      }
      schedulesChanged = true;
      processedEventIds.add(event.id);
    }
  }

  if (tasksChanged) {
    saveMockTasks(tasks);
  }
  if (schedulesChanged) {
    saveMockTaskSchedules(schedules);
  }

  return {
    tasks: tasksChanged ? ensureMockTasks() : tasks,
    schedules: schedulesChanged ? ensureMockTaskSchedules() : schedules,
    changed: tasksChanged || schedulesChanged,
  };
}

function ensureMockTasks() {
  const existing = getStoredValue<TaskDetail[]>(TASK_STORAGE_KEY);
  const dependencies = ensureMockTaskDependencies();
  if (existing) {
    return enrichMockTasks(existing, dependencies);
  }

  const seeded = seedMockTasks();
  setStoredValue(TASK_STORAGE_KEY, seeded);
  return seeded;
}

function saveMockTasks(tasks: TaskDetail[]) {
  setStoredValue(TASK_STORAGE_KEY, enrichMockTasks(tasks, ensureMockTaskDependencies()));
}

function hasUnfinishedChildBlockers(children: Array<{ status: string; archived?: boolean | null }>) {
  return children.some((child) => !child.archived && !["completed", "canceled"].includes(child.status));
}

function summarizeTask(task: TaskDetail): TaskSummary {
  const dependencyBlocked =
    task.blockedBy.some((dependency) => !["completed", "canceled"].includes(dependency.blocker.status))
    || hasUnfinishedChildBlockers(task.children);
  return {
    id: task.id,
    projectId: task.projectId,
    number: task.number,
    title: task.title,
    description: task.description,
    type: task.type,
    status: task.status,
    priority: task.priority,
    workflowId: task.workflowId,
    currentLaneId: task.currentLaneId,
    assigneeType: task.assigneeType,
    assigneeId: task.assigneeId,
    parentTaskId: task.parentTaskId,
    archived: task.archived,
    commentCount: task.comments.length,
    laneRunCount: task.laneRuns.length,
    childCount: task.children.length,
    completedChildCount: task.children.filter((child) => child.status === "completed").length,
    inProgressChildCount: task.children.filter((child) => child.status === "in_progress").length,
    blockedChildCount: task.children.filter((child) => !child.archived && !["completed", "canceled"].includes(child.status)).length,
    blockedByCount: task.blockedBy.length,
    blockingCount: task.blocking.length,
    attachmentCount: task.attachments.length,
    dependencyBlocked,
    readyForDispatch:
      !task.archived &&
      Boolean(task.workflowId && task.currentLaneId) &&
      ["ready", "in_progress"].includes(task.status) &&
      !dependencyBlocked &&
      !task.activeLaneAssignment,
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function enrichMockTasks(tasks: TaskDetail[], dependencies: TaskDependency[]) {
  const bareTasks = tasks.map((task) => ({
    ...task,
    parent: null,
    lineage: [],
    children: [],
    blockedBy: [],
    blocking: [],
    childCount: 0,
    completedChildCount: 0,
    inProgressChildCount: 0,
    blockedChildCount: 0,
    blockedByCount: 0,
    blockingCount: 0,
    attachmentCount: 0,
    dependencyBlocked: false,
    readyForDispatch: false,
    attachments: task.attachments ?? [],
    todos: task.todos ?? [],
    activeLaneAssignment: task.activeLaneAssignment ?? null,
  }));
  const bareById = new Map(bareTasks.map((task) => [task.id, task]));

  return bareTasks
    .map((task) => {
      const lineage: TaskSummary[] = [];
      let currentParentId = task.parentTaskId ?? null;
      while (currentParentId) {
        const parentTask = bareById.get(currentParentId);
        if (!parentTask) {
          break;
        }
        lineage.push(summarizeTask(parentTask));
        currentParentId = parentTask.parentTaskId ?? null;
      }
      lineage.reverse();

      const children = bareTasks
        .filter((candidate) => candidate.parentTaskId === task.id)
        .sort((left, right) => left.number.localeCompare(right.number))
        .map((child) => summarizeTask(child));

      const blockedBy = dependencies
        .filter((dependency) => dependency.blockedTaskId === task.id)
        .map((dependency) => ({
          ...dependency,
          blocker: summarizeTask(bareById.get(dependency.blockerTaskId) ?? task),
          blocked: summarizeTask(bareById.get(dependency.blockedTaskId) ?? task),
        }));

      const blocking = dependencies
        .filter((dependency) => dependency.blockerTaskId === task.id)
        .map((dependency) => ({
          ...dependency,
          blocker: summarizeTask(bareById.get(dependency.blockerTaskId) ?? task),
          blocked: summarizeTask(bareById.get(dependency.blockedTaskId) ?? task),
        }));

      const dependencyBlocked =
        blockedBy.some((dependency) => !["completed", "canceled"].includes(dependency.blocker.status))
        || hasUnfinishedChildBlockers(children);

      return {
        ...task,
        parent: task.parentTaskId && bareById.get(task.parentTaskId) ? summarizeTask(bareById.get(task.parentTaskId) as TaskDetail) : null,
        lineage,
        children,
        blockedBy,
        blocking,
        commentCount: task.comments.length,
        laneRunCount: task.laneRuns.length,
        childCount: children.length,
        completedChildCount: children.filter((child) => child.status === "completed").length,
        inProgressChildCount: children.filter((child) => child.status === "in_progress").length,
        blockedChildCount: children.filter((child) => !child.archived && !["completed", "canceled"].includes(child.status)).length,
        blockedByCount: blockedBy.length,
        blockingCount: blocking.length,
        attachmentCount: task.attachments.length,
        dependencyBlocked,
        readyForDispatch:
          !task.archived &&
          Boolean(task.workflowId && task.currentLaneId) &&
          ["ready", "in_progress"].includes(task.status) &&
          !dependencyBlocked &&
          !task.activeLaneAssignment,
      } satisfies TaskDetail;
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function normalizeMockTaskInput(input: TaskUpsertInput, existingTask?: TaskDetail, projectId?: string | null): TaskDetail {
  const timestamp = nowIso();
  const previousTasks = ensureMockTasks();
  const workflow = input.workflowId ? ensureMockWorkflows().find((entry) => entry.id === input.workflowId) : null;
  const resolvedLaneId = input.currentLaneId?.trim() || workflow?.lanes.slice().sort((left, right) => left.order - right.order)[0]?.id || null;
  const resolvedLane = workflow?.lanes.find((entry) => entry.id === resolvedLaneId) ?? null;
  const nextSequence = existingTask
    ? Number(existingTask.number.replace(/^ORC-/, "")) || previousTasks.length + 1
    : previousTasks.reduce((highest, task) => {
        const sequence = Number(task.number.replace(/^ORC-/, "")) || 0;
        return Math.max(highest, sequence);
      }, 0) + 1;

  return {
    id: existingTask?.id ?? createId("task"),
    projectId: existingTask?.projectId ?? projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID,
    number: existingTask?.number ?? `ORC-${nextSequence}`,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    type: input.type,
    status: input.status,
    priority: input.priority,
    workflowId: input.workflowId?.trim() || null,
    currentLaneId: resolvedLaneId,
    assigneeType: resolvedLane?.assignedEntityType ?? input.assigneeType,
    assigneeId: resolvedLane?.assignedEntityId ?? (input.assigneeId?.trim() || null),
    repositoryId: (input.repositoryIds?.[0]?.trim() || input.repositoryId?.trim() || null),
    repositoryIds: (input.repositoryIds ?? []).map((value) => value.trim()).filter(Boolean),
    parentTaskId: input.parentTaskId?.trim() || null,
    whipMaxAttempts: Math.max(1, input.whipMaxAttempts ?? existingTask?.whipMaxAttempts ?? 10),
    archived: input.archived ?? existingTask?.archived ?? false,
    commentCount: existingTask?.comments.length ?? 0,
    laneRunCount: existingTask?.laneRuns.length ?? 0,
    childCount: 0,
    completedChildCount: 0,
    inProgressChildCount: 0,
    blockedChildCount: 0,
    blockedByCount: 0,
    blockingCount: 0,
    attachmentCount: existingTask?.attachments.length ?? 0,
    dependencyBlocked: false,
    readyForDispatch: false,
    parent: null,
    lineage: [],
    children: [],
    blockedBy: [],
    blocking: [],
    attachments: existingTask?.attachments ?? [],
    taskRepositories: existingTask?.taskRepositories ?? [],
    fileReferences: existingTask?.fileReferences ?? [],
    activeLaneAssignment: existingTask?.activeLaneAssignment ?? null,
    createdAt: existingTask?.createdAt ?? timestamp,
    updatedAt: timestamp,
    comments: existingTask?.comments ?? [],
    todos: existingTask?.todos ?? [],
    laneRuns: existingTask?.laneRuns ?? [],
  };
}

function validateMockTaskInput(input: TaskUpsertInput, taskId?: string) {
  const errors: Array<{ path: string; message: string }> = [];

  if (!input.title.trim()) {
    errors.push({ path: "title", message: "Task title is required." });
  }

  if (!["task", "bug", "feature", "chore", "epic"].includes(input.type)) {
    errors.push({ path: "type", message: "Task type must be one of: task, bug, feature, chore, epic." });
  }

  if (!["draft", "ready", "in_progress", "blocked", "in_review", "completed", "canceled"].includes(input.status)) {
    errors.push({
      path: "status",
      message: "Task status must be one of: draft, ready, in_progress, blocked, in_review, completed, canceled.",
    });
  }

  if (!["P0", "P1", "P2", "P3", "P4"].includes(input.priority)) {
    errors.push({ path: "priority", message: "Task priority must be one of: P0, P1, P2, P3, P4." });
  }

  if (!["user", "agent", "role", "unassigned"].includes(input.assigneeType)) {
    errors.push({ path: "assigneeType", message: "Assignee type must be one of: user, agent, role, unassigned." });
  }

  if ((input.whipMaxAttempts ?? 10) < 1) {
    errors.push({ path: "whipMaxAttempts", message: "Task whip max attempts must be at least 1." });
  }

  if (["user", "unassigned"].includes(input.assigneeType) && input.assigneeId?.trim()) {
    errors.push({ path: "assigneeId", message: "User and unassigned tasks must not specify an assignee id." });
  }

  if (["agent", "role"].includes(input.assigneeType) && !input.assigneeId?.trim()) {
    errors.push({ path: "assigneeId", message: "Agent and role tasks require an assignee id." });
  }

  if (input.currentLaneId?.trim() && !input.workflowId?.trim()) {
    errors.push({ path: "currentLaneId", message: "A current lane requires a workflow selection." });
  }

  if (input.parentTaskId?.trim()) {
    const parentId = input.parentTaskId.trim();
    const tasks = ensureMockTasks();
    if (taskId && parentId === taskId) {
      errors.push({ path: "parentTaskId", message: "A task cannot be its own parent." });
    } else if (!tasks.some((task) => task.id === parentId)) {
      errors.push({ path: "parentTaskId", message: "Parent task was not found." });
    } else if (taskId) {
      let currentParentId: string | null = parentId;
      while (currentParentId) {
        if (currentParentId === taskId) {
          errors.push({ path: "parentTaskId", message: "Parent would create a hierarchy cycle." });
          break;
        }
        currentParentId = tasks.find((task) => task.id === currentParentId)?.parentTaskId ?? null;
      }
    }
  }

  return errors;
}

function validateMockWorkflowInput(input: WorkflowUpsertInput): WorkflowValidationResult {
  const errors: WorkflowValidationResult["errors"] = [];

  if (!input.name.trim()) {
    errors.push({ code: "required", path: "name", message: "Workflow name is required." });
  }

  if (!input.lanes.length) {
    errors.push({ code: "required", path: "lanes", message: "A workflow must contain at least one lane." });
  }

  const laneIds = new Set<string>();
  const laneKeys = new Set<string>();
  const laneOrders = new Set<number>();
  const normalizedIds = input.lanes.map((lane, index) => lane.id?.trim() || `lane-${index}`);

  input.lanes.forEach((lane, index) => {
    const laneId = normalizedIds[index]!;
    const laneKey = slugify(lane.key);
    const laneOrder = lane.order ?? index;
    const path = `lanes[${index}]`;

    if (!lane.name.trim()) {
      errors.push({ code: "required", path: `${path}.name`, message: "Lane name is required." });
    }

    if (!lane.key.trim()) {
      errors.push({ code: "required", path: `${path}.key`, message: "Lane key is required." });
    }

    if (laneIds.has(laneId)) {
      errors.push({ code: "duplicate", path: `${path}.id`, message: "Lane ids must be unique within a workflow." });
    }
    laneIds.add(laneId);

    if (laneKeys.has(laneKey)) {
      errors.push({ code: "duplicate", path: `${path}.key`, message: "Lane keys must be unique within a workflow." });
    }
    laneKeys.add(laneKey);

    if (laneOrders.has(laneOrder)) {
      errors.push({ code: "duplicate", path: `${path}.order`, message: "Lane order values must be unique within a workflow." });
    }
    laneOrders.add(laneOrder);

    if (!["user", "agent", "role"].includes(lane.assignedEntityType)) {
      errors.push({
        code: "invalid",
        path: `${path}.assignedEntityType`,
        message: "Lane owner type must be one of: user, agent, role.",
      });
    }

    if (lane.assignedEntityType === "user" && lane.assignedEntityId?.trim()) {
      errors.push({
        code: "invalid",
        path: `${path}.assignedEntityId`,
        message: "User-owned lanes must not specify an assigned entity id.",
      });
    }

    if (lane.assignedEntityType === "user" && lane.requireUserApprovalOnSuccess) {
      errors.push({
        code: "invalid",
        path: `${path}.requireUserApprovalOnSuccess`,
        message: "User-owned lanes cannot require user approval on success.",
      });
    }

    if (lane.assignedEntityType === "agent") {
      const agentRef = lane.assignedEntityId?.trim();
      const agents = getStoredMockAgents();
      if (!agentRef) {
        errors.push({
          code: "required",
          path: `${path}.assignedEntityId`,
          message: "This lane owner type requires an assigned entity id.",
        });
      } else if (agents.length > 0 && !agents.some((agent) => !agent.archived && agent.slug === agentRef)) {
        errors.push({
          code: "invalid_reference",
          path: `${path}.assignedEntityId`,
          message: "Assigned entity id does not reference an existing active worker.",
        });
      }
    }

    if (lane.assignedEntityType === "role") {
      const roleRef = lane.assignedEntityId?.trim();
      const roles = getStoredMockRoles();
      if (!roleRef) {
        errors.push({
          code: "required",
          path: `${path}.assignedEntityId`,
          message: "This lane owner type requires an assigned entity id.",
        });
      } else if (roles.length > 0 && !roles.some((role) => !role.archived && role.slug === roleRef)) {
        errors.push({
          code: "invalid_reference",
          path: `${path}.assignedEntityId`,
          message: "Assigned entity id does not reference an existing active worker.",
        });
      }
    }
  });

  const validTargets = new Set(normalizedIds);
  input.lanes.forEach((lane, index) => {
    const transitions = [
      [lane.successTransitionType, lane.successTargetLaneId, "successTransitionType", "successTargetLaneId"],
      [lane.failureTransitionType, lane.failureTargetLaneId, "failureTransitionType", "failureTargetLaneId"],
    ] as const;

    transitions.forEach(([transitionType, target, typeKey, targetKey]) => {
      if (!["lane", "user_intervention", "end"].includes(transitionType)) {
        errors.push({
          code: "invalid",
          path: `lanes[${index}].${typeKey}`,
          message: "Transition type must be one of: lane, user_intervention, end.",
        });
        return;
      }

      if (transitionType === "lane") {
        if (!target?.trim()) {
          errors.push({
            code: "required",
            path: `lanes[${index}].${targetKey}`,
            message: "Lane transitions must reference a target lane.",
          });
        } else if (!validTargets.has(target.trim())) {
          errors.push({
            code: "invalid_reference",
            path: `lanes[${index}].${targetKey}`,
            message: "Transition target must reference an existing lane id.",
          });
        }
      } else if (target?.trim()) {
        errors.push({
          code: "invalid",
          path: `lanes[${index}].${targetKey}`,
          message: "Only lane transitions may specify a target lane.",
        });
      }
    });
  });

  return {
    valid: errors.length === 0,
    errors,
  };
}

function normalizeMockWorkflowInput(input: WorkflowUpsertInput, existingWorkflow?: WorkflowDefinition): WorkflowDefinition {
  const timestamp = nowIso();

  const lanes: WorkflowLane[] = input.lanes.map((lane, index) => ({
    id: lane.id?.trim() || createId("lane"),
    key: slugify(lane.key),
    name: lane.name.trim(),
    description: lane.description?.trim() || null,
    order: lane.order ?? index,
    assignedEntityType: lane.assignedEntityType,
    assignedEntityId: lane.assignedEntityId?.trim() || null,
    entryPromptTemplate: lane.entryPromptTemplate?.trim() || null,
    useSeparateWorktree: (lane.useSeparateWorktree ?? false) && lane.assignedEntityType !== "user",
    requireUserApprovalOnSuccess: lane.requireUserApprovalOnSuccess ?? false,
    successTransitionType: lane.successTransitionType,
    successTargetLaneId: lane.successTransitionType === "lane" ? lane.successTargetLaneId?.trim() || null : null,
    failureTransitionType: lane.failureTransitionType,
    failureTargetLaneId: lane.failureTransitionType === "lane" ? lane.failureTargetLaneId?.trim() || null : null,
  }));

  return {
    id: existingWorkflow?.id ?? createId("workflow"),
    slug: existingWorkflow?.slug ?? slugify(input.name),
    name: input.name.trim(),
    description: input.description?.trim() || null,
    archived: existingWorkflow?.archived ?? false,
    lanes,
    createdAt: existingWorkflow?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

export async function listenToSessionStream(
  handler: (event: SessionStreamEnvelope) => void,
): Promise<() => void> {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      handler(event.detail as SessionStreamEnvelope);
    }
  };

  window.addEventListener("orchestra:session-stream", listener);
  return () => {
    window.removeEventListener("orchestra:session-stream", listener);
  };
}

export async function listenToSessionChanges(
  handler: (event: SessionChangeEvent) => void,
): Promise<() => void> {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      handler(event.detail as SessionChangeEvent);
    }
  };

  window.addEventListener("orchestra:session-change", listener);
  return () => {
    window.removeEventListener("orchestra:session-change", listener);
  };
}

export async function listenToTaskChanges(
  handler: (event: TaskChangeEvent) => void,
): Promise<() => void> {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      handler(event.detail as TaskChangeEvent);
    }
  };

  window.addEventListener("orchestra:task-change", listener);
  return () => {
    window.removeEventListener("orchestra:task-change", listener);
  };
}

export async function listenToInboxChanges(
  handler: (event: InboxChangeEvent) => void,
): Promise<() => void> {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      handler(event.detail as InboxChangeEvent);
    }
  };

  window.addEventListener("orchestra:inbox-change", listener);
  return () => {
    window.removeEventListener("orchestra:inbox-change", listener);
  };
}

function describeError(error: unknown, fallback: string) {
  if (error instanceof Error && error.message.trim()) {
    return error.message;
  }
  if (typeof error === "string" && error.trim()) {
    return error;
  }
  return fallback;
}

export async function reportClientError(target: string, error: unknown, fallback: string) {
  const message = describeError(error, fallback);
  console.error(`[${target}] ${message}`, error);
  if (!isTauriAvailable()) {
    appendMockLog("error", target, message);
    return message;
  }

  try {
    await invoke("report_client_error", { target, message });
  } catch (loggingError) {
    console.error(`[report_client_error.failed] ${target}`, loggingError);
  }
  return message;
}

export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauriAvailable()) {
    return {
      appName: "Orchestra",
      environment: "browser",
      backendStatus: "mock",
      versionDisplay: "0.1.0-mock0000",
      dispatchBlocked: false,
      dispatchBlockedReason: null,
    };
  }

  return invoke<AppInfo>("get_app_info");
}

export async function getLogs(): Promise<LogEntry[]> {
  if (!isTauriAvailable()) {
    return ensureMockLogs();
  }

  return invoke<LogEntry[]>("get_logs");
}

export async function getBridgeDiagnostics(): Promise<BridgeDiagnostics> {
  if (!isTauriAvailable()) {
    return ensureMockBridgeDiagnostics();
  }

  return invoke<BridgeDiagnostics>("get_bridge_diagnostics");
}

export async function cleanupStaleBridgeInstances(): Promise<BridgeCleanupEvent[]> {
  if (!isTauriAvailable()) {
    const diagnostics = ensureMockBridgeDiagnostics();
    setStoredValue(BRIDGE_DIAGNOSTICS_STORAGE_KEY, {
      ...diagnostics,
      recentCleanupEvents: [
        {
          id: `bridge-cleanup-${Date.now()}`,
          instanceId: diagnostics.instance.instanceId,
          pid: diagnostics.instance.ownerPid,
          action: "cleanup_requested",
          reason: "mock_cleanup",
          success: true,
          timestamp: nowIso(),
        },
        ...diagnostics.recentCleanupEvents,
      ].slice(0, 20),
    } satisfies BridgeDiagnostics);
    return ensureMockBridgeDiagnostics().recentCleanupEvents;
  }

  return invoke<BridgeCleanupEvent[]>("cleanup_stale_bridge_instances");
}

export async function clearLogs(): Promise<void> {
  if (!isTauriAvailable()) {
    setStoredValue(LOG_STORAGE_KEY, [] satisfies LogEntry[]);
    return;
  }

  await invoke("clear_logs");
}

export async function exportLogsBundle(includeRelatedSessionSnapshot = false): Promise<string> {
  if (!isTauriAvailable()) {
    throw new Error("Log bundle export is only available in the desktop app.");
  }

  return invoke<string>("export_logs_bundle", { includeRelatedSessionSnapshot });
}

export async function openLogsWindow(): Promise<void> {
  const logsUrl = new URL(window.location.href);
  logsUrl.searchParams.set("view", "logs");

  if (!isTauriAvailable()) {
    window.open(logsUrl.toString(), "orchestra-logs", "popup=yes,width=980,height=760,resizable=yes,scrollbars=yes");
    return;
  }

  await invoke("open_logs_window");
}

export async function isCurrentLogsWindow(): Promise<boolean> {
  if (!isTauriAvailable()) {
    return getInitialLogsWindowFlag();
  }

  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label === "logs";
}

export async function isCurrentAgentTerminalWindow(): Promise<boolean> {
  if (!isTauriAvailable()) {
    return getInitialAgentTerminalWindowFlag();
  }

  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label.startsWith("agent-terminal-");
}

export async function getCurrentAgentTerminalSessionId(): Promise<string | null> {
  if (!isTauriAvailable()) {
    return getInitialAgentTerminalSessionId();
  }

  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const label = getCurrentWebviewWindow().label;
  return label.startsWith("agent-terminal-") ? label.slice("agent-terminal-".length) : null;
}

export async function listSessions(projectId?: string | null): Promise<SessionRecord[]> {
  if (!isTauriAvailable()) {
    const dismissed = getDismissedMockSessionIds(projectId);
    const sessions = sortSessions(ensureMockSessions(projectId).filter((session) => !dismissed.has(session.id)));
    appendMockLog("info", "sessions.list", `Listed ${sessions.length} sessions`);
    return sessions;
  }

  return invoke<SessionRecord[]>("list_sessions", { projectId: projectId ?? null });
}

export async function getSessionRecord(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const session = ensureMockSessions().find((entry) => entry.id === sessionId) ?? null;
    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.record", `Loaded session record ${sessionId}`);
    return session;
  }

  return invoke<SessionRecord>("get_session_record", { sessionId });
}

function cloneMockSessionModel(sourceSessionId: string, targetSessionId: string) {
  const models = getMockSessionModels();
  if (models[sourceSessionId]) {
    models[targetSessionId] = models[sourceSessionId]!;
    setMockSessionModels(models);
    return;
  }
  ensureMockSessionModel(targetSessionId);
}

function createMockContextualSessionRecord(title: string): SessionRecord {
  const session = createMockSessionRecord(title, "Fresh session is active. Continue here while the prior session remains in history.");
  return {
    ...session,
    subscribed: true,
  };
}

function createMockContextualSession(sessionId: string, projectSlug?: string | null): SessionRecord {
  const sessions = ensureMockSessions();
  const currentSession = sessions.find((entry) => entry.id === sessionId);
  if (!currentSession) {
    throw new Error(`Unable to find session ${sessionId}`);
  }

  const timestamp = nowIso();
  const tasks = ensureMockTasks();
  const task = tasks.find((entry) => {
    const assignment = entry.activeLaneAssignment;
    return assignment?.sessionId === sessionId && ["queued", "active", "awaiting_user_approval"].includes(assignment.status);
  }) ?? null;

  if (task?.activeLaneAssignment) {
    const currentAssignment = task.activeLaneAssignment;
    const nextSession = createMockContextualSessionRecord(currentSession.title);
    cloneMockSessionModel(sessionId, nextSession.id);
    upsertMockSession(nextSession);

    const nextAssignment: TaskLaneAssignment = {
      ...currentAssignment,
      id: createId("task-assignment"),
      sessionId: nextSession.id,
      startedAt: timestamp,
      completedAt: null,
      createdAt: timestamp,
      updatedAt: timestamp,
    };

    saveMockTasks(tasks.map((entry) =>
      entry.id === task.id
        ? {
            ...entry,
            activeLaneAssignment: nextAssignment,
            laneRuns: [
              ...entry.laneRuns.map((run) =>
                run.sessionId === sessionId && run.completedAt == null
                  ? { ...run, result: "canceled" as const, notes: "Session rotated by operator.", completedAt: timestamp }
                  : run,
              ),
              {
                id: createId("lane-run"),
                taskId: entry.id,
                laneId: nextAssignment.laneId,
                sessionId: nextSession.id,
                result: "needs_user" as const,
                notes: null,
                startedAt: timestamp,
                completedAt: null,
              },
            ],
            updatedAt: timestamp,
          }
        : entry,
    ));

    if (currentAssignment.workerType === "agent" && currentAssignment.workerId) {
      saveStoredMockAgentRuntimes(
        getStoredMockAgentRuntimes().map((runtime) =>
          runtime.agentId === currentAssignment.workerId && runtime.projectId === task.projectId
            ? {
                ...runtime,
                mainSessionId: nextSession.id,
                runtimeCwd: currentAssignment.runtimeCwd,
                updatedAt: timestamp,
              }
            : runtime,
        ),
      );
    }

    if (currentAssignment.workerType === "role" && currentAssignment.roleInstanceId) {
      saveStoredMockRoleInstances(
        getStoredMockRoleInstances().map((instance) =>
          instance.id === currentAssignment.roleInstanceId
            ? { ...instance, sessionId: nextSession.id, updatedAt: timestamp }
            : instance,
        ),
      );
    }

    updateMockSession(sessionId, (current) => ({
      ...current,
      status: "closed",
      subscribed: false,
      updatedAt: timestamp,
      events: [...current.events, createEvent("system", "Session replaced by a newer worker session.")],
    }));
    appendMockLog("info", "sessions.create_contextual", `Rotated worker session ${sessionId} to ${nextSession.id}`);
    emitMockSessionChange({ sessionIds: [sessionId, nextSession.id], reason: "sessions.create_contextual" });
    emitMockTaskChange({ taskIds: [task.id], reason: "task.assignment.session_rotated" });
    return nextSession;
  }

  const agentRuntime = getStoredMockAgentRuntimes().find((entry) => entry.mainSessionId === sessionId) ?? null;
  if (agentRuntime) {
    const nextSession = createMockContextualSessionRecord(currentSession.title);
    cloneMockSessionModel(sessionId, nextSession.id);
    upsertMockSession(nextSession);
    saveStoredMockAgentRuntimes(
      getStoredMockAgentRuntimes().map((entry) =>
        entry.mainSessionId === sessionId
          ? { ...entry, mainSessionId: nextSession.id, updatedAt: timestamp }
          : entry,
      ),
    );
    appendMockLog("info", "sessions.create_contextual", `Rotated agent main session ${sessionId} to ${nextSession.id}`);
    emitMockSessionChange({ sessionIds: [sessionId, nextSession.id], reason: "sessions.create_contextual" });
    return nextSession;
  }

  const roleInstance = getStoredMockRoleInstances().find((entry) => entry.sessionId === sessionId && typeof entry.status === "string" && ["running", "waiting", "idle"].includes(entry.status)) ?? null;
  if (roleInstance) {
    const nextSession = createMockContextualSessionRecord(currentSession.title);
    cloneMockSessionModel(sessionId, nextSession.id);
    upsertMockSession(nextSession);
    saveStoredMockRoleInstances(
      getStoredMockRoleInstances().map((entry) =>
        entry.id === roleInstance.id
          ? { ...entry, sessionId: nextSession.id, updatedAt: timestamp }
          : entry,
      ),
    );
    appendMockLog("info", "sessions.create_contextual", `Rotated role session ${sessionId} to ${nextSession.id}`);
    emitMockSessionChange({ sessionIds: [sessionId, nextSession.id], reason: "sessions.create_contextual" });
    return nextSession;
  }

  const nextSession: SessionRecord = {
    id: createId("session"),
    title: `New session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
    status: "active",
    createdAt: timestamp,
    updatedAt: timestamp,
    subscribed: true,
    events: [
      createEvent("system", "Session created from the Orchestra Sessions page."),
      createEvent("assistant", "Session is active. Send a message to begin the interaction loop."),
    ],
  };

  ensureMockSessionModel(nextSession.id);
  saveMockSessions(sortSessions([nextSession, ...sessions]));
  appendMockLog("info", "sessions.create_contextual", `Created generic successor session ${nextSession.id} in ${projectSlug ?? CURRENT_PROJECT_ID}`);
  emitMockSessionChange({ sessionIds: [nextSession.id], reason: "sessions.create_contextual" });
  return nextSession;
}

export async function createSession(title?: string, projectSlug?: string | null): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const timestamp = nowIso();
    const session: SessionRecord = {
      id: createId("session"),
      title: title?.trim() || `New session ${new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`,
      status: "active",
      createdAt: timestamp,
      updatedAt: timestamp,
      subscribed: true,
      events: [
        createEvent("system", "Session created from the Orchestra Sessions page."),
        createEvent("assistant", "Session is active. Send a message to begin the interaction loop."),
      ],
    };

    ensureMockSessionModel(session.id);
    const updated = sortSessions([session, ...ensureMockSessions()]);
    saveMockSessions(updated);
    appendMockLog("info", "sessions.create", `Created session ${session.id}`);
    emitMockSessionChange({ sessionIds: [session.id], reason: "sessions.create" });
    return session;
  }

  return invoke<SessionRecord>("create_session", { title, projectSlug });
}

export async function createContextualSession(sessionId: string, projectSlug?: string | null): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    return createMockContextualSession(sessionId, projectSlug);
  }

  return invoke<SessionRecord>("create_contextual_session", { sessionId, projectSlug });
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!isTauriAvailable()) {
    const dismissed = getDismissedMockSessionIds();
    dismissed.add(sessionId);
    saveDismissedMockSessionIds(dismissed);
    appendMockLog("info", "sessions.dismiss", `Dismissed session ${sessionId}`);
    return;
  }

  await invoke("delete_session", { sessionId });
}

export async function resumeSession(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const dismissed = getDismissedMockSessionIds();
    dismissed.delete(sessionId);
    saveDismissedMockSessionIds(dismissed);
    const session = updateMockSession(sessionId, (current) => ({
      ...current,
      status: current.status === "closed" ? "closed" : "active",
      subscribed: true,
      updatedAt: nowIso(),
      events: [...current.events, createEvent("system", "Session resumed from the Sessions page.")],
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.resume", `Resumed session ${session.id}`);
    return session;
  }

  return invoke<SessionRecord>("resume_session", { sessionId });
}

export async function subscribeSession(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const session = updateMockSession(sessionId, (current) => ({
      ...current,
      subscribed: true,
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.subscribe", `Subscribed to session ${session.id}`);
    return session;
  }

  return invoke<SessionRecord>("subscribe_session", { sessionId });
}

export async function unsubscribeSession(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const session = updateMockSession(sessionId, (current) => ({
      ...current,
      subscribed: false,
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.unsubscribe", `Unsubscribed from session ${session.id}`);
    return session;
  }

  return invoke<SessionRecord>("unsubscribe_session", { sessionId });
}

export async function stopSessionRuntime(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const activeRuns = getMockActiveSessionRuns();
    delete activeRuns[sessionId];
    setMockActiveSessionRuns(activeRuns);

    const session = updateMockSession(sessionId, (current) => ({
      ...current,
      status: "paused",
      updatedAt: nowIso(),
      events: [...current.events, createEvent("system", "Session run stopped by operator.")],
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.stop", `Stopped session runtime ${sessionId}`);
    emitMockSessionChange({ sessionIds: [sessionId], reason: "sessions.stop" });
    return session;
  }

  return invoke<SessionRecord>("stop_session_runtime", { sessionId });
}

export async function getPiExecutableDiagnostic(): Promise<PiExecutableDiagnostic> {
  if (!isTauriAvailable()) {
    return { resolvedPath: "/mock/bin/pi", error: null };
  }

  return invoke<PiExecutableDiagnostic>("get_pi_executable_diagnostic");
}

export async function listPiModels(): Promise<SessionModel[]> {
  if (!isTauriAvailable()) {
    return MOCK_MODELS;
  }

  return invoke<SessionModel[]>("list_pi_models");
}

export async function getSessionModelState(sessionId: string): Promise<SessionModelState> {
  if (!isTauriAvailable()) {
    return buildMockModelState(sessionId);
  }

  return invoke<SessionModelState>("get_session_model_state", { sessionId });
}

export async function setSessionModel(sessionId: string, provider: string, modelId: string): Promise<SessionModelState> {
  if (!isTauriAvailable()) {
    const nextModel = MOCK_MODELS.find((model) => model.provider === provider && model.id === modelId);
    if (!nextModel) {
      throw new Error(`Unknown model ${provider}/${modelId}`);
    }

    const models = getMockSessionModels();
    models[sessionId] = nextModel;
    setMockSessionModels(models);
    appendMockLog("info", "sessions.model", `Changed session ${sessionId} to ${provider}/${modelId}`);
    return buildMockModelState(sessionId);
  }

  return invoke<SessionModelState>("set_session_model", { sessionId, provider, modelId });
}

export async function compactSession(sessionId: string, customInstructions?: string | null): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const timestamp = nowIso();
    const session = updateMockSession(sessionId, (current) => ({
      ...current,
      updatedAt: timestamp,
      events: [
        ...current.events,
        createEvent(
          "system",
          customInstructions?.trim()
            ? `Session compacted. ${customInstructions.trim()}`
            : "Session compacted.",
          { id: `compact-${sessionId}-${timestamp}` },
        ),
      ],
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.compact", `Compacted session ${sessionId}`);
    emitMockSessionChange({ sessionIds: [sessionId], reason: "sessions.compact" });
    return session;
  }

  return invoke<SessionRecord>("compact_session", { sessionId, customInstructions: customInstructions ?? null });
}

export async function sendSessionMessage(sessionId: string, message: string, runId: string): Promise<QueuedSessionMessage> {
  const trimmedMessage = message.trim();
  if (!trimmedMessage) {
    throw new Error("Message cannot be empty");
  }

  if (!isTauriAvailable()) {
    const queued: QueuedSessionMessage = {
      sessionId,
      runId,
      message: trimmedMessage,
      timestamp: nowIso(),
    };
    const bridgeDiagnostics = ensureMockBridgeDiagnostics();
    setStoredValue(BRIDGE_DIAGNOSTICS_STORAGE_KEY, {
      ...bridgeDiagnostics,
      instance: {
        ...bridgeDiagnostics.instance,
        activeClientCount: 1,
        inFlightRequestCount: 1,
        heartbeatAt: queued.timestamp,
      },
      clients: [
        {
          clientId: `browser-client-${sessionId}`,
          sessionId,
          actorType: "session",
          actorId: sessionId,
          requestCount: (bridgeDiagnostics.clients[0]?.requestCount ?? 0) + 1,
          inFlightRequestCount: 1,
          lastSeenAt: queued.timestamp,
          lastCommand: "send_session_message",
          lastError: null,
          active: true,
          bridgeInstanceId: bridgeDiagnostics.instance.instanceId,
        },
      ],
      recentRequests: [
        {
          requestId: `browser-request-${runId}`,
          clientId: `browser-client-${sessionId}`,
          sessionId,
          command: "send_session_message",
          startedAt: queued.timestamp,
          finishedAt: null,
          durationMs: null,
          success: true,
          error: null,
        },
        ...bridgeDiagnostics.recentRequests,
      ].slice(0, 20),
    } satisfies BridgeDiagnostics);

    const activeRuns = getMockActiveSessionRuns();
    activeRuns[sessionId] = runId;
    setMockActiveSessionRuns(activeRuns);

    const assistantReply = generateAssistantReply(trimmedMessage);
    const chunks = assistantReply.split(/(\s+)/).filter(Boolean);
    const thinkingReply = `Considering: ${trimmedMessage}`;
    const thinkingChunks = thinkingReply.split(/(\s+)/).filter(Boolean);
    const userMessage = {
      role: "user",
      content: [{ type: "text", text: trimmedMessage }],
      timestamp: Date.now(),
    };
    const assistantMessageBase = {
      role: "assistant",
      content: [] as JsonValue[],
      timestamp: Date.now(),
    };

    window.setTimeout(() => {
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "agent_start" }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "turn_start" }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "message_start", message: userMessage }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "message_end", message: userMessage }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "message_start", message: assistantMessageBase }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
        type: "message_update",
        message: { ...assistantMessageBase, content: [{ type: "thinking", thinking: "" }] as JsonValue[] },
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
      }));
      thinkingChunks.forEach((chunk, index) => {
        window.setTimeout(() => {
          emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
            type: "message_update",
            message: { ...assistantMessageBase, content: [{ type: "thinking", thinking: thinkingReply.slice(0, thinkingReply.indexOf(chunk) >= 0 ? thinkingReply.indexOf(chunk) + chunk.length : thinkingReply.length) }] as JsonValue[] },
            assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: chunk, partial: {} },
          }));
        }, 40 * (index + 1));
      });

      window.setTimeout(() => {
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
          type: "message_update",
          message: { ...assistantMessageBase, content: [{ type: "thinking", thinking: thinkingReply }] as JsonValue[] },
          assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial: {} },
        }));
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
          type: "message_update",
          message: { ...assistantMessageBase, content: [{ type: "text", text: "" }, { type: "thinking", thinking: thinkingReply }] as JsonValue[] },
          assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
        }));
      }, 40 * (thinkingChunks.length + 1));

      chunks.forEach((chunk, index) => {
        window.setTimeout(() => {
          emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
            type: "message_update",
            message: { ...assistantMessageBase, content: [{ type: "text", text: assistantReply.slice(0, assistantReply.indexOf(chunk) >= 0 ? assistantReply.indexOf(chunk) + chunk.length : assistantReply.length) }] as JsonValue[] },
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial: {} },
          }));
        }, 40 * (thinkingChunks.length + 1) + 80 * (index + 1));
      });

      window.setTimeout(() => {
        if (!isMockRunStillActive(sessionId, runId)) {
          return;
        }
        const assistantMessage = {
          ...assistantMessageBase,
          content: [{ type: "thinking", thinking: thinkingReply }, { type: "text", text: assistantReply }] as JsonValue[],
        };
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
          type: "message_update",
          message: assistantMessage,
          assistantMessageEvent: { type: "text_end", contentIndex: 0, content: assistantReply, partial: {} },
        }));
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "message_end", message: assistantMessage }));
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
          type: "turn_end",
          message: assistantMessage,
          toolResults: [],
        }));

        const session = updateMockSession(sessionId, (current) => {
          const timestamp = nowIso();
          return {
            ...current,
            status: "idle",
            updatedAt: timestamp,
            events: [
              ...current.events,
              createEvent("user", trimmedMessage),
              createEvent("assistant", assistantReply, { thinkingText: thinkingReply, timestamp }),
            ],
          };
        });

        if (!session) {
          emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
            type: "error",
            message: `Unable to find session ${sessionId}`,
            source: "mock",
          }));
          return;
        }

        const nextRuns = getMockActiveSessionRuns();
        delete nextRuns[sessionId];
        setMockActiveSessionRuns(nextRuns);

        appendMockLog("info", "sessions.message", `Sent message to session ${session.id}`);
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "agent_end" }));
      }, 80 * (chunks.length + 2));
    }, 120);

    return queued;
  }

  return invoke<QueuedSessionMessage>("send_session_message", { sessionId, message: trimmedMessage, runId });
}

async function resolveTauriProjectId(projectId?: string | null) {
  const requestedProjectId = projectId ?? getActiveProjectId();
  if (!isTauriAvailable()) {
    return requestedProjectId;
  }

  const projects = await invoke<Array<{ id: string }>>("list_projects");
  if (requestedProjectId && projects.some((entry) => entry.id === requestedProjectId)) {
    return requestedProjectId;
  }

  return projects[0]?.id ?? requestedProjectId ?? null;
}

export async function listTasks(includeArchived = false, projectId?: string | null): Promise<TaskSummary[]> {
  const activeProjectId = projectId ?? getActiveProjectId();
  if (!isTauriAvailable()) {
    return processMockTaskSchedules(activeProjectId).tasks
      .filter((task) => task.projectId === activeProjectId)
      .filter((task) => includeArchived || !task.archived)
      .map(summarizeTask);
  }

  const resolvedProjectId = await resolveTauriProjectId(projectId);
  return invoke<TaskSummary[]>("list_tasks", { projectId: resolvedProjectId, includeArchived });
}

export async function getTask(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const task = processMockTaskSchedules().tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }

  return invoke<TaskDetail>("get_task", { taskId });
}

export async function listTaskTodos(taskId: string): Promise<TaskTodo[]> {
  if (!isTauriAvailable()) {
    return listMockTaskTodos(taskId);
  }

  return invoke<TaskTodo[]>("list_task_todos", { taskId });
}

export async function listUnfinishedTaskTodos(taskId: string, laneId?: string | null): Promise<TaskTodo[]> {
  if (!isTauriAvailable()) {
    return listMockTaskTodos(taskId, laneId ?? undefined, false);
  }

  return invoke<TaskTodo[]>("list_unfinished_task_todos", { taskId, laneId: laneId ?? null });
}

export async function addTaskTodo(taskId: string, input: TaskTodoInput): Promise<TaskTodo> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    const description = input.description.trim();
    const laneId = input.laneId?.trim() || null;
    if (!description) {
      throw new Error("description: Task todo description is required.");
    }
    if (!task.workflowId) {
      throw new Error("laneId: Task todos require the task to have a workflow.");
    }
    if (!laneId) {
      throw new Error("laneId: A workflow lane is required for task todos.");
    }
    const workflow = ensureMockWorkflows().find((entry) => entry.id === task.workflowId);
    if (!workflow?.lanes.some((entry) => entry.id === laneId)) {
      throw new Error("laneId: Todo lane must belong to the task workflow.");
    }
    const timestamp = nowIso();
    const todo: TaskTodo = {
      id: createId("task-todo"),
      taskId,
      laneId,
      description,
      completed: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    saveMockTasks(tasks.map((entry) => (entry.id === taskId ? { ...entry, todos: [...(entry.todos ?? []), todo], updatedAt: timestamp } : entry)));
    appendMockLog("info", "task.todo.added", `Added todo ${todo.id} to task ${taskId}`);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.todo.added" });
    return todo;
  }

  return invoke<TaskTodo>("add_task_todo", { taskId, input });
}

export async function markTaskTodoFinished(todoId: string): Promise<TaskTodo> {
  if (!isTauriAvailable()) {
    const { task, todo } = resolveMockTaskTodo(todoId);
    const updatedAt = nowIso();
    saveMockTasks(
      ensureMockTasks().map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              todos: (entry.todos ?? []).map((candidate) =>
                candidate.id === todoId ? { ...candidate, completed: true, updatedAt } : candidate,
              ),
              updatedAt,
            }
          : entry,
      ),
    );
    appendMockLog("info", "task.todo.finished", `Marked todo ${todoId} finished`);
    emitMockTaskChange({ taskIds: [task.id], reason: "task.todo.finished" });
    return resolveMockTaskTodo(todoId).todo;
  }

  return invoke<TaskTodo>("mark_task_todo_finished", { todoId });
}

export async function markTaskTodoUnfinished(todoId: string): Promise<TaskTodo> {
  if (!isTauriAvailable()) {
    const { task, todo } = resolveMockTaskTodo(todoId);
    const updatedAt = nowIso();
    saveMockTasks(
      ensureMockTasks().map((entry) =>
        entry.id === task.id
          ? {
              ...entry,
              todos: (entry.todos ?? []).map((candidate) =>
                candidate.id === todoId ? { ...candidate, completed: false, updatedAt } : candidate,
              ),
              updatedAt,
            }
          : entry,
      ),
    );
    appendMockLog("info", "task.todo.unfinished", `Marked todo ${todoId} unfinished`);
    emitMockTaskChange({ taskIds: [task.id], reason: "task.todo.unfinished" });
    return resolveMockTaskTodo(todoId).todo;
  }

  return invoke<TaskTodo>("mark_task_todo_unfinished", { todoId });
}

export async function deleteTaskTodo(todoId: string): Promise<TaskTodo> {
  if (!isTauriAvailable()) {
    const { task, todo } = resolveMockTaskTodo(todoId);
    const updatedAt = nowIso();
    saveMockTasks(
      ensureMockTasks().map((entry) =>
        entry.id === task.id
          ? { ...entry, todos: (entry.todos ?? []).filter((candidate) => candidate.id !== todoId), updatedAt }
          : entry,
      ),
    );
    appendMockLog("info", "task.todo.deleted", `Deleted todo ${todoId}`);
    emitMockTaskChange({ taskIds: [task.id], reason: "task.todo.deleted" });
    return todo;
  }

  return invoke<TaskTodo>("delete_task_todo", { todoId });
}

export async function createTask(input: TaskUpsertInput, projectId?: string | null): Promise<TaskDetail> {
  const activeProjectId = projectId ?? getActiveProjectId();
  if (!isTauriAvailable()) {
    const validation = validateMockTaskInput(input);
    if (validation.length > 0) {
      throw new Error(validation.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const task = normalizeMockTaskInput(input, undefined, activeProjectId ?? undefined);
    saveMockTasks([task, ...ensureMockTasks()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
    appendMockLog("info", "task.created", `Created task ${task.id}`);
    appendMockDomainEvent("task.created", "task", task.id, { taskId: task.id, taskNumber: task.number, status: task.status }, task.projectId);
    emitMockTaskChange({ taskIds: [task.id], reason: "task.created" });
    return task;
  }

  const resolvedProjectId = await resolveTauriProjectId(projectId);
  console.debug("createTask resolvedProjectId", { projectId, resolvedProjectId, input });
  return invoke<TaskDetail>("create_task", { projectId: resolvedProjectId, input });
}

export async function updateTask(taskId: string, input: TaskUpsertInput): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const validation = validateMockTaskInput(input, taskId);
    if (validation.length > 0) {
      throw new Error(validation.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const tasks = ensureMockTasks();
    const existing = tasks.find((task) => task.id === taskId);
    if (!existing) {
      throw new Error(`Task ${taskId} was not found`);
    }

    const updated = normalizeMockTaskInput(input, existing);
    saveMockTasks(
      tasks
        .map((task) => (task.id === taskId ? updated : task))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    );
    appendMockLog("info", "task.updated", `Updated task ${taskId}`);
    const updatedTask = await getTask(taskId);
    appendMockDomainEvent("task.updated", "task", taskId, { taskId, taskNumber: updatedTask.number, status: updatedTask.status }, updatedTask.projectId);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.updated" });
    return updatedTask;
  }

  return invoke<TaskDetail>("update_task", { taskId, input });
}

export async function deleteTask(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const tasks = processMockTaskSchedules().tasks;
    const existing = tasks.find((task) => task.id === taskId);
    if (!existing) {
      throw new Error(`Task ${taskId} was not found`);
    }

    saveMockTaskDependencies(
      ensureMockTaskDependencies().filter(
        (dependency) => dependency.blockerTaskId !== taskId && dependency.blockedTaskId !== taskId,
      ),
    );
    saveMockTasks(
      tasks
        .filter((task) => task.id !== taskId)
        .map((task) => (task.parentTaskId === taskId ? { ...task, parentTaskId: null } : task)),
    );
    appendMockLog("info", "task.deleted", `Deleted task ${taskId}`);
    appendMockDomainEvent("task.deleted", "task", taskId, { taskId, taskNumber: existing.number, status: existing.status }, existing.projectId);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.deleted" });
    return existing;
  }

  return invoke<TaskDetail>("delete_task", { taskId });
}

export async function dispatchTaskLane(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    if (!task.workflowId || !task.currentLaneId) {
      throw new Error("Task must have a workflow and current lane before dispatch.");
    }
    if (task.activeLaneAssignment) {
      return getTask(taskId);
    }

    const workflow = ensureMockWorkflows().find((entry) => entry.id === task.workflowId);
    const lane = workflow?.lanes.find((entry) => entry.id === task.currentLaneId);
    if (!workflow || !lane) {
      throw new Error("Current workflow lane could not be resolved.");
    }
    if (lane.assignedEntityType === "user") {
      throw new Error("Current lane is user-owned and cannot be dispatched.");
    }

    const workerId = lane.assignedEntityType === "agent"
      ? getStoredMockAgents().find((agent) => agent.slug === lane.assignedEntityId)?.id ?? lane.assignedEntityId ?? null
      : lane.assignedEntityId ?? null;
    const assignmentStartedAt = nowIso();
    const assignment: TaskLaneAssignment = {
      id: createId("task-assignment"),
      taskId: task.id,
      workflowId: workflow.id,
      laneId: lane.id,
      workerType: lane.assignedEntityType,
      workerId,
      status: "active",
      sessionId: null,
      runtimeCwd: `/mock/runtime/${lane.assignedEntityType}/${lane.assignedEntityId ?? "user"}`,
      roleQueueEntryId: lane.assignedEntityType === "role" ? createId("queue") : null,
      roleInstanceId: lane.assignedEntityType === "role" ? createId("instance") : null,
      prompt: `Work task ${task.number}: ${task.title}`,
      startedAt: assignmentStartedAt,
      completedAt: null,
      createdAt: assignmentStartedAt,
      updatedAt: assignmentStartedAt,
    };

    if (lane.assignedEntityType === "agent" && assignment.workerId) {
      const agentSession = ensureMockAgentMainSession(lane.assignedEntityId ?? "Agent", assignment.workerId);
      assignment.sessionId = agentSession.id;
      assignment.runtimeCwd = getProjectRuntimeCwd(CURRENT_PROJECT_ID);
      updateMockSession(agentSession.id, (current) => attachMockSessionTaskMetadata(current, task, "agent", lane.assignedEntityId ?? "Agent"));
      const agentQueueEntryId = createId("agent-queue");
      saveStoredMockAgentQueue([
        ...getStoredMockAgentQueue(),
        {
          id: agentQueueEntryId,
          projectId: CURRENT_PROJECT_ID,
          agentId: assignment.workerId,
          status: "dispatched",
          sourceType: "workflow_lane",
          sourceTaskId: task.id,
          sourceWorkflowId: workflow.id,
          sourceLaneId: lane.id,
          deliveryMode: "prompt",
          title: `${task.number} · ${task.title}`,
          message: assignment.prompt,
          sessionId: assignment.sessionId,
          runId: createId("run"),
          dispatchedAt: assignment.startedAt,
          completedAt: null,
          createdAt: assignment.createdAt,
          updatedAt: assignment.updatedAt,
        },
      ]);
      saveStoredMockAgentRuntimes(
        getStoredMockAgentRuntimes().map((runtime) =>
          runtime.agentId === assignment.workerId && runtime.projectId === CURRENT_PROJECT_ID
            ? {
                ...runtime,
                status: "running",
                mainSessionId: assignment.sessionId,
                runtimeCwd: assignment.runtimeCwd,
                currentQueueEntryId: agentQueueEntryId,
                lastDispatchAt: assignment.updatedAt,
                lastError: null,
                updatedAt: assignment.updatedAt,
              }
            : runtime,
        ),
      );
    } else if (lane.assignedEntityType === "role") {
      const roleSession = attachMockSessionTaskMetadata(
        createMockSessionRecord(
          `${lane.name} · ${task.title}`,
          `Role runtime session for ${task.number} is active and ready to continue the assigned lane.`,
        ),
        task,
        "role",
        lane.assignedEntityId ?? lane.name,
      );
      assignment.sessionId = roleSession.id;
      upsertMockSession(roleSession);
      emitMockSessionChange({ sessionIds: [roleSession.id], reason: "task.dispatch.role_session" });
    }

    const nextTasks = tasks.map((entry) =>
      entry.id === taskId
        ? {
            ...entry,
            status: "in_progress",
            assigneeType: lane.assignedEntityType,
            assigneeId: lane.assignedEntityId ?? null,
            activeLaneAssignment: assignment,
            laneRuns: [
              ...entry.laneRuns,
              {
                id: createId("lane-run"),
                taskId: entry.id,
                laneId: lane.id,
                sessionId: assignment.sessionId!,
                result: "needs_user" as const,
                notes: null,
                startedAt: assignment.startedAt,
                completedAt: null,
              },
            ],
            updatedAt: assignment.updatedAt,
          }
        : entry,
    );
    saveMockTasks(nextTasks);
    appendMockLog("info", "task.dispatch", `Dispatched task ${taskId} into ${lane.assignedEntityType}:${lane.assignedEntityId ?? "user"}`);
    appendMockDomainEvent("task.dispatched", "task", taskId, { taskId, assignmentId: assignment.id, laneId: lane.id, sessionId: assignment.sessionId ?? null }, task.projectId);
    if (assignment.sessionId) {
      emitMockSessionChange({ sessionIds: [assignment.sessionId], reason: "task.dispatch" });
    }
    emitMockTaskChange({ taskIds: [taskId], reason: "task.dispatch" });
    return getTask(taskId);
  }

  return invoke<TaskDetail>("dispatch_task_lane", { taskId });
}

function buildMockAutoAssignment(task: TaskDetail, workflow: WorkflowDefinition, lane: WorkflowLane, updatedAt: string) {
  if (lane.assignedEntityType === "user") {
    return null;
  }

  const assignment = {
    id: createId("task-assignment"),
    taskId: task.id,
    workflowId: workflow.id,
    laneId: lane.id,
    workerType: lane.assignedEntityType,
    workerId: lane.assignedEntityId ?? null,
    status: "active",
    sessionId: createId("session"),
    runtimeCwd: lane.assignedEntityType === "agent"
      ? getProjectRuntimeCwd(task.projectId)
      : `/mock/runtime/${lane.assignedEntityType}/${lane.assignedEntityId ?? "user"}`,
    roleQueueEntryId: lane.assignedEntityType === "role" ? createId("queue") : null,
    roleInstanceId: lane.assignedEntityType === "role" ? createId("instance") : null,
    prompt: `Work task ${task.number}: ${task.title}`,
    pendingOutcome: null,
    completionNotes: null,
    startedAt: updatedAt,
    completedAt: null,
    createdAt: updatedAt,
    updatedAt,
  };

  if (lane.assignedEntityType === "agent" && assignment.workerId) {
    const agentSession = ensureMockAgentMainSession(lane.assignedEntityId ?? "Agent", assignment.workerId);
    assignment.sessionId = agentSession.id;
    updateMockSession(agentSession.id, (current) => attachMockSessionTaskMetadata(current, task, "agent", lane.assignedEntityId ?? "Agent"));
  }

  if (lane.assignedEntityType === "role") {
    const roleSession = attachMockSessionTaskMetadata(
      createMockSessionRecord(
        `${lane.name} · ${task.title}`,
        `Role runtime session for ${task.number} is active and ready to continue the assigned lane.`,
      ),
      task,
      "role",
      lane.assignedEntityId ?? lane.name,
    );
    assignment.sessionId = roleSession.id;
    upsertMockSession(roleSession);
    emitMockSessionChange({ sessionIds: [roleSession.id], reason: "task.dispatch.role_session" });
  }

  return assignment;
}

function closeMockTaskSessionIfNeeded(task: TaskDetail, nextStatus: string, updatedAt: string) {
  if (!["completed", "canceled"].includes(nextStatus) || !task.activeLaneAssignment?.sessionId) {
    return;
  }

  const activeSessionId = task.activeLaneAssignment.sessionId;
  const isPersistentAgentMainSession =
    task.activeLaneAssignment.workerType === "agent" &&
    getStoredMockAgentRuntimes().some((runtime) => runtime.mainSessionId === activeSessionId);

  if (!isPersistentAgentMainSession) {
    updateMockSession(activeSessionId, (current) => ({
      ...current,
      status: "closed",
      updatedAt,
    }));
    emitMockSessionChange({ sessionIds: [activeSessionId], reason: "task.session.closed" });
  }
}

function finalizeMockAgentState(task: TaskDetail, outcome: "success" | "failure" | "needs_user", updatedAt: string, autoAssignment: TaskDetail["activeLaneAssignment"] | null) {
  if (task.activeLaneAssignment?.workerType !== "agent" || !task.activeLaneAssignment.workerId) {
    return;
  }

  saveStoredMockAgentQueue(
    getStoredMockAgentQueue().map((entry) =>
      entry.id === task.activeLaneAssignment?.id || entry.sessionId === task.activeLaneAssignment?.sessionId
        ? {
            ...entry,
            status: outcome === "failure" ? "failed" : "completed",
            completedAt: updatedAt,
            updatedAt,
          }
        : entry,
    ),
  );
  saveStoredMockAgentRuntimes(
    getStoredMockAgentRuntimes().map((runtime) =>
      runtime.agentId === task.activeLaneAssignment?.workerId
        ? {
            ...runtime,
            status: outcome === "failure" ? "needs_attention" : autoAssignment ? "running" : "idle",
            mainSessionId: autoAssignment?.sessionId ?? task.activeLaneAssignment?.sessionId,
            runtimeCwd: autoAssignment?.runtimeCwd ?? task.activeLaneAssignment?.runtimeCwd,
            currentQueueEntryId: autoAssignment?.id ?? null,
            lastDispatchAt: updatedAt,
            lastError: outcome === "failure" ? task.activeLaneAssignment?.completionNotes ?? "Marked failed" : null,
            updatedAt,
          }
        : runtime,
    ),
  );
}

function queueMockAutoAssignment(task: TaskDetail, workflow: WorkflowDefinition, autoAssignment: TaskDetail["activeLaneAssignment"] | null) {
  if (autoAssignment?.workerType !== "agent" || !autoAssignment.workerId) {
    return;
  }

  saveStoredMockAgentQueue([
    ...getStoredMockAgentQueue(),
    {
      id: autoAssignment.id,
      projectId: task.projectId,
      agentId: autoAssignment.workerId,
      status: "dispatched",
      sourceType: "workflow_lane",
      sourceTaskId: task.id,
      sourceWorkflowId: workflow.id,
      sourceLaneId: autoAssignment.laneId,
      deliveryMode: "prompt",
      title: `${task.number} · ${task.title}`,
      message: autoAssignment.prompt,
      sessionId: autoAssignment.sessionId,
      runId: createId("run"),
      dispatchedAt: autoAssignment.startedAt,
      completedAt: null,
      createdAt: autoAssignment.createdAt,
      updatedAt: autoAssignment.updatedAt,
    },
  ]);
}

function isMockAutoDispatchOnBlockerCompletionEnabled(projectId: string) {
  const projects = getStoredMockProjectsForSettings();
  const projectSlug = projects.find((project) => project.id === projectId)?.slug ?? CURRENT_PROJECT_ID;
  const settings = getStoredMockProjectSettings();
  return Boolean((settings.general?.autoDispatchOnBlockerCompletion ?? true) && projectSlug);
}

async function autoDispatchMockDependentTasks(blockerTaskId: string) {
  const dependencies = ensureMockTaskDependencies().filter((dependency) => dependency.blockerTaskId === blockerTaskId);
  if (dependencies.length === 0) {
    return [] as string[];
  }

  const tasks = ensureMockTasks();
  const workflowMap = new Map(ensureMockWorkflows().map((workflow) => [workflow.id, workflow]));
  const updatedAt = nowIso();
  const autoDispatchedTaskIds: string[] = [];
  const nextTasks = [...tasks];

  for (const dependency of dependencies) {
    const index = nextTasks.findIndex((entry) => entry.id === dependency.blockedTaskId);
    if (index < 0) {
      continue;
    }
    const task = await getTask(dependency.blockedTaskId);
    if (!isMockAutoDispatchOnBlockerCompletionEnabled(task.projectId) || !task.readyForDispatch || task.activeLaneAssignment) {
      continue;
    }
    const workflow = task.workflowId ? workflowMap.get(task.workflowId) ?? null : null;
    const lane = workflow?.lanes.find((entry) => entry.id === task.currentLaneId) ?? null;
    if (!workflow || !lane || lane.assignedEntityType === "user") {
      continue;
    }

    const autoAssignment = buildMockAutoAssignment(task, workflow, lane, updatedAt);
    if (!autoAssignment?.sessionId) {
      continue;
    }
    nextTasks[index] = {
      ...nextTasks[index],
      status: "in_progress",
      assigneeType: lane.assignedEntityType,
      assigneeId: lane.assignedEntityId ?? null,
      activeLaneAssignment: autoAssignment,
      laneRuns: [
        ...task.laneRuns,
        {
          id: createId("lane-run"),
          taskId: task.id,
          laneId: lane.id,
          sessionId: autoAssignment.sessionId,
          result: "needs_user",
          notes: null,
          startedAt: updatedAt,
          completedAt: null,
        },
      ],
      updatedAt,
    };
    queueMockAutoAssignment(task, workflow, autoAssignment);
    autoDispatchedTaskIds.push(task.id);
  }

  if (autoDispatchedTaskIds.length > 0) {
    saveMockTasks(nextTasks.sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
  }

  return autoDispatchedTaskIds;
}

function listMockTaskTodos(taskId: string, laneId?: string | null, completed?: boolean) {
  const task = ensureMockTasks().find((entry) => entry.id === taskId);
  if (!task) {
    throw new Error(`Task ${taskId} was not found`);
  }
  return (task.todos ?? []).filter((todo) => (laneId ? todo.laneId === laneId : true) && (completed === undefined ? true : todo.completed === completed));
}

function resolveMockTaskTodo(todoId: string) {
  for (const task of ensureMockTasks()) {
    const todo = (task.todos ?? []).find((entry) => entry.id === todoId);
    if (todo) {
      return { task, todo };
    }
  }
  throw new Error(`Task todo ${todoId} was not found`);
}

async function completeMockTaskLane(taskId: string, outcome: "success" | "failure" | "needs_user", notes?: string): Promise<TaskDetail> {
  const tasks = ensureMockTasks();
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task || !task.workflowId || !task.currentLaneId) {
    throw new Error(`Task ${taskId} does not have an active workflow lane.`);
  }
  const workflow = ensureMockWorkflows().find((entry) => entry.id === task.workflowId);
  const lane = workflow?.lanes.find((entry) => entry.id === task.currentLaneId);
  if (!workflow || !lane) {
    throw new Error("Current workflow lane could not be resolved.");
  }

  const updatedAt = nowIso();
  const normalizedNotes = notes?.trim() || null;
  const unfinishedLaneTodos = listMockTaskTodos(taskId, lane.id, false);
  if (unfinishedLaneTodos.length > 0) {
    throw new Error(
      `Task ${taskId} still has ${unfinishedLaneTodos.length} unfinished todo item(s) for lane ${lane.id}. Finish or reopen them before using a completion tool.`,
    );
  }

  if (
    outcome === "success"
    && task.activeLaneAssignment
    && ["agent", "role"].includes(task.activeLaneAssignment.workerType)
    && (lane.requireUserApprovalOnSuccess ?? false)
  ) {
    saveMockTasks(tasks.map((entry) =>
      entry.id === taskId
        ? {
            ...entry,
            status: "in_review",
            assigneeType: "user",
            assigneeId: null,
            activeLaneAssignment: entry.activeLaneAssignment
              ? {
                  ...entry.activeLaneAssignment,
                  status: "awaiting_user_approval",
                  pendingOutcome: "success",
                  completionNotes: normalizedNotes,
                  updatedAt,
                }
              : null,
            updatedAt,
          }
        : entry,
    ));

    appendMockLog("info", "task.transition", `Task ${taskId} is awaiting user approval on ${lane.name}`);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.transition.awaiting_user_approval" });
    return getTask(taskId);
  }

  let nextLaneId: string | null = task.currentLaneId;
  let nextStatus: string = task.status;
  let nextAssigneeType: string = task.assigneeType;
  let nextAssigneeId: string | null = task.assigneeId ?? null;

  if (outcome === "success") {
    if (lane.successTransitionType === "lane" && lane.successTargetLaneId) {
      const nextLane = workflow.lanes.find((entry) => entry.id === lane.successTargetLaneId);
      nextLaneId = nextLane?.id ?? null;
      nextStatus = nextLane?.assignedEntityType === "user" ? "in_review" : "ready";
      nextAssigneeType = nextLane?.assignedEntityType ?? "unassigned";
      nextAssigneeId = nextLane?.assignedEntityId ?? null;
    } else {
      nextLaneId = null;
      nextStatus = "completed";
      nextAssigneeType = "unassigned";
      nextAssigneeId = null;
    }
  } else if (outcome === "failure") {
    if (lane.failureTransitionType === "lane" && lane.failureTargetLaneId) {
      const nextLane = workflow.lanes.find((entry) => entry.id === lane.failureTargetLaneId);
      nextLaneId = nextLane?.id ?? null;
      nextStatus = nextLane?.assignedEntityType === "user" ? "in_review" : "ready";
      nextAssigneeType = nextLane?.assignedEntityType ?? "unassigned";
      nextAssigneeId = nextLane?.assignedEntityId ?? null;
    } else {
      nextStatus = "blocked";
      nextAssigneeType = "user";
      nextAssigneeId = null;
    }
  } else {
    nextStatus = "in_review";
    nextAssigneeType = "user";
    nextAssigneeId = null;
  }

  const nextLane = nextLaneId ? workflow.lanes.find((entry) => entry.id === nextLaneId) ?? null : null;
  const autoAssignment =
    nextLane && nextLane.assignedEntityType !== "user" && ["ready", "in_progress"].includes(nextStatus)
      ? buildMockAutoAssignment(task, workflow, nextLane, updatedAt)
      : null;

  const laneRuns = task.activeLaneAssignment
    ? task.laneRuns.map((run, index, allRuns) =>
        index === allRuns.length - 1 && run.completedAt == null
          ? { ...run, result: outcome, notes: normalizedNotes ?? run.notes ?? null, completedAt: updatedAt }
          : run,
      )
    : task.laneRuns;

  saveMockTasks(tasks.map((entry) =>
    entry.id === taskId
      ? {
          ...entry,
          currentLaneId: nextLaneId,
          status: nextStatus,
          assigneeType: nextAssigneeType,
          assigneeId: nextAssigneeId,
          activeLaneAssignment: autoAssignment,
          laneRuns:
            autoAssignment && nextLane
              ? [
                  ...laneRuns,
                  {
                    id: createId("lane-run"),
                    taskId: entry.id,
                    laneId: nextLane.id,
                    sessionId: autoAssignment.sessionId!,
                    result: "needs_user" as const,
                    notes: null,
                    startedAt: autoAssignment.startedAt,
                    completedAt: null,
                  },
                ]
              : laneRuns,
          updatedAt,
        }
      : entry,
  ));

  finalizeMockAgentState(
    {
      ...task,
      activeLaneAssignment: task.activeLaneAssignment
        ? { ...task.activeLaneAssignment, completionNotes: normalizedNotes }
        : null,
    },
    outcome,
    updatedAt,
    autoAssignment,
  );
  queueMockAutoAssignment(task, workflow, autoAssignment);
  closeMockTaskSessionIfNeeded(task, nextStatus, updatedAt);
  const autoDispatchedDependentTaskIds = ["completed", "canceled"].includes(nextStatus)
    ? await autoDispatchMockDependentTasks(taskId)
    : [];

  appendMockLog("info", "task.transition", `Completed task ${taskId} lane with ${outcome}`);
  const updatedTask = await getTask(taskId);
  appendMockDomainEvent(
    outcome === "success" && updatedTask.status === "completed"
      ? "task.completed"
      : outcome === "success"
        ? "task.transition_success"
        : outcome === "failure"
          ? "task.failed"
          : "task.user_intervention_requested",
    "task",
    taskId,
    { taskId, status: updatedTask.status, outcome, workflowId: updatedTask.workflowId ?? null, laneId: updatedTask.currentLaneId ?? null },
    updatedTask.projectId,
  );
  emitMockTaskChange({ taskIds: [taskId, ...autoDispatchedDependentTaskIds], reason: `task.transition.${outcome}` });
  return updatedTask;
}

async function approveMockLaneCompletion(taskId: string): Promise<TaskDetail> {
  const tasks = ensureMockTasks();
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task || !task.workflowId || !task.currentLaneId || task.activeLaneAssignment?.status !== "awaiting_user_approval") {
    throw new Error(`Task ${taskId} is not awaiting lane approval.`);
  }

  const workflow = ensureMockWorkflows().find((entry) => entry.id === task.workflowId);
  const lane = workflow?.lanes.find((entry) => entry.id === task.currentLaneId);
  if (!workflow || !lane) {
    throw new Error("Current workflow lane could not be resolved.");
  }

  const updatedAt = nowIso();
  let nextLaneId: string | null = task.currentLaneId;
  let nextStatus: string = task.status;
  let nextAssigneeType: string = task.assigneeType;
  let nextAssigneeId: string | null = task.assigneeId ?? null;

  if (lane.successTransitionType === "lane" && lane.successTargetLaneId) {
    const nextLane = workflow.lanes.find((entry) => entry.id === lane.successTargetLaneId);
    nextLaneId = nextLane?.id ?? null;
    nextStatus = nextLane?.assignedEntityType === "user" ? "in_review" : "ready";
    nextAssigneeType = nextLane?.assignedEntityType ?? "unassigned";
    nextAssigneeId = nextLane?.assignedEntityId ?? null;
  } else {
    nextLaneId = null;
    nextStatus = "completed";
    nextAssigneeType = "unassigned";
    nextAssigneeId = null;
  }

  const nextLane = nextLaneId ? workflow.lanes.find((entry) => entry.id === nextLaneId) ?? null : null;
  const autoAssignment =
    nextLane && nextLane.assignedEntityType !== "user" && ["ready", "in_progress"].includes(nextStatus)
      ? buildMockAutoAssignment(task, workflow, nextLane, updatedAt)
      : null;

  const laneRuns = task.laneRuns.map((run, index, allRuns) =>
    index === allRuns.length - 1 && run.completedAt == null
      ? {
          ...run,
          result: "success" as const,
          notes: task.activeLaneAssignment?.completionNotes ?? run.notes ?? null,
          completedAt: updatedAt,
        }
      : run,
  );

  saveMockTasks(tasks.map((entry) =>
    entry.id === taskId
      ? {
          ...entry,
          currentLaneId: nextLaneId,
          status: nextStatus,
          assigneeType: nextAssigneeType,
          assigneeId: nextAssigneeId,
          activeLaneAssignment: autoAssignment,
          laneRuns:
            autoAssignment && nextLane
              ? [
                  ...laneRuns,
                  {
                    id: createId("lane-run"),
                    taskId: entry.id,
                    laneId: nextLane.id,
                    sessionId: autoAssignment.sessionId!,
                    result: "needs_user" as const,
                    notes: null,
                    startedAt: autoAssignment.startedAt,
                    completedAt: null,
                  },
                ]
              : laneRuns,
          updatedAt,
        }
      : entry,
  ));

  finalizeMockAgentState(task, "success", updatedAt, autoAssignment);
  queueMockAutoAssignment(task, workflow, autoAssignment);
  closeMockTaskSessionIfNeeded(task, nextStatus, updatedAt);
  const autoDispatchedDependentTaskIds = ["completed", "canceled"].includes(nextStatus)
    ? await autoDispatchMockDependentTasks(taskId)
    : [];

  appendMockLog("info", "task.transition", `Approved pending lane completion for task ${taskId}`);
  emitMockTaskChange({ taskIds: [taskId, ...autoDispatchedDependentTaskIds], reason: "task.transition.approved_success" });
  return getTask(taskId);
}

async function sendMockLaneBackForWork(taskId: string): Promise<TaskDetail> {
  const tasks = ensureMockTasks();
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task || task.activeLaneAssignment?.status !== "awaiting_user_approval" || !task.activeLaneAssignment.sessionId) {
    throw new Error(`Task ${taskId} is not awaiting lane approval.`);
  }

  const updatedAt = nowIso();
  const followUpPrompt = "The user has requested more work be done on this lane. Reload the latest task context and comments before continuing.";

  saveMockTasks(tasks.map((entry) =>
    entry.id === taskId
      ? {
          ...entry,
          status: "in_progress",
          assigneeType: entry.activeLaneAssignment?.workerType ?? entry.assigneeType,
          assigneeId: entry.activeLaneAssignment?.workerId ?? entry.assigneeId,
          activeLaneAssignment: entry.activeLaneAssignment
            ? {
                ...entry.activeLaneAssignment,
                status: "active",
                pendingOutcome: null,
                completionNotes: null,
                updatedAt,
              }
            : null,
          updatedAt,
        }
      : entry,
  ));

  updateMockSession(task.activeLaneAssignment.sessionId, (current) => ({
    ...current,
    status: "active",
    updatedAt,
    events: [...current.events, createEvent("system", followUpPrompt)],
  }));
  emitMockSessionChange({ sessionIds: [task.activeLaneAssignment.sessionId], reason: "task.transition.rework" });

  appendMockLog("info", "task.transition", `Sent task ${taskId} back to the current lane session for more work`);
  emitMockTaskChange({ taskIds: [taskId], reason: "task.transition.needs_work" });
  return getTask(taskId);
}

async function reassignMockTaskToLane(taskId: string, laneId: string, notes?: string): Promise<TaskDetail> {
  const tasks = ensureMockTasks();
  const task = tasks.find((entry) => entry.id === taskId);
  if (!task || !task.workflowId || !task.currentLaneId) {
    throw new Error(`Task ${taskId} does not have an active workflow lane.`);
  }

  if (task.currentLaneId === laneId) {
    throw new Error(`Task ${taskId} is already in lane ${laneId}.`);
  }

  const workflow = ensureMockWorkflows().find((entry) => entry.id === task.workflowId);
  const targetLane = workflow?.lanes.find((entry) => entry.id === laneId) ?? null;
  if (!workflow || !targetLane) {
    throw new Error(`Workflow lane ${laneId} could not be resolved for task ${taskId}.`);
  }

  const updatedAt = nowIso();
  const normalizedNotes = notes?.trim() || null;
  const nextStatus = targetLane.assignedEntityType === "user" ? "in_review" : "ready";
  const nextAssigneeType = targetLane.assignedEntityType;
  const nextAssigneeId = targetLane.assignedEntityId ?? null;
  const autoAssignment =
    targetLane.assignedEntityType !== "user"
      ? buildMockAutoAssignment(task, workflow, targetLane, updatedAt)
      : null;
  const laneRuns = task.activeLaneAssignment
    ? task.laneRuns.map((run, index, allRuns) =>
        index === allRuns.length - 1 && run.completedAt == null
          ? { ...run, result: "failure" as const, notes: normalizedNotes ?? run.notes ?? null, completedAt: updatedAt }
          : run,
      )
    : task.laneRuns;

  saveMockTasks(tasks.map((entry) =>
    entry.id === taskId
      ? {
          ...entry,
          currentLaneId: targetLane.id,
          status: autoAssignment ? "in_progress" : nextStatus,
          assigneeType: nextAssigneeType,
          assigneeId: nextAssigneeId,
          activeLaneAssignment: autoAssignment,
          laneRuns:
            autoAssignment
              ? [
                  ...laneRuns,
                  {
                    id: createId("lane-run"),
                    taskId: entry.id,
                    laneId: targetLane.id,
                    sessionId: autoAssignment.sessionId!,
                    result: "needs_user" as const,
                    notes: null,
                    startedAt: autoAssignment.startedAt,
                    completedAt: null,
                  },
                ]
              : laneRuns,
          updatedAt,
        }
      : entry,
  ));

  finalizeMockAgentState(
    {
      ...task,
      activeLaneAssignment: task.activeLaneAssignment
        ? { ...task.activeLaneAssignment, completionNotes: normalizedNotes }
        : null,
    },
    "failure",
    updatedAt,
    autoAssignment,
  );
  queueMockAutoAssignment(task, workflow, autoAssignment);
  appendMockLog("info", "task.transition", `Re-laned task ${taskId} to lane ${laneId}`);
  appendMockDomainEvent(
    "task.relaned",
    "task",
    taskId,
    { taskId, laneId: targetLane.id, status: autoAssignment ? "in_progress" : nextStatus, notes: normalizedNotes },
    task.projectId,
  );
  emitMockTaskChange({ taskIds: [taskId], reason: "task.transition.relane" });
  return getTask(taskId);
}

export async function completeLaneAsSuccess(taskId: string, notes?: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    return completeMockTaskLane(taskId, "success", notes);
  }

  return invoke<TaskDetail>("complete_lane_as_success", { taskId, notes });
}

export async function completeLaneAsFailure(taskId: string, notes?: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    return completeMockTaskLane(taskId, "failure", notes);
  }

  return invoke<TaskDetail>("complete_lane_as_failure", { taskId, notes });
}

export async function requestUserIntervention(taskId: string, notes?: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    return completeMockTaskLane(taskId, "needs_user", notes);
  }

  return invoke<TaskDetail>("request_user_intervention", { taskId, notes });
}

export async function approveLaneCompletion(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    return approveMockLaneCompletion(taskId);
  }

  return invoke<TaskDetail>("approve_lane_completion", { taskId });
}

export async function reassignTaskToLane(taskId: string, laneId: string, notes?: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    return reassignMockTaskToLane(taskId, laneId, notes);
  }

  return invoke<TaskDetail>("reassign_task_to_lane", { taskId, laneId, notes });
}

export async function sendLaneBackForWork(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    return sendMockLaneBackForWork(taskId);
  }

  return invoke<TaskDetail>("send_lane_back_for_work", { taskId });
}

export async function manualTaskWhip(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const task = await getTask(taskId);
    if (!task.activeLaneAssignment) {
      throw new Error(`Task ${taskId} does not have an active lane assignment to whip.`);
    }
    const updated: TaskDetail = {
      ...task,
      activeLaneAssignment: {
        ...task.activeLaneAssignment,
        whipCount: (task.activeLaneAssignment.whipCount ?? 0) + 1,
        lastWhipAt: nowIso(),
      },
      updatedAt: nowIso(),
    };
    saveMockTasks(ensureMockTasks().map((entry) => (entry.id === taskId ? updated : entry)));
    appendMockLog("info", "task.whip.sent", `Sent manual whip for task ${taskId}`);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.whip.sent" });
    return getTask(taskId);
  }

  return invoke<TaskDetail>("manual_task_whip", { taskId });
}

export async function resetTaskRuntime(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const task = await getTask(taskId);
    const resetAt = nowIso();
    const activeAssignment = task.activeLaneAssignment;
    const updated: TaskDetail = {
      ...task,
      status: task.currentLaneId ? "ready" : task.status,
      activeLaneAssignment: null,
      updatedAt: resetAt,
    };

    if (activeAssignment?.workerType === "agent") {
      saveStoredMockAgentQueue(
        getStoredMockAgentQueue().filter((entry) => entry.sourceTaskId !== taskId),
      );
      saveStoredMockAgentRuntimes(
        getStoredMockAgentRuntimes().map((runtime) =>
          runtime.agentId === activeAssignment.workerId && runtime.projectId === CURRENT_PROJECT_ID
            ? {
                ...runtime,
                status: "idle",
                currentQueueEntryId: null,
                lastError: null,
                updatedAt: resetAt,
              }
            : runtime,
        ),
      );
    }

    if (activeAssignment?.workerType === "role") {
      saveStoredMockRoleQueue(
        getStoredMockRoleQueue().map((entry) =>
          entry.sourceTaskId === taskId && ["queued", "assigned"].includes(String(entry.status ?? ""))
            ? {
                ...entry,
                status: "canceled",
                assignedInstanceId: null,
                completedAt: resetAt,
                updatedAt: resetAt,
              }
            : entry,
        ),
      );
      saveStoredMockRoleInstances(
        getStoredMockRoleInstances().map((instance) =>
          instance.id === activeAssignment.roleInstanceId
            ? {
                ...instance,
                status: "idle",
                currentQueueEntryId: null,
                updatedAt: resetAt,
              }
            : instance,
        ),
      );
    }

    saveMockTasks(ensureMockTasks().map((entry) => (entry.id === taskId ? updated : entry)));
    emitMockTaskChange({ taskIds: [taskId], reason: "task.runtime.reset" });
    return getTask(taskId);
  }

  return invoke<TaskDetail>("reset_task_runtime", { taskId });
}

export async function addTaskDependency(blockerTaskId: string, blockedTaskId: string): Promise<TaskDependency> {
  if (!isTauriAvailable()) {
    if (blockerTaskId === blockedTaskId) {
      throw new Error("A task cannot depend on itself.");
    }

    const tasks = ensureMockTasks();
    if (!tasks.some((task) => task.id === blockerTaskId) || !tasks.some((task) => task.id === blockedTaskId)) {
      throw new Error("Both tasks must exist before adding a dependency.");
    }

    const dependencies = ensureMockTaskDependencies();
    if (dependencies.some((dependency) => dependency.blockerTaskId === blockerTaskId && dependency.blockedTaskId === blockedTaskId)) {
      throw new Error("That dependency already exists.");
    }

    let currentBlockedIds = [blockedTaskId];
    const visited = new Set<string>();
    while (currentBlockedIds.length > 0) {
      const current = currentBlockedIds.pop()!;
      if (!visited.add(current)) {
        continue;
      }
      if (current === blockerTaskId) {
        throw new Error("That dependency would create a cycle.");
      }
      currentBlockedIds.push(
        ...dependencies.filter((dependency) => dependency.blockerTaskId === current).map((dependency) => dependency.blockedTaskId),
      );
    }

    const blocker = tasks.find((task) => task.id === blockerTaskId)!;
    const blocked = tasks.find((task) => task.id === blockedTaskId)!;
    const dependency: TaskDependency = {
      id: createId("task-dependency"),
      blockerTaskId,
      blockedTaskId,
      blocker: summarizeTask(blocker),
      blocked: summarizeTask(blocked),
      createdAt: nowIso(),
    };
    saveMockTaskDependencies([...dependencies, dependency]);
    saveMockTasks(tasks);
    appendMockLog("info", "task.dependency.added", `Added dependency ${blockerTaskId} -> ${blockedTaskId}`);
    emitMockTaskChange({ taskIds: [blockerTaskId, blockedTaskId], reason: "task.dependency.added" });
    return dependency;
  }

  return invoke<TaskDependency>("add_task_dependency", { blockerTaskId, blockedTaskId });
}

export async function removeTaskDependency(dependencyId: string): Promise<TaskDependency> {
  if (!isTauriAvailable()) {
    const dependencies = ensureMockTaskDependencies();
    const dependency = dependencies.find((entry) => entry.id === dependencyId);
    if (!dependency) {
      throw new Error(`Task dependency ${dependencyId} was not found`);
    }

    saveMockTaskDependencies(dependencies.filter((entry) => entry.id !== dependencyId));
    saveMockTasks(ensureMockTasks());
    appendMockLog("info", "task.dependency.removed", `Removed dependency ${dependencyId}`);
    emitMockTaskChange({ taskIds: [dependency.blockerTaskId, dependency.blockedTaskId], reason: "task.dependency.removed" });
    return dependency;
  }

  return invoke<TaskDependency>("remove_task_dependency", { dependencyId });
}

export async function searchTaskCommentFileMentions(taskId: string, query: string, limit = 10): Promise<TaskCommentFileMentionCandidate[]> {
  if (!isTauriAvailable()) {
    return [];
  }

  return invoke<TaskCommentFileMentionCandidate[]>("search_task_comment_file_mentions", { taskId, query, limit });
}

export async function commentOnTask(taskId: string, input: TaskCommentInput): Promise<TaskComment> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    const author = input.author.trim();
    const message = input.message.trim();
    const parentCommentId = input.parentCommentId?.trim() || null;
    if (!author) {
      throw new Error("author: Comment author is required.");
    }
    if (!message) {
      throw new Error("message: Comment message is required.");
    }
    if (parentCommentId) {
      const parent = task.comments.find((entry) => entry.id === parentCommentId) ?? null;
      if (!parent) {
        throw new Error(`parentCommentId: Comment ${parentCommentId} was not found.`);
      }
      if (parent.parentCommentId) {
        throw new Error("parentCommentId: Replies can only target top-level comments.");
      }
    }

    const comment: TaskComment = {
      id: createId("task-comment"),
      taskId,
      parentCommentId,
      author,
      message,
      interruptAgent: input.interruptAgent,
      repositoryId: input.repositoryId?.trim() || null,
      relativePath: input.relativePath?.trim() || null,
      lineStart: input.lineStart ?? null,
      lineEnd: input.lineEnd ?? input.lineStart ?? null,
      columnStart: input.columnStart ?? null,
      columnEnd: input.columnEnd ?? null,
      selectedText: input.selectedText?.trim() || null,
      anchorCommitHash: null,
      anchorHasUncommittedChanges: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    saveMockTasks(
      tasks.map((entry) =>
        entry.id === taskId
          ? {
              ...entry,
              comments: [...entry.comments, comment],
              updatedAt: comment.updatedAt,
            }
          : entry,
      ),
    );
    appendMockLog(
      "info",
      input.interruptAgent ? "task.comment.interrupt_requested" : "task.commented",
      `Added comment ${comment.id} to task ${taskId}`,
    );
    appendMockDomainEvent("task.comment_added", "task", taskId, { taskId, commentId: comment.id, interrupt: input.interruptAgent }, task.projectId);
    emitMockTaskChange({
      taskIds: [taskId],
      reason: input.interruptAgent ? "task.comment.interrupt_requested" : "task.commented",
    });
    return comment;
  }

  return invoke<TaskComment>("comment_on_task", { taskId, input });
}

export async function listInboxMessages(projectId?: string | null, includeArchived = false): Promise<MailboxMessage[]> {
  if (!isTauriAvailable()) {
    return getStoredMailboxMessages()
      .filter((message) => message.recipientType === "user" && (!projectId || message.projectId === projectId))
      .filter((message) => includeArchived || !message.archivedAt)
      .sort((left, right) => {
        if (!left.archivedAt && right.archivedAt) return -1;
        if (left.archivedAt && !right.archivedAt) return 1;
        if (!left.readAt && right.readAt) return -1;
        if (left.readAt && !right.readAt) return 1;
        return right.createdAt.localeCompare(left.createdAt);
      });
  }

  return invoke<MailboxMessage[]>("list_inbox_messages", { projectId: projectId ?? null, includeArchived });
}

export async function listTaskMessages(taskId: string): Promise<MailboxMessage[]> {
  if (!isTauriAvailable()) {
    return getStoredMailboxMessages()
      .filter((message) => message.taskId === taskId)
      .sort((left, right) => right.createdAt.localeCompare(left.createdAt));
  }

  return invoke<MailboxMessage[]>("list_task_messages", { taskId });
}

export async function sendMailboxMessage(input: SendMailboxMessageInput): Promise<MailboxMessage> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = input.taskId ? tasks.find((entry) => entry.id === input.taskId) ?? null : null;
    const projectId = task?.projectId ?? input.projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID;
    const projects = getStoredValue<Array<{ id: string; repositories: Array<{ id: string; name: string; slug: string; localPath?: string | null }> }>>("orchestra.mock.projects") ?? [];
    const storedAgents = getStoredValue<AgentSummary[]>(AGENT_STORAGE_KEY) ?? [];
    let recipientType = input.recipientType;
    let recipientId = input.recipientId ?? null;
    let recipientLabel = "User";
    let assignmentId: string | null = null;

    if (recipientType === "agent") {
      const agent = storedAgents.find((entry) => entry.id === input.recipientId);
      if (!agent) {
        throw new Error(`Agent ${input.recipientId} was not found`);
      }
      recipientLabel = agent.name;
    } else if (recipientType === "active_assignment") {
      if (!task?.activeLaneAssignment) {
        throw new Error(`Task ${input.taskId} has no active assignment mailbox`);
      }
      recipientType = "assignment";
      recipientId = task.activeLaneAssignment.workerId ?? null;
      assignmentId = task.activeLaneAssignment.id;
      const agent = storedAgents.find((entry) => entry.id === task.activeLaneAssignment?.workerId);
      recipientLabel = `${agent?.name ?? task.activeLaneAssignment.workerType} · ${task.number}`;
    }

    const message: MailboxMessage = {
      deliveryId: createId("mail-delivery"),
      messageId: createId("mail-message"),
      projectId,
      taskId: task?.id ?? input.taskId ?? null,
      taskNumber: task?.number ?? null,
      taskTitle: task?.title ?? null,
      senderType: "user",
      senderId: "desktop-user",
      senderLabel: input.senderLabel?.trim() || "User",
      recipientType,
      recipientId,
      recipientLabel,
      assignmentId,
      body: input.body.trim(),
      priority: input.priority === "interrupt" ? "interrupt" : "normal",
      readAt: null,
      readSessionId: null,
      archivedAt: null,
      lastNotifiedAt: recipientType === "user" ? null : nowIso(),
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };

    saveStoredMailboxMessages([message, ...getStoredMailboxMessages()]);
    emitMockInboxChange({ deliveryIds: [message.deliveryId], reason: "mailbox.sent" });
    if (message.taskId) {
      emitMockTaskChange({ taskIds: [message.taskId], reason: "mailbox.sent" });
    }
    appendMockLog("info", "mailbox.sent", `Sent mailbox delivery ${message.deliveryId} to ${message.recipientLabel}`);
    return message;
  }

  return invoke<MailboxMessage>("send_mailbox_message", { input });
}

export async function markMailboxMessagesRead(input: MarkMailboxMessagesReadInput): Promise<MailboxMessage[]> {
  if (!isTauriAvailable()) {
    const now = nowIso();
    const selectedIds = new Set(input.deliveryIds ?? getStoredMailboxMessages().filter((entry) => entry.recipientType === "user" && !entry.readAt).map((entry) => entry.deliveryId));
    const updated: MailboxMessage[] = [];
    saveStoredMailboxMessages(
      getStoredMailboxMessages().map((entry) => {
        if (entry.recipientType !== "user" || !selectedIds.has(entry.deliveryId)) {
          return entry;
        }
        const nextEntry = { ...entry, readAt: now, readSessionId: "desktop-user", updatedAt: now };
        updated.push(nextEntry);
        return nextEntry;
      }),
    );
    if (updated.length) {
      emitMockInboxChange({ deliveryIds: updated.map((entry) => entry.deliveryId), reason: "mailbox.read" });
    }
    return updated;
  }

  return invoke<MailboxMessage[]>("mark_mailbox_messages_read", { input });
}

export async function archiveMailboxMessages(input: ArchiveMailboxMessagesInput): Promise<MailboxMessage[]> {
  if (!isTauriAvailable()) {
    const now = nowIso();
    const selectedIds = new Set(input.deliveryIds ?? getStoredMailboxMessages().filter((entry) => entry.recipientType === "user" && !entry.archivedAt).map((entry) => entry.deliveryId));
    const updated: MailboxMessage[] = [];
    saveStoredMailboxMessages(
      getStoredMailboxMessages().map((entry) => {
        if (entry.recipientType !== "user" || !selectedIds.has(entry.deliveryId)) {
          return entry;
        }
        const nextEntry = { ...entry, archivedAt: now, updatedAt: now };
        updated.push(nextEntry);
        return nextEntry;
      }),
    );
    if (updated.length) {
      emitMockInboxChange({ deliveryIds: updated.map((entry) => entry.deliveryId), reason: "mailbox.archived" });
    }
    return updated;
  }

  return invoke<MailboxMessage[]>("archive_mailbox_messages", { input });
}

export async function listTaskComments(taskId: string): Promise<TaskComment[]> {
  if (!isTauriAvailable()) {
    const task = ensureMockTasks().find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task.comments;
  }

  return invoke<TaskComment[]>("list_task_comments", { taskId });
}

export async function updateTaskComment(commentId: string, input: TaskCommentUpdateInput): Promise<TaskComment> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    let updated: TaskComment | null = null;
    saveMockTasks(tasks.map((task) => ({
      ...task,
      comments: task.comments.map((comment) => {
        if (comment.id !== commentId) {
          return comment;
        }
        updated = { ...comment, message: input.message.trim(), updatedAt: nowIso() };
        return updated;
      }),
    })));
    if (!updated) {
      throw new Error(`Task comment ${commentId} was not found`);
    }
    const updatedComment = updated as TaskComment;
    appendMockDomainEvent("task.comment_updated", "task", updatedComment.taskId, { taskId: updatedComment.taskId, commentId: updatedComment.id }, ensureMockTasks().find((task) => task.id === updatedComment.taskId)?.projectId ?? null);
    return updatedComment;
  }

  return invoke<TaskComment>("update_task_comment", { commentId, input });
}

export async function deleteTaskComment(commentId: string): Promise<TaskComment> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    let removed: TaskComment | null = null;
    saveMockTasks(tasks.map((task) => {
      const target = task.comments.find((comment) => comment.id === commentId);
      if (!target) {
        return task;
      }
      removed = target;
      const removedIds = new Set([commentId, ...task.comments.filter((comment) => comment.parentCommentId === commentId).map((comment) => comment.id)]);
      return {
        ...task,
        comments: task.comments.filter((comment) => !removedIds.has(comment.id)),
      };
    }));
    if (!removed) {
      throw new Error(`Task comment ${commentId} was not found`);
    }
    const removedComment = removed as TaskComment;
    appendMockDomainEvent("task.comment_deleted", "task", removedComment.taskId, { taskId: removedComment.taskId, commentId: removedComment.id }, ensureMockTasks().find((task) => task.id === removedComment.taskId)?.projectId ?? null);
    return removedComment;
  }

  return invoke<TaskComment>("delete_task_comment", { commentId });
}

export async function addTaskFileReference(taskId: string, input: TaskFileReferenceInput): Promise<TaskFileReference> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    const projects = getStoredValue<Array<{ id: string; repositories: Array<{ id: string; name: string; slug: string; localPath?: string | null }> }>>("orchestra.mock.projects") ?? [];
    const project = projects.find((entry) => entry.id === task.projectId) ?? null;
    const repository = project?.repositories.find((entry) => entry.id === input.repositoryId) ?? null;
    if (!repository) {
      throw new Error(`Repository ${input.repositoryId} was not found`);
    }

    const relativePath = input.relativePath.trim().replace(/\\/g, "/").replace(/^\.\//, "");
    if (!relativePath || relativePath.startsWith("/") || relativePath.split("/").includes("..")) {
      throw new Error("relativePath: File path must stay inside the repository root.");
    }

    const reference: TaskFileReference = {
      id: createId("task-file-reference"),
      taskId,
      repositoryId: repository.id,
      repositoryName: repository.name,
      repositorySlug: repository.slug,
      relativePath,
      absolutePath: repository.localPath ? `${repository.localPath.replace(/\/$/, "")}/${relativePath}` : null,
      exists: false,
      isDefault: false,
      createdAt: nowIso(),
    };

    saveMockTasks(
      tasks.map((entry) =>
        entry.id === taskId
          ? { ...entry, fileReferences: [...entry.fileReferences, reference], updatedAt: reference.createdAt }
          : entry,
      ),
    );
    appendMockLog("info", "task.file_reference.added", `Added file reference ${reference.id} to task ${taskId}`);
    appendMockDomainEvent("task.file_reference_added", "task", taskId, { taskId, referenceId: reference.id, relativePath: reference.relativePath }, task.projectId);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.file_reference.added" });
    return reference;
  }

  return invoke<TaskFileReference>("add_task_file_reference", { taskId, input });
}

export async function listTaskFileReferences(taskId: string): Promise<TaskFileReference[]> {
  if (!isTauriAvailable()) {
    const task = ensureMockTasks().find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task.fileReferences;
  }

  return invoke<TaskFileReference[]>("list_task_file_references", { taskId });
}

export async function setDefaultTaskFileReference(referenceId: string): Promise<TaskFileReference> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const updated = tasks.map((task) => ({
      ...task,
      fileReferences: task.fileReferences.map((reference) => ({
        ...reference,
        isDefault: reference.id === referenceId,
      })),
    }));

    saveMockTasks(updated);
    const reference = updated
      .flatMap((task) => task.fileReferences)
      .find((reference) => reference.id === referenceId);

    if (!reference) {
      throw new Error(`Task file reference ${referenceId} was not found`);
    }

    appendMockLog("info", "task.file_reference.default_set", `Set ${referenceId} as default`);
    emitMockTaskChange({ taskIds: [reference.taskId], reason: "task.file_reference.default_set" });
    return reference;
  }

  return invoke<TaskFileReference>("set_default_task_file_reference", { referenceId });
}

export async function getTaskFileContent(path: string): Promise<string> {
  if (!isTauriAvailable()) {
    const storedContents = getStoredValue<Record<string, string>>(TASK_FILE_CONTENT_STORAGE_KEY) ?? {};
    return storedContents[path] ?? [
      `Mocked file content for: ${path}`,
      "Second line for anchored comments.",
      "Third line with text selection support.",
    ].join("\n");
  }

  return invoke<string>("get_task_file_content", { path });
}

export async function removeTaskFileReference(referenceId: string): Promise<TaskFileReference> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    let removed: TaskFileReference | null = null;
    const updated = tasks.map((task) => {
      const match = task.fileReferences.find((reference) => reference.id === referenceId) ?? null;
      if (!match) {
        return task;
      }
      removed = match;
      return {
        ...task,
        fileReferences: task.fileReferences.filter((reference) => reference.id !== referenceId),
      };
    });

    if (!removed) {
      throw new Error(`Task file reference ${referenceId} was not found`);
    }

    const removedReference = removed as TaskFileReference;
    saveMockTasks(updated);
    appendMockLog("info", "task.file_reference.removed", `Removed file reference ${referenceId}`);
    appendMockDomainEvent("task.file_reference_removed", "task", removedReference.taskId, { taskId: removedReference.taskId, referenceId: removedReference.id, relativePath: removedReference.relativePath }, ensureMockTasks().find((task) => task.id === removedReference.taskId)?.projectId ?? null);
    emitMockTaskChange({ taskIds: [removedReference.taskId], reason: "task.file_reference.removed" });
    return removedReference;
  }

  return invoke<TaskFileReference>("remove_task_file_reference", { referenceId });
}

export async function addTaskAttachment(taskId: string, input: TaskAttachmentInput): Promise<TaskAttachment> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    const bytes = atob(input.base64Data);
    const imageDataUrl = input.mediaType.startsWith("image/") ? `data:${input.mediaType};base64,${input.base64Data}` : null;
    const previewText = input.mediaType.startsWith("text/") || input.mediaType === "application/json" ? bytes : null;
    const attachment: TaskAttachment = {
      id: createId("task-attachment"),
      taskId,
      fileName: input.fileName,
      mediaType: input.mediaType || "application/octet-stream",
      byteSize: bytes.length,
      storedPath: `/mock/attachments/${taskId}/${input.fileName}`,
      caption: input.caption?.trim() || null,
      previewText,
      imageDataUrl,
      createdAt: nowIso(),
    };

    saveMockTasks(tasks.map((entry) => (entry.id === taskId ? { ...entry, attachments: [...entry.attachments, attachment] } : entry)));
    appendMockLog("info", "task.attachment.added", `Added attachment ${attachment.id} to task ${taskId}`);
    appendMockDomainEvent("task.attachment_added", "task", taskId, { taskId, attachmentId: attachment.id, fileName: attachment.fileName }, task.projectId);
    emitMockTaskChange({ taskIds: [taskId], reason: "task.attachment.added" });
    return attachment;
  }

  return invoke<TaskAttachment>("add_task_attachment", { taskId, input });
}

export async function removeTaskAttachment(attachmentId: string): Promise<TaskAttachment> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    let removed: TaskAttachment | null = null;
    const updated = tasks.map((task) => {
      const match = task.attachments.find((attachment) => attachment.id === attachmentId) ?? null;
      if (!match) {
        return task;
      }
      removed = match;
      return {
        ...task,
        attachments: task.attachments.filter((attachment) => attachment.id !== attachmentId),
      };
    });

    if (!removed) {
      throw new Error(`Task attachment ${attachmentId} was not found`);
    }

    const removedAttachment = removed as TaskAttachment;
    saveMockTasks(updated);
    appendMockLog("info", "task.attachment.removed", `Removed attachment ${attachmentId}`);
    appendMockDomainEvent("task.attachment_removed", "task", removedAttachment.taskId, { taskId: removedAttachment.taskId, attachmentId: removedAttachment.id, fileName: removedAttachment.fileName }, ensureMockTasks().find((task) => task.id === removedAttachment.taskId)?.projectId ?? null);
    emitMockTaskChange({ taskIds: [removedAttachment.taskId], reason: "task.attachment.removed" });
    return removedAttachment;
  }

  return invoke<TaskAttachment>("remove_task_attachment", { attachmentId });
}

export async function listTaskSchedules(projectId?: string | null): Promise<TaskScheduleSummary[]> {
  const activeProjectId = projectId ?? getActiveProjectId();
  if (!isTauriAvailable()) {
    return processMockTaskSchedules(activeProjectId).schedules
      .filter((schedule) => schedule.projectId === activeProjectId)
      .map((schedule) => summarizeTaskSchedule(schedule, ensureMockTasks()));
  }

  const resolvedProjectId = await resolveTauriProjectId(projectId);
  return invoke<TaskScheduleSummary[]>("list_task_schedules", { projectId: resolvedProjectId });
}

export async function getTaskSchedule(scheduleId: string): Promise<TaskScheduleDetail> {
  if (!isTauriAvailable()) {
    const processed = processMockTaskSchedules();
    const schedule = processed.schedules.find((entry) => entry.id === scheduleId);
    if (!schedule) {
      throw new Error(`Task schedule ${scheduleId} was not found`);
    }
    return hydrateTaskScheduleDetail(schedule, processed.tasks);
  }

  return invoke<TaskScheduleDetail>("get_task_schedule", { scheduleId });
}

export async function createTaskSchedule(input: TaskScheduleUpsertInput, projectId?: string | null): Promise<TaskScheduleDetail> {
  const activeProjectId = projectId ?? getActiveProjectId();
  if (!isTauriAvailable()) {
    const validation = validateMockTaskScheduleInput(input);
    if (validation.length > 0) {
      throw new Error(validation.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const schedule = normalizeMockTaskScheduleInput(input, undefined, activeProjectId ?? undefined);
    saveMockTaskSchedules([schedule, ...ensureMockTaskSchedules()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
    const processed = processMockTaskSchedules(activeProjectId);
    appendMockLog("info", "task.schedule.created", `Created task schedule ${schedule.id}`);
    appendMockDomainEvent("task.schedule.created", "task_schedule", schedule.id, { scheduleId: schedule.id, title: schedule.taskBlueprint.title, enabled: schedule.enabled, triggerType: schedule.trigger.type }, schedule.projectId);
    emitMockTaskChange({ taskIds: [], reason: "task.schedule.created" });
    const created = processed.schedules.find((entry) => entry.id === schedule.id);
    if (!created) {
      throw new Error(`Task schedule ${schedule.id} was not found after creation`);
    }
    return hydrateTaskScheduleDetail(created, processed.tasks);
  }

  const resolvedProjectId = await resolveTauriProjectId(projectId);
  return invoke<TaskScheduleDetail>("create_task_schedule", { projectId: resolvedProjectId, input });
}

export async function updateTaskSchedule(scheduleId: string, input: TaskScheduleUpsertInput): Promise<TaskScheduleDetail> {
  if (!isTauriAvailable()) {
    const validation = validateMockTaskScheduleInput(input);
    if (validation.length > 0) {
      throw new Error(validation.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const schedules = ensureMockTaskSchedules();
    const existing = schedules.find((schedule) => schedule.id === scheduleId);
    if (!existing) {
      throw new Error(`Task schedule ${scheduleId} was not found`);
    }

    const updated = normalizeMockTaskScheduleInput(input, {
      ...existing,
      trigger: input.trigger,
      nextFireAt: input.trigger.type === "time" ? nextMockTimeFireAt(input.trigger, nowIso()) : null,
    });
    updated.occurrences = existing.occurrences;
    updated.lastFiredAt = existing.lastFiredAt ?? null;
    updated.lastMaterializedTaskId = existing.lastMaterializedTaskId ?? null;
    updated.lastError = existing.lastError ?? null;
    saveMockTaskSchedules(
      schedules
        .map((schedule) => (schedule.id === scheduleId ? updated : schedule))
        .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)),
    );
    const processed = processMockTaskSchedules(existing.projectId);
    appendMockLog("info", "task.schedule.updated", `Updated task schedule ${scheduleId}`);
    appendMockDomainEvent("task.schedule.updated", "task_schedule", scheduleId, { scheduleId, title: updated.taskBlueprint.title, enabled: updated.enabled, triggerType: updated.trigger.type }, updated.projectId);
    emitMockTaskChange({ taskIds: [], reason: "task.schedule.updated" });
    const refreshed = processed.schedules.find((schedule) => schedule.id === scheduleId);
    if (!refreshed) {
      throw new Error(`Task schedule ${scheduleId} was not found after update`);
    }
    return hydrateTaskScheduleDetail(refreshed, processed.tasks);
  }

  return invoke<TaskScheduleDetail>("update_task_schedule", { scheduleId, input });
}

export async function deleteTaskSchedule(scheduleId: string): Promise<TaskScheduleDetail> {
  if (!isTauriAvailable()) {
    const processed = processMockTaskSchedules();
    const schedules = processed.schedules;
    const existing = schedules.find((schedule) => schedule.id === scheduleId);
    if (!existing) {
      throw new Error(`Task schedule ${scheduleId} was not found`);
    }

    saveMockTaskSchedules(schedules.filter((schedule) => schedule.id !== scheduleId));
    appendMockLog("info", "task.schedule.deleted", `Deleted task schedule ${scheduleId}`);
    appendMockDomainEvent("task.schedule.deleted", "task_schedule", scheduleId, { scheduleId, title: existing.taskBlueprint.title }, existing.projectId);
    emitMockTaskChange({ taskIds: [], reason: "task.schedule.deleted" });
    return hydrateTaskScheduleDetail(existing, processed.tasks);
  }

  return invoke<TaskScheduleDetail>("delete_task_schedule", { scheduleId });
}

export async function listWorkflows(includeArchived = false): Promise<WorkflowSummary[]> {
  if (!isTauriAvailable()) {
    return ensureMockWorkflows().filter((workflow) => includeArchived || !workflow.archived).map(summarizeWorkflow);
  }

  return invoke<WorkflowSummary[]>("list_workflows", { includeArchived });
}

export async function getWorkflow(workflowId: string): Promise<WorkflowDefinition> {
  if (!isTauriAvailable()) {
    const workflow = ensureMockWorkflows().find((entry) => entry.id === workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} was not found`);
    }
    return workflow;
  }

  return invoke<WorkflowDefinition>("get_workflow", { workflowId });
}

export async function validateWorkflow(input: WorkflowUpsertInput): Promise<WorkflowValidationResult> {
  if (!isTauriAvailable()) {
    return validateMockWorkflowInput(input);
  }

  return invoke<WorkflowValidationResult>("validate_workflow", { input });
}

export async function createWorkflow(input: WorkflowUpsertInput): Promise<WorkflowDefinition> {
  if (!isTauriAvailable()) {
    const validation = validateMockWorkflowInput(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const workflow = normalizeMockWorkflowInput(input);
    saveMockWorkflows([workflow, ...ensureMockWorkflows()]);
    appendMockLog("info", "workflow.created", `Created workflow ${workflow.id}`);
    return workflow;
  }

  return invoke<WorkflowDefinition>("create_workflow", { input });
}

export async function updateWorkflow(workflowId: string, input: WorkflowUpsertInput): Promise<WorkflowDefinition> {
  if (!isTauriAvailable()) {
    const validation = validateMockWorkflowInput(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const workflows = ensureMockWorkflows();
    const existing = workflows.find((workflow) => workflow.id === workflowId);
    if (!existing) {
      throw new Error(`Workflow ${workflowId} was not found`);
    }

    const updated = normalizeMockWorkflowInput(input, existing);
    saveMockWorkflows(workflows.map((workflow) => (workflow.id === workflowId ? updated : workflow)));
    appendMockLog("info", "workflow.updated", `Updated workflow ${workflowId}`);
    return updated;
  }

  return invoke<WorkflowDefinition>("update_workflow", { workflowId, input });
}

export async function duplicateWorkflow(workflowId: string, newName?: string): Promise<WorkflowDefinition> {
  if (!isTauriAvailable()) {
    const workflow = await getWorkflow(workflowId);
    const duplicatedInput: WorkflowUpsertInput = {
      name: newName?.trim() || `${workflow.name} Copy`,
      description: workflow.description,
      lanes: workflow.lanes.map((lane, index) => ({
        key: lane.key,
        name: lane.name,
        description: lane.description,
        order: index,
        assignedEntityType: lane.assignedEntityType,
        assignedEntityId: lane.assignedEntityId,
        entryPromptTemplate: lane.entryPromptTemplate,
        useSeparateWorktree: lane.useSeparateWorktree ?? false,
        requireUserApprovalOnSuccess: lane.requireUserApprovalOnSuccess ?? false,
        successTransitionType: lane.successTransitionType,
        successTargetLaneId: lane.successTargetLaneId,
        failureTransitionType: lane.failureTransitionType,
        failureTargetLaneId: lane.failureTargetLaneId,
      })),
    };

    return createWorkflow(duplicatedInput);
  }

  return invoke<WorkflowDefinition>("duplicate_workflow", { workflowId, newName });
}

export async function archiveWorkflow(workflowId: string): Promise<WorkflowDefinition> {
  if (!isTauriAvailable()) {
    const workflows = ensureMockWorkflows();
    const workflow = workflows.find((entry) => entry.id === workflowId);
    if (!workflow) {
      throw new Error(`Workflow ${workflowId} was not found`);
    }

    const archived = {
      ...workflow,
      archived: true,
      updatedAt: nowIso(),
    };

    saveMockWorkflows(workflows.map((entry) => (entry.id === workflowId ? archived : entry)));
    appendMockLog("info", "workflow.archived", `Archived workflow ${workflowId}`);
    return archived;
  }

  return invoke<WorkflowDefinition>("archive_workflow", { workflowId });
}
