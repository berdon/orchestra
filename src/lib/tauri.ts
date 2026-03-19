import { listen } from "@tauri-apps/api/event";
import { invoke } from "@tauri-apps/api/core";
import type {
  AppInfo,
  LogEntry,
  LogLevel,
  QueuedSessionMessage,
  SessionEvent,
  SessionModel,
  SessionModelState,
  SessionRecord,
  SessionStreamEvent,
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

const sessionStreamListeners = new Set<(event: SessionStreamEvent) => void>();

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

function emitMockSessionStream(event: SessionStreamEvent) {
  for (const listener of sessionStreamListeners) {
    listener(event);
  }
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
          assignedEntityId: "developer-role",
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

function ensureMockWorkflows() {
  const existing = getStoredValue<WorkflowDefinition[]>(WORKFLOW_STORAGE_KEY);
  if (existing) {
    return existing;
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
  handler: (event: SessionStreamEvent) => void,
): Promise<() => void> {
  if (!isTauriAvailable()) {
    sessionStreamListeners.add(handler);
    return () => {
      sessionStreamListeners.delete(handler);
    };
  }

  const unlisten = await listen<SessionStreamEvent>("session-stream", (event) => handler(event.payload));
  return unlisten;
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

  const { WebviewWindow } = await import("@tauri-apps/api/webviewWindow");
  const existing = await WebviewWindow.getByLabel("logs");
  if (existing) {
    await existing.show();
    await existing.setFocus();
    return;
  }

  const logsWindow = new WebviewWindow("logs", {
    title: "Orchestra Logs",
    url: logsUrl.toString(),
    width: 980,
    height: 760,
    resizable: true,
    focus: true,
  });

  logsWindow.once("tauri://error", (error) => {
    console.error("Unable to open Orchestra logs window", error);
  });
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
      events: [...current.events, createEvent("system", "Live subscription enabled for this session.")],
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
      events: [...current.events, createEvent("system", "Live subscription disabled for this session.")],
    }));

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.unsubscribe", `Unsubscribed from session ${session.id}`);
    return session;
  }

  return invoke<SessionRecord>("unsubscribe_session", { sessionId });
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

    window.setTimeout(() => {
      emitMockSessionStream({
        sessionId,
        runId,
        event: "thinking_start",
        timestamp: nowIso(),
      });

      window.setTimeout(() => {
        emitMockSessionStream({
          sessionId,
          runId,
          event: "text_start",
          timestamp: nowIso(),
        });
      }, 80);

      chunks.forEach((chunk, index) => {
        window.setTimeout(() => {
          emitMockSessionStream({
            sessionId,
            runId,
            event: "text_delta",
            delta: chunk,
          });
        }, 80 * (index + 2));
      });

      window.setTimeout(() => {
        emitMockSessionStream({
          sessionId,
          runId,
          event: "turn_end",
          timestamp: nowIso(),
          message: assistantReply,
        });

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
          emitMockSessionStream({
            sessionId,
            runId,
            event: "error",
            message: `Unable to find session ${sessionId}`,
          });
          return;
        }

        appendMockLog("info", "sessions.message", `Sent message to session ${session.id}`);
        emitMockSessionStream({
          sessionId,
          runId,
          event: "session_updated",
          record: session,
        });
      }, 80 * (chunks.length + 3));
    }, 120);

    return queued;
  }

  return invoke<QueuedSessionMessage>("send_session_message", { sessionId, message: trimmedMessage, runId });
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
