import { invoke } from "@tauri-apps/api/core";
import { getActiveProjectId } from "./projects";
import type {
  AgentSummary,
  AppInfo,
  JsonValue,
  LogEntry,
  LogLevel,
  QueuedSessionMessage,
  RoleSummary,
  SessionChangeEvent,
  SessionEvent,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionStreamEnvelope,
  TaskAttachment,
  TaskAttachmentInput,
  TaskComment,
  TaskChangeEvent,
  TaskCommentInput,
  TaskDependency,
  TaskDetail,
  TaskLaneAssignment,
  TaskLaneRun,
  TaskSummary,
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
const TASK_DEPENDENCY_STORAGE_KEY = "orchestra.mock.task-dependencies";
const AGENT_STORAGE_KEY = "orchestra.mock.agents";
const AGENT_RUNTIME_STORAGE_KEY = "orchestra.mock.agent-runtimes";
const AGENT_QUEUE_STORAGE_KEY = "orchestra.mock.agent-queue";
const ROLE_STORAGE_KEY = "orchestra.mock.roles";
const CURRENT_PROJECT_ID = "orchestra";

function sessionStorageKey() {
  return `${SESSION_STORAGE_KEY}.${getActiveProjectId() ?? CURRENT_PROJECT_ID}`;
}

function sessionModelStorageKey() {
  return `${SESSION_MODEL_STORAGE_KEY}.${getActiveProjectId() ?? CURRENT_PROJECT_ID}`;
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

function createLogEntry(level: LogLevel, target: string, message: string): LogEntry {
  return {
    id: createId("log"),
    level,
    target,
    message,
    timestamp: nowIso(),
  };
}

function createEvent(kind: SessionEvent["kind"], message: string): SessionEvent {
  return {
    id: createId("event"),
    kind,
    message,
    timestamp: nowIso(),
  };
}

function getStoredValue<T>(key: string): T | null {
  const value = window.localStorage.getItem(key);
  return value ? (JSON.parse(value) as T) : null;
}

function setStoredValue<T>(key: string, value: T) {
  window.localStorage.setItem(key, JSON.stringify(value));
}

function emitMockSessionStream(event: SessionStreamEnvelope) {
  window.dispatchEvent(new CustomEvent("orchestra:session-stream", { detail: event }));
}

export function emitMockSessionChange(event: SessionChangeEvent) {
  window.dispatchEvent(new CustomEvent("orchestra:session-change", { detail: event }));
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
    return existing;
  }

  const seeded = seedMockLogs();
  setStoredValue(LOG_STORAGE_KEY, seeded);
  return seeded;
}

function ensureMockSessions() {
  const existing = getStoredValue<SessionRecord[]>(sessionStorageKey());
  if (existing) {
    return existing;
  }

  const seeded = seedMockSessions();
  setStoredValue(sessionStorageKey(), seeded);
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

function saveMockSessions(sessions: SessionRecord[]) {
  setStoredValue(sessionStorageKey(), sessions);
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
            runtimeCwd: (typeof entry.runtimeCwd === "string" && entry.runtimeCwd) ? entry.runtimeCwd : `/mock/projects/${CURRENT_PROJECT_ID}`,
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
  return [...sessions].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
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
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
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
      activeLaneAssignment: null,
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
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

function summarizeTask(task: TaskDetail): TaskSummary {
  const dependencyBlocked = task.blockedBy.some((dependency) => !["completed", "canceled"].includes(dependency.blocker.status));
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
    blockedChildCount: task.children.filter((child) => child.status === "blocked").length,
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

      const dependencyBlocked = blockedBy.some((dependency) => !["completed", "canceled"].includes(dependency.blocker.status));

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
        blockedChildCount: children.filter((child) => child.status === "blocked").length,
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

function normalizeMockTaskInput(input: TaskUpsertInput, existingTask?: TaskDetail): TaskDetail {
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
    projectId: existingTask?.projectId ?? getActiveProjectId() ?? CURRENT_PROJECT_ID,
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
    repositoryId: input.repositoryId?.trim() || null,
    parentTaskId: input.parentTaskId?.trim() || null,
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
    activeLaneAssignment: existingTask?.activeLaneAssignment ?? null,
    createdAt: existingTask?.createdAt ?? timestamp,
    updatedAt: timestamp,
    comments: existingTask?.comments ?? [],
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

export async function getAppInfo(): Promise<AppInfo> {
  if (!isTauriAvailable()) {
    return {
      appName: "Orchestra",
      environment: "browser",
      backendStatus: "mock",
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

export async function clearLogs(): Promise<void> {
  if (!isTauriAvailable()) {
    setStoredValue(LOG_STORAGE_KEY, [] satisfies LogEntry[]);
    return;
  }

  await invoke("clear_logs");
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
    return new URLSearchParams(window.location.search).get("view") === "logs";
  }

  const { getCurrentWebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  return getCurrentWebviewWindow().label === "logs";
}

export async function listSessions(): Promise<SessionRecord[]> {
  if (!isTauriAvailable()) {
    return sortSessions(ensureMockSessions());
  }

  return invoke<SessionRecord[]>("list_sessions");
}

export async function getSessionRecord(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const session = ensureMockSessions().find((entry) => entry.id === sessionId) ?? null;
    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    return session;
  }

  return invoke<SessionRecord>("get_session_record", { sessionId });
}

export async function createSession(title?: string): Promise<SessionRecord> {
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

  return invoke<SessionRecord>("create_session", { title });
}

export async function deleteSession(sessionId: string): Promise<void> {
  if (!isTauriAvailable()) {
    saveMockSessions(ensureMockSessions().filter((session) => session.id !== sessionId));
    const models = getMockSessionModels();
    delete models[sessionId];
    setMockSessionModels(models);
    appendMockLog("info", "sessions.delete", `Deleted session ${sessionId}`);
    return;
  }

  await invoke("delete_session", { sessionId });
}

export async function resumeSession(sessionId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const session = updateMockSession(sessionId, (current) => ({
      ...current,
      status: "active",
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
      updatedAt: nowIso(),
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
      updatedAt: nowIso(),
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.unsubscribe", `Unsubscribed from session ${session.id}`);
    return session;
  }

  return invoke<SessionRecord>("unsubscribe_session", { sessionId });
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

    const assistantReply = generateAssistantReply(trimmedMessage);
    const chunks = assistantReply.split(/(\s+)/).filter(Boolean);
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
        message: { ...assistantMessageBase, content: [{ type: "thinking", thinking: "" }] },
        assistantMessageEvent: { type: "thinking_start", contentIndex: 0, partial: {} },
      }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
        type: "message_update",
        message: { ...assistantMessageBase, content: [{ type: "thinking", thinking: "Thinking…" }] },
        assistantMessageEvent: { type: "thinking_end", contentIndex: 0, partial: {} },
      }));
      emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
        type: "message_update",
        message: { ...assistantMessageBase, content: [{ type: "text", text: "" }] },
        assistantMessageEvent: { type: "text_start", contentIndex: 0, partial: {} },
      }));

      chunks.forEach((chunk, index) => {
        window.setTimeout(() => {
          emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, {
            type: "message_update",
            message: { ...assistantMessageBase, content: [{ type: "text", text: assistantReply.slice(0, assistantReply.indexOf(chunk) >= 0 ? assistantReply.indexOf(chunk) + chunk.length : assistantReply.length) }] },
            assistantMessageEvent: { type: "text_delta", contentIndex: 0, delta: chunk, partial: {} },
          }));
        }, 80 * (index + 1));
      });

      window.setTimeout(() => {
        const assistantMessage = {
          ...assistantMessageBase,
          content: [{ type: "text", text: assistantReply }],
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
              {
                id: createId("event"),
                kind: "assistant",
                message: assistantReply,
                timestamp,
              },
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

        appendMockLog("info", "sessions.message", `Sent message to session ${session.id}`);
        emitMockSessionStream(createMockSessionEnvelope(sessionId, runId, { type: "agent_end" }));
      }, 80 * (chunks.length + 2));
    }, 120);

    return queued;
  }

  return invoke<QueuedSessionMessage>("send_session_message", { sessionId, message: trimmedMessage, runId });
}

export async function listTasks(includeArchived = false): Promise<TaskSummary[]> {
  const activeProjectId = getActiveProjectId();
  if (!isTauriAvailable()) {
    return ensureMockTasks()
      .filter((task) => task.projectId === activeProjectId)
      .filter((task) => includeArchived || !task.archived)
      .map(summarizeTask);
  }

  return invoke<TaskSummary[]>("list_tasks", { projectId: activeProjectId, includeArchived });
}

export async function getTask(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const activeProjectId = getActiveProjectId();
    const task = ensureMockTasks().find((entry) => entry.projectId === activeProjectId && entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }

  return invoke<TaskDetail>("get_task", { taskId });
}

export async function createTask(input: TaskUpsertInput): Promise<TaskDetail> {
  const activeProjectId = getActiveProjectId();
  if (!isTauriAvailable()) {
    const validation = validateMockTaskInput(input);
    if (validation.length > 0) {
      throw new Error(validation.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const task = normalizeMockTaskInput(input);
    saveMockTasks([task, ...ensureMockTasks()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
    appendMockLog("info", "task.created", `Created task ${task.id}`);
    emitMockTaskChange({ taskIds: [task.id], reason: "task.created" });
    return task;
  }

  return invoke<TaskDetail>("create_task", { projectId: activeProjectId, input });
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
    emitMockTaskChange({ taskIds: [taskId], reason: "task.updated" });
    return getTask(taskId);
  }

  return invoke<TaskDetail>("update_task", { taskId, input });
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
      assignment.runtimeCwd = `/mock/projects/${CURRENT_PROJECT_ID}`;
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
      const roleSession = createMockSessionRecord(
        `${lane.name} · ${task.title}`,
        `Role runtime session for ${task.number} is active and ready to continue the assigned lane.`,
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
    if (assignment.sessionId) {
      emitMockSessionChange({ sessionIds: [assignment.sessionId], reason: "task.dispatch" });
    }
    emitMockTaskChange({ taskIds: [taskId], reason: "task.dispatch" });
    return getTask(taskId);
  }

  return invoke<TaskDetail>("dispatch_task_lane", { taskId });
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
  const laneRuns = task.activeLaneAssignment
    ? task.laneRuns.map((run, index, allRuns) =>
        index === allRuns.length - 1 && run.completedAt == null
          ? { ...run, result: outcome, notes: notes ?? run.notes ?? null, completedAt: updatedAt }
          : run,
      )
    : task.laneRuns;

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
      ? {
          id: createId("task-assignment"),
          taskId,
          workflowId: workflow.id,
          laneId: nextLane.id,
          workerType: nextLane.assignedEntityType,
          workerId: nextLane.assignedEntityId ?? null,
          status: "active",
          sessionId: createId("session"),
          runtimeCwd: `/mock/runtime/${nextLane.assignedEntityType}/${nextLane.assignedEntityId ?? "user"}`,
          roleQueueEntryId: nextLane.assignedEntityType === "role" ? createId("queue") : null,
          roleInstanceId: nextLane.assignedEntityType === "role" ? createId("instance") : null,
          prompt: `Work task ${task.number}: ${task.title}`,
          startedAt: updatedAt,
          completedAt: null,
          createdAt: updatedAt,
          updatedAt,
        }
      : null;

  const nextTasks = tasks.map((entry) =>
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
  );

  if (task.activeLaneAssignment?.workerType === "agent" && task.activeLaneAssignment.workerId) {
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
              lastError: outcome === "failure" ? notes ?? "Marked failed" : null,
              updatedAt,
            }
          : runtime,
      ),
    );
  }

  if (autoAssignment?.workerType === "agent" && autoAssignment.workerId) {
    saveStoredMockAgentQueue([
      ...getStoredMockAgentQueue(),
      {
        id: autoAssignment.id,
        projectId: CURRENT_PROJECT_ID,
        agentId: autoAssignment.workerId,
        status: "dispatched",
        sourceType: "workflow_lane",
        sourceTaskId: taskId,
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

  saveMockTasks(nextTasks);
  appendMockLog("info", "task.transition", `Completed task ${taskId} lane with ${outcome}`);
  emitMockTaskChange({ taskIds: [taskId], reason: `task.transition.${outcome}` });
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

export async function commentOnTask(taskId: string, input: TaskCommentInput): Promise<TaskComment> {
  if (!isTauriAvailable()) {
    const tasks = ensureMockTasks();
    const task = tasks.find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }

    const author = input.author.trim();
    const message = input.message.trim();
    if (!author) {
      throw new Error("author: Comment author is required.");
    }
    if (!message) {
      throw new Error("message: Comment message is required.");
    }

    const comment: TaskComment = {
      id: createId("task-comment"),
      taskId,
      author,
      message,
      interruptAgent: input.interruptAgent,
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
    emitMockTaskChange({
      taskIds: [taskId],
      reason: input.interruptAgent ? "task.comment.interrupt_requested" : "task.commented",
    });
    return comment;
  }

  return invoke<TaskComment>("comment_on_task", { taskId, input });
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
    emitMockTaskChange({ taskIds: [removedAttachment.taskId], reason: "task.attachment.removed" });
    return removedAttachment;
  }

  return invoke<TaskAttachment>("remove_task_attachment", { attachmentId });
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
