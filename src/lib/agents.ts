import { invoke } from "@tauri-apps/api/core";

import { getActiveProjectId, getProjectRuntimeCwd } from "./projects";
import { createMockSessionRecord, emitMockSessionChange, isTauriAvailable, upsertMockSession } from "./tauri";
import type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentOperationsDetail,
  AgentOperationsSnapshot,
  AgentQueueEntry,
  AgentQueueEntryInput,
  AgentRuntimeState,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationError,
  AgentValidationResult,
  SessionModel,
  SessionRecord,
} from "../types";

const AGENT_STORAGE_KEY = "orchestra.mock.agents";
const AGENT_RUNTIME_STORAGE_KEY = "orchestra.mock.agent-runtimes";
const AGENT_QUEUE_STORAGE_KEY = "orchestra.mock.agent-queue";
const SESSION_STORAGE_KEY = "orchestra.mock.sessions";
const SESSION_MODEL_STORAGE_KEY = "orchestra.mock.session-models";
const DEFAULT_PROJECT_ID = "orchestra";

function activeProjectId() {
  return getActiveProjectId() ?? DEFAULT_PROJECT_ID;
}

function sessionStorageKey() {
  return `${SESSION_STORAGE_KEY}.${activeProjectId()}`;
}

function sessionModelStorageKey() {
  return `${SESSION_MODEL_STORAGE_KEY}.${activeProjectId()}`;
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function slugifyAgentName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "agent";
}

function getStoredAgents() {
  const value = window.localStorage.getItem(AGENT_STORAGE_KEY);
  return value ? (JSON.parse(value) as AgentDefinition[]) : null;
}

function saveStoredAgents(agents: AgentDefinition[]) {
  window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(agents));
}

function getStoredAgentRuntimes() {
  const value = window.localStorage.getItem(AGENT_RUNTIME_STORAGE_KEY);
  return value ? (JSON.parse(value) as AgentRuntimeState[]) : [];
}

function saveStoredAgentRuntimes(runtimes: AgentRuntimeState[]) {
  window.localStorage.setItem(AGENT_RUNTIME_STORAGE_KEY, JSON.stringify(runtimes));
}

function getStoredAgentQueue() {
  const value = window.localStorage.getItem(AGENT_QUEUE_STORAGE_KEY);
  return value ? (JSON.parse(value) as AgentQueueEntry[]) : [];
}

function saveStoredAgentQueue(entries: AgentQueueEntry[]) {
  window.localStorage.setItem(AGENT_QUEUE_STORAGE_KEY, JSON.stringify(entries));
}

function getStoredSessions() {
  const value = window.localStorage.getItem(sessionStorageKey());
  return value ? (JSON.parse(value) as SessionRecord[]) : [];
}

function saveStoredSessions(sessions: SessionRecord[]) {
  window.localStorage.setItem(sessionStorageKey(), JSON.stringify(sessions));
}

function getStoredSessionModels() {
  const value = window.localStorage.getItem(sessionModelStorageKey());
  return value ? (JSON.parse(value) as Record<string, SessionModel>) : {};
}

function saveStoredSessionModels(models: Record<string, SessionModel>) {
  window.localStorage.setItem(sessionModelStorageKey(), JSON.stringify(models));
}

function summarizeAgent(agent: AgentDefinition): AgentSummary {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    roleId: agent.roleId,
    thinkingLevel: agent.thinkingLevel,
    policyIds: agent.policyIds ?? [],
    directPermissions: agent.directPermissions ?? [],
    system: agent.system,
    immutable: agent.immutable,
    archived: agent.archived,
    createdAt: agent.createdAt,
    updatedAt: agent.updatedAt,
  };
}

function buildMockAgentValidation(input: AgentUpsertInput): AgentValidationResult {
  const errors: AgentValidationError[] = [];
  const name = input.name.trim();
  const provider = input.provider?.trim() || "";
  const model = input.model?.trim() || "";
  const thinkingLevel = input.thinkingLevel?.trim().toLowerCase() || "off";

  if (!name) {
    errors.push({ code: "required", path: "name", message: "Agent name is required." });
  }

  if (provider && !model) {
    errors.push({ code: "required", path: "model", message: "Select a model when a provider is configured." });
  }

  if (!provider && model) {
    errors.push({ code: "required", path: "provider", message: "Select a provider when a model is configured." });
  }

  if (!["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel)) {
    errors.push({ code: "invalid", path: "thinkingLevel", message: "Thinking level must be one of: off, minimal, low, medium, high, xhigh." });
  }

  return {
    valid: errors.length === 0,
    errors,
  };
}

function buildMockAgentMemoryInfo(agent: AgentDefinition): AgentMemoryInfo {
  const rootDir = `/mock/agents/${agent.slug}`;
  return {
    agentId: agent.id,
    slug: agent.slug,
    rootDir,
    agentsPath: `${rootDir}/AGENTS.md`,
    identityPath: `${rootDir}/IDENTITY.md`,
    soulPath: `${rootDir}/SOUL.md`,
    memoryPath: `${rootDir}/MEMORY.md`,
    toolsPath: `${rootDir}/TOOLS.md`,
    dailyMemoryDir: `${rootDir}/memory`,
  };
}

function normalizeMockAgentInput(input: AgentUpsertInput, existing?: AgentDefinition): AgentDefinition {
  const name = input.name.trim();
  const description = input.description?.trim() || null;
  const systemPrompt = input.systemPrompt?.trim() || null;
  const provider = input.provider?.trim() || null;
  const model = input.model?.trim() || null;
  const thinkingLevel = input.thinkingLevel?.trim().toLowerCase() || "off";
  const timestamp = nowIso();
  const existingAgents = ensureMockAgents();
  const baseSlug = slugifyAgentName(name);
  let slug = existing?.slug ?? baseSlug;
  let suffix = 2;

  while (existingAgents.some((agent) => agent.slug === slug && agent.id !== existing?.id)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  return {
    id: existing?.id ?? createId("agent"),
    slug,
    name,
    description,
    systemPrompt,
    provider,
    model,
    roleId: input.roleId ?? existing?.roleId ?? null,
    thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel) ? thinkingLevel : "off",
    policyIds: Array.from(new Set(input.policyIds ?? existing?.policyIds ?? [])).sort(),
    directPermissions: Array.from(new Set(input.directPermissions ?? existing?.directPermissions ?? [])).sort(),
    system: existing?.system ?? false,
    immutable: existing?.immutable ?? false,
    archived: existing?.archived ?? false,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function seedMockAgents(): AgentDefinition[] {
  const timestamp = nowIso();
  return [
    {
      id: "agent-supervisor",
      slug: "supervisor",
      name: "Supervisor",
      description: "Built-in protected Orchestra supervisor agent.",
      systemPrompt: "You are Orchestra's built-in supervisor agent. Orchestra is the source of truth for tasks, workflows, lanes, sessions, workers, policies, and runtime state. Explain Orchestra clearly, help users choose the right tools, and keep the system coherent.",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      roleId: null,
      thinkingLevel: "medium",
      policyIds: ["policy-supervisor"],
      directPermissions: [],
      system: true,
      immutable: true,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
    {
      id: createId("agent"),
      slug: "data",
      name: "Data",
      description: "Persistent collaborator for implementation and documentation work.",
      systemPrompt: "Keep context, preserve continuity, and move the project forward.",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      roleId: null,
      thinkingLevel: "medium",
      policyIds: [],
      directPermissions: [],
      system: false,
      immutable: false,
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function ensureMockAgents() {
  const existing = getStoredAgents();
  if (existing) {
    const migrated = existing.map((agent) => ({
      ...agent,
      slug: agent.slug || slugifyAgentName(agent.name),
      roleId: agent.roleId ?? null,
      policyIds: agent.policyIds ?? [],
      directPermissions: agent.directPermissions ?? [],
      system: agent.system ?? false,
      immutable: agent.immutable ?? false,
    }));

    if (JSON.stringify(migrated) !== JSON.stringify(existing)) {
      saveStoredAgents(migrated);
    }

    return migrated;
  }

  const seeded = seedMockAgents();
  saveStoredAgents(seeded);
  return seeded;
}

function ensureMockAgentRuntime(agentId: string) {
  const projectId = activeProjectId();
  const runtimes = getStoredAgentRuntimes();
  const existing = runtimes.find((runtime) => runtime.agentId === agentId && runtime.projectId === projectId);
  if (existing) {
    return existing;
  }

  const created: AgentRuntimeState = {
    projectId,
    agentId,
    status: "idle",
    mainSessionId: null,
    runtimeCwd: getProjectRuntimeCwd(projectId),
    currentQueueEntryId: null,
    lastDispatchAt: null,
    lastError: null,
    createdAt: nowIso(),
    updatedAt: nowIso(),
  };
  saveStoredAgentRuntimes([...runtimes, created]);
  return created;
}

function getStoredTaskAssignmentsForAgent(agent: AgentDefinition) {
  const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]") as Array<{
    activeLaneAssignment?: {
      workerType?: string;
      workerId?: string | null;
      sessionId?: string | null;
      runtimeCwd?: string | null;
      id?: string;
      updatedAt?: string;
      createdAt?: string;
    } | null;
  }>;
  return tasks
    .map((task) => task.activeLaneAssignment)
    .filter(
      (assignment): assignment is NonNullable<typeof assignment> =>
        Boolean(assignment && assignment.workerType === "agent" && [agent.id, agent.slug].includes(assignment.workerId ?? "")),
    );
}

function summarizeAgentOperations(agent: AgentDefinition): AgentOperationsSnapshot {
  const baseRuntime = ensureMockAgentRuntime(agent.id);
  const activeAssignments = getStoredTaskAssignmentsForAgent(agent);
  const latestAssignment = activeAssignments[0] ?? null;
  const runtimeState: AgentRuntimeState = latestAssignment
    ? {
        ...baseRuntime,
        status: "running",
        mainSessionId: latestAssignment.sessionId ?? baseRuntime.mainSessionId,
        runtimeCwd: latestAssignment.runtimeCwd ?? baseRuntime.runtimeCwd,
        currentQueueEntryId: latestAssignment.id ?? baseRuntime.currentQueueEntryId,
        updatedAt: latestAssignment.updatedAt ?? latestAssignment.createdAt ?? baseRuntime.updatedAt,
      }
    : baseRuntime;
  const queueEntries = getStoredAgentQueue().filter((entry) => entry.agentId === agent.id && ["queued", "dispatched"].includes(entry.status));
  return {
    agent,
    runtimeState,
    queuedCount: queueEntries.filter((entry) => entry.status === "queued").length,
    dispatchedCount: queueEntries.filter((entry) => entry.status === "dispatched").length,
  };
}

export async function listAgents(includeArchived = false): Promise<AgentSummary[]> {
  if (!isTauriAvailable()) {
    return ensureMockAgents().filter((agent) => includeArchived || !agent.archived).map(summarizeAgent);
  }

  return invoke<AgentSummary[]>("list_agents", { includeArchived });
}

export async function getAgent(agentId: string): Promise<AgentDefinition> {
  if (!isTauriAvailable()) {
    const agent = ensureMockAgents().find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} was not found`);
    }
    return agent;
  }

  return invoke<AgentDefinition>("get_agent", { agentId });
}

export async function listAgentOperations(includeArchived = false): Promise<AgentOperationsSnapshot[]> {
  if (!isTauriAvailable()) {
    return ensureMockAgents()
      .filter((agent) => includeArchived || !agent.archived)
      .map((agent) => summarizeAgentOperations(agent));
  }

  return invoke<AgentOperationsSnapshot[]>("list_agent_operations", { includeArchived });
}

export async function getAgentOperations(agentId: string): Promise<AgentOperationsDetail> {
  if (!isTauriAvailable()) {
    const agent = await getAgent(agentId);
    const snapshot = summarizeAgentOperations(agent);
    const queueEntries = getStoredAgentQueue().filter((entry) => entry.agentId === agentId);
    return {
      agent,
      runtimeState: snapshot.runtimeState,
      queueEntries,
    };
  }

  return invoke<AgentOperationsDetail>("get_agent_operations", { agentId });
}

export async function ensureAgentSession(agentId: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const agent = await getAgent(agentId);
    const runtime = ensureMockAgentRuntime(agentId);
    const existingSession = runtime.mainSessionId
      ? getStoredSessions().find((session) => session.id === runtime.mainSessionId) ?? null
      : null;

    const session: SessionRecord = existingSession
      ? { ...existingSession, subscribed: true, status: "active", updatedAt: nowIso() }
      : {
          ...createMockSessionRecord(
            `${agent.name} main session`,
            `${agent.name} is ready. This persistent session keeps the agent's context and can be reopened from anywhere in Orchestra.`,
          ),
          subscribed: true,
        };

    upsertMockSession(session);

    if (agent.provider && agent.model) {
      const models = getStoredSessionModels();
      models[session.id] = {
        id: agent.model,
        name: agent.model,
        provider: agent.provider,
        api: agent.provider,
        reasoning: true,
      };
      saveStoredSessionModels(models);
    }

    saveStoredAgentRuntimes(
      getStoredAgentRuntimes().map((entry) =>
        entry.agentId === agentId && entry.projectId === activeProjectId()
          ? {
              ...entry,
              mainSessionId: session.id,
              runtimeCwd: entry.runtimeCwd ?? getProjectRuntimeCwd(activeProjectId()),
              status: entry.currentQueueEntryId ? "running" : "idle",
              updatedAt: nowIso(),
            }
          : entry,
      ),
    );

    emitMockSessionChange({ sessionIds: [session.id], reason: existingSession ? "sessions.ensure_agent.reused" : "sessions.ensure_agent.created" });
    return session;
  }

  return invoke<SessionRecord>("ensure_agent_session", { agentId });
}

export async function enqueueAgentWork(input: AgentQueueEntryInput): Promise<AgentQueueEntry> {
  if (!isTauriAvailable()) {
    const normalized: AgentQueueEntry = {
      id: createId("agent-queue"),
      projectId: activeProjectId(),
      agentId: input.agentId,
      status: "queued",
      sourceType: input.sourceType,
      sourceTaskId: input.sourceTaskId ?? null,
      sourceWorkflowId: input.sourceWorkflowId ?? null,
      sourceLaneId: input.sourceLaneId ?? null,
      deliveryMode: input.deliveryMode,
      title: input.title,
      message: input.message,
      sessionId: null,
      runId: null,
      dispatchedAt: null,
      completedAt: null,
      createdAt: nowIso(),
      updatedAt: nowIso(),
    };
    saveStoredAgentQueue([...getStoredAgentQueue(), normalized]);
    ensureMockAgentRuntime(input.agentId);
    return normalized;
  }

  return invoke<AgentQueueEntry>("enqueue_agent_work", { input });
}

export async function validateAgent(input: AgentUpsertInput): Promise<AgentValidationResult> {
  if (!isTauriAvailable()) {
    return buildMockAgentValidation(input);
  }

  return invoke<AgentValidationResult>("validate_agent", { input });
}

export async function createAgent(input: AgentUpsertInput): Promise<AgentDefinition> {
  if (!isTauriAvailable()) {
    const validation = buildMockAgentValidation(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const agent = normalizeMockAgentInput(input);
    saveStoredAgents([agent, ...ensureMockAgents()]);
    return agent;
  }

  return invoke<AgentDefinition>("create_agent", { input });
}

export async function updateAgent(agentId: string, input: AgentUpsertInput): Promise<AgentDefinition> {
  if (!isTauriAvailable()) {
    const validation = buildMockAgentValidation(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const agents = ensureMockAgents();
    const existing = agents.find((agent) => agent.id === agentId);
    if (!existing) {
      throw new Error(`Agent ${agentId} was not found`);
    }

    const updated = existing.immutable || existing.system
      ? {
          ...existing,
          provider: input.provider?.trim() || null,
          model: input.model?.trim() || null,
          thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"].includes(input.thinkingLevel?.trim().toLowerCase() || "")
            ? input.thinkingLevel!.trim().toLowerCase()
            : existing.thinkingLevel,
          updatedAt: nowIso(),
        }
      : normalizeMockAgentInput(input, existing);
    saveStoredAgents(agents.map((agent) => (agent.id === agentId ? updated : agent)));
    return updated;
  }

  return invoke<AgentDefinition>("update_agent", { agentId, input });
}

export async function archiveAgent(agentId: string): Promise<AgentDefinition> {
  if (!isTauriAvailable()) {
    const agents = ensureMockAgents();
    const existing = agents.find((agent) => agent.id === agentId);
    if (!existing) {
      throw new Error(`Agent ${agentId} was not found`);
    }

    if (existing.system || existing.immutable) {
      throw new Error(`Agent ${agentId} is protected and cannot be archived`);
    }

    const archived: AgentDefinition = {
      ...existing,
      archived: true,
      updatedAt: nowIso(),
    };

    saveStoredAgents(agents.map((agent) => (agent.id === agentId ? archived : agent)));
    return archived;
  }

  return invoke<AgentDefinition>("archive_agent", { agentId });
}

export async function getAgentMemoryInfo(agentId: string): Promise<AgentMemoryInfo> {
  if (!isTauriAvailable()) {
    const agent = ensureMockAgents().find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} was not found`);
    }
    return buildMockAgentMemoryInfo(agent);
  }

  return invoke<AgentMemoryInfo>("get_agent_memory_info", { agentId });
}
