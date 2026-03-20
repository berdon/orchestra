import { invoke } from "@tauri-apps/api/core";
import type {
  AgentSummary,
  AppInfo,
  JsonValue,
  LogEntry,
  LogLevel,
  QueuedSessionMessage,
  RoleSummary,
  SessionEvent,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionStreamEnvelope,
  TaskDetail,
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
const AGENT_STORAGE_KEY = "orchestra.mock.agents";
const ROLE_STORAGE_KEY = "orchestra.mock.roles";
const CURRENT_PROJECT_ID = "orchestra";

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
  const existing = getStoredValue<SessionRecord[]>(SESSION_STORAGE_KEY);
  if (existing) {
    return existing;
  }

  const seeded = seedMockSessions();
  setStoredValue(SESSION_STORAGE_KEY, seeded);
  return seeded;
}

function getStoredMockAgents() {
  return getStoredValue<AgentSummary[]>(AGENT_STORAGE_KEY) ?? [];
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
  return getStoredValue<Record<string, SessionModel>>(SESSION_MODEL_STORAGE_KEY) ?? {};
}

function setMockSessionModels(models: Record<string, SessionModel>) {
  setStoredValue(SESSION_MODEL_STORAGE_KEY, models);
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
  setStoredValue(SESSION_STORAGE_KEY, sessions);
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

  return enrichMockTasks([
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
      parent: null,
      lineage: [],
      children: [],
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
      parent: null,
      lineage: [],
      children: [],
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
      status: "blocked",
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
      parent: null,
      lineage: [],
      children: [],
      createdAt: timestamp,
      updatedAt: timestamp,
      comments: [],
      laneRuns: [],
    },
  ]);
}

function ensureMockTasks() {
  const existing = getStoredValue<TaskDetail[]>(TASK_STORAGE_KEY);
  if (existing) {
    return enrichMockTasks(existing);
  }

  const seeded = seedMockTasks();
  setStoredValue(TASK_STORAGE_KEY, seeded);
  return seeded;
}

function saveMockTasks(tasks: TaskDetail[]) {
  setStoredValue(TASK_STORAGE_KEY, enrichMockTasks(tasks));
}

function summarizeTask(task: TaskDetail): TaskSummary {
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
    createdAt: task.createdAt,
    updatedAt: task.updatedAt,
  };
}

function enrichMockTasks(tasks: TaskDetail[]) {
  const byId = new Map(tasks.map((task) => [task.id, task]));

  return tasks
    .map((task) => {
      const lineage: TaskSummary[] = [];
      let currentParentId = task.parentTaskId ?? null;
      while (currentParentId) {
        const parentTask = byId.get(currentParentId);
        if (!parentTask) {
          break;
        }
        lineage.push(summarizeTask({ ...parentTask, parent: null, lineage: [], children: [] }));
        currentParentId = parentTask.parentTaskId ?? null;
      }
      lineage.reverse();

      const children = tasks
        .filter((candidate) => candidate.parentTaskId === task.id)
        .sort((left, right) => left.number.localeCompare(right.number))
        .map((child) => summarizeTask({ ...child, parent: null, lineage: [], children: [] }));

      return {
        ...task,
        parent: task.parentTaskId && byId.get(task.parentTaskId) ? summarizeTask({ ...(byId.get(task.parentTaskId) as TaskDetail), parent: null, lineage: [], children: [] }) : null,
        lineage,
        children,
        commentCount: task.comments.length,
        laneRunCount: task.laneRuns.length,
        childCount: children.length,
        completedChildCount: children.filter((child) => child.status === "completed").length,
        inProgressChildCount: children.filter((child) => child.status === "in_progress").length,
        blockedChildCount: children.filter((child) => child.status === "blocked").length,
      } satisfies TaskDetail;
    })
    .sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt));
}

function normalizeMockTaskInput(input: TaskUpsertInput, existingTask?: TaskDetail): TaskDetail {
  const timestamp = nowIso();
  const previousTasks = ensureMockTasks();
  const nextSequence = existingTask
    ? Number(existingTask.number.replace(/^ORC-/, "")) || previousTasks.length + 1
    : previousTasks.reduce((highest, task) => {
        const sequence = Number(task.number.replace(/^ORC-/, "")) || 0;
        return Math.max(highest, sequence);
      }, 0) + 1;

  return {
    id: existingTask?.id ?? createId("task"),
    projectId: existingTask?.projectId ?? CURRENT_PROJECT_ID,
    number: existingTask?.number ?? `ORC-${nextSequence}`,
    title: input.title.trim(),
    description: input.description?.trim() || null,
    type: input.type,
    status: input.status,
    priority: input.priority,
    workflowId: input.workflowId?.trim() || null,
    currentLaneId: input.currentLaneId?.trim() || null,
    assigneeType: input.assigneeType,
    assigneeId: input.assigneeId?.trim() || null,
    repositoryId: input.repositoryId?.trim() || null,
    parentTaskId: input.parentTaskId?.trim() || null,
    archived: input.archived ?? existingTask?.archived ?? false,
    commentCount: existingTask?.comments.length ?? 0,
    laneRunCount: existingTask?.laneRuns.length ?? 0,
    childCount: 0,
    completedChildCount: 0,
    inProgressChildCount: 0,
    blockedChildCount: 0,
    parent: null,
    lineage: [],
    children: [],
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
  if (!isTauriAvailable()) {
    return ensureMockTasks().filter((task) => includeArchived || !task.archived).map(summarizeTask);
  }

  return invoke<TaskSummary[]>("list_tasks", { includeArchived });
}

export async function getTask(taskId: string): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const task = ensureMockTasks().find((entry) => entry.id === taskId);
    if (!task) {
      throw new Error(`Task ${taskId} was not found`);
    }
    return task;
  }

  return invoke<TaskDetail>("get_task", { taskId });
}

export async function createTask(input: TaskUpsertInput): Promise<TaskDetail> {
  if (!isTauriAvailable()) {
    const validation = validateMockTaskInput(input);
    if (validation.length > 0) {
      throw new Error(validation.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const task = normalizeMockTaskInput(input);
    saveMockTasks([task, ...ensureMockTasks()].sort((left, right) => Date.parse(right.updatedAt) - Date.parse(left.updatedAt)));
    appendMockLog("info", "task.created", `Created task ${task.id}`);
    return task;
  }

  return invoke<TaskDetail>("create_task", { input });
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
    return updated;
  }

  return invoke<TaskDetail>("update_task", { taskId, input });
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
