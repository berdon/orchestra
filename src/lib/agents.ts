import { invoke } from "@tauri-apps/api/core";

import { getActiveProjectId, getDefaultProjectId, getProjectRuntimeCwd } from "./projects";
import { dispatchAgentCatalogChanged } from "./agentCatalogEvents";
import { emitMockSessionChange } from "./mockOrchestra/events";
import { isTauriAvailable } from "./mockOrchestra/host";
import { getHostedWebOrchestraClientBinding } from "./orchestraClient/runtime";
import { createMockSessionRecord, upsertMockSession } from "./mockOrchestra/sessions";
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
  return getActiveProjectId() ?? getDefaultProjectId() ?? DEFAULT_PROJECT_ID;
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
    scope: agent.scope,
    projectId: agent.projectId ?? null,
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
  const compactionWindow = input.compactionWindow?.trim() || null;

  if (!name) {
    errors.push({ code: "required", path: "name", message: "Agent name is required." });
  }

  if (provider && !model) {
    errors.push({ code: "required", path: "model", message: "Select a model when a provider is configured." });
  }

  if (!provider && model) {
    errors.push({ code: "required", path: "provider", message: "Select a provider when a model is configured." });
  }

  if (input.scope === "project" && !(input.projectId?.trim() || activeProjectId())) {
    errors.push({ code: "required", path: "projectId", message: "Choose a project for project-scoped agents." });
  }

  if (compactionWindow && !(/^(?:[1-9]\d?|99)%$/.test(compactionWindow) || /^\d+$/.test(compactionWindow) || /^off$/i.test(compactionWindow))) {
    errors.push({ code: "invalid", path: "compactionWindow", message: "Compaction window must be `10%`, a positive token reserve like `16000`, or `off`." });
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
  const compactionWindow = input.compactionWindow?.trim() || null;
  const timestamp = nowIso();
  const existingAgents = ensureMockAgents();
  const baseSlug = slugifyAgentName(name);
  let slug = existing?.slug ?? baseSlug;
  let suffix = 2;

  while (existingAgents.some((agent) => agent.slug === slug && agent.id !== existing?.id)) {
    slug = `${baseSlug}-${suffix}`;
    suffix += 1;
  }

  const protectedAgent = Boolean(existing?.system || existing?.immutable || existing?.slug === "supervisor");
  const scope = input.scope === "project" && !protectedAgent ? "project" : "global";

  return {
    id: existing?.id ?? createId("agent"),
    slug,
    name,
    description,
    systemPrompt,
    provider,
    model,
    roleId: input.roleId ?? existing?.roleId ?? null,
    scope,
    projectId: scope === "project" ? input.projectId ?? existing?.projectId ?? activeProjectId() : null,
    thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel) ? thinkingLevel : "off",
    compactionWindow,
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
      scope: "global",
      projectId: null,
      thinkingLevel: "medium",
      compactionWindow: null,
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
      scope: "global",
      projectId: null,
      thinkingLevel: "medium",
      compactionWindow: null,
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
      scope: agent.system || agent.immutable || agent.slug === "supervisor" ? "global" : agent.scope ?? "global",
      projectId: agent.scope === "project" && !(agent.system || agent.immutable || agent.slug === "supervisor") ? agent.projectId ?? null : null,
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

function openMockAgentTerminalWindow(sessionId: string) {
  const url = new URL(window.location.href);
  url.searchParams.set("view", "agent-terminal");
  url.searchParams.set("sessionId", sessionId);
  const popup = window.open(url.toString(), `orchestra-agent-terminal-${sessionId}`, "popup=yes,width=1180,height=820,resizable=yes,scrollbars=yes");

  if (!popup) {
    return;
  }

  const detach = () => {
    const timestamp = nowIso();
    saveStoredSessions(
      getStoredSessions().map((session) =>
        session.id === sessionId ? { ...session, subscribed: true, terminalAttached: false, updatedAt: timestamp } : session,
      ),
    );
    saveStoredAgentRuntimes(
      getStoredAgentRuntimes().map((entry) =>
        entry.mainSessionId === sessionId ? { ...entry, terminalAttached: false, updatedAt: timestamp } : entry,
      ),
    );
    emitMockSessionChange({ sessionIds: [sessionId], reason: "sessions.terminal.detach" });
  };

  const intervalId = window.setInterval(() => {
    if (!popup.closed) {
      return;
    }
    window.clearInterval(intervalId);
    detach();
  }, 250);
}

function isAgentVisibleInProject(agent: Pick<AgentDefinition, "scope" | "projectId">, projectId?: string | null) {
  return agent.scope === "global" || (Boolean(projectId) && agent.projectId === projectId);
}

function effectiveMockRuntimeProjectId(agentId: string, projectId?: string | null) {
  const agent = ensureMockAgents().find((entry) => entry.id === agentId);
  if (agent?.scope === "global") {
    return DEFAULT_PROJECT_ID;
  }
  return projectId ?? activeProjectId();
}

function ensureMockAgentRuntime(agentId: string, projectId?: string | null) {
  const effectiveProjectId = effectiveMockRuntimeProjectId(agentId, projectId);
  const runtimes = getStoredAgentRuntimes();
  const existing = runtimes.find((runtime) => runtime.agentId === agentId && runtime.projectId === effectiveProjectId);
  if (existing) {
    return existing;
  }

  const globalMainSessionId = runtimes.find((runtime) => runtime.agentId === agentId && runtime.mainSessionId)?.mainSessionId ?? null;
  const created: AgentRuntimeState = {
    projectId: effectiveProjectId,
    agentId,
    status: "idle",
    mainSessionId: globalMainSessionId,
    runtimeCwd: getProjectRuntimeCwd(effectiveProjectId),
    currentQueueEntryId: null,
    lastDispatchAt: null,
    lastError: null,
    terminalAttached: false,
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

function getHostedWebClient() {
  return getHostedWebOrchestraClientBinding()?.client ?? null;
}

export async function listAgents(includeArchived = false, projectId?: string | null): Promise<AgentSummary[]> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.catalog.listAgents(includeArchived, projectId);
  }
  if (!isTauriAvailable()) {
    return ensureMockAgents()
      .filter((agent) => (includeArchived || !agent.archived) && isAgentVisibleInProject(agent, projectId ?? activeProjectId()))
      .map(summarizeAgent);
  }

  return invoke<AgentSummary[]>("list_agents", { includeArchived, projectId: projectId ?? null });
}

export async function getAgent(agentId: string, projectId?: string | null): Promise<AgentDefinition> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.getAgent(agentId, projectId);
  }
  if (!isTauriAvailable()) {
    const agent = ensureMockAgents().find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} was not found`);
    }
    if (!isAgentVisibleInProject(agent, projectId ?? activeProjectId())) {
      throw new Error(`Agent ${agentId} is not available in this project`);
    }
    return agent;
  }

  return invoke<AgentDefinition>("get_agent", { agentId });
}

export async function listAgentOperations(includeArchived = false, projectId?: string | null): Promise<AgentOperationsSnapshot[]> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.listAgentOperations(includeArchived, projectId);
  }
  if (!isTauriAvailable()) {
    return ensureMockAgents()
      .filter((agent) => (includeArchived || !agent.archived) && isAgentVisibleInProject(agent, projectId ?? activeProjectId()))
      .map((agent) => summarizeAgentOperations(agent));
  }

  return invoke<AgentOperationsSnapshot[]>("list_agent_operations", { includeArchived, projectId: projectId ?? null });
}

export async function getAgentOperations(agentId: string, projectId?: string | null): Promise<AgentOperationsDetail> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.getAgentOperations(agentId, projectId);
  }
  if (!isTauriAvailable()) {
    const agent = await getAgent(agentId, projectId);
    const snapshot = summarizeAgentOperations(agent);
    const queueEntries = getStoredAgentQueue().filter((entry) => entry.agentId === agentId);
    return {
      agent,
      runtimeState: snapshot.runtimeState,
      queueEntries,
    };
  }

  return invoke<AgentOperationsDetail>("get_agent_operations", { agentId, projectId: projectId ?? null });
}

export async function ensureAgentSession(agentId: string, projectId?: string | null): Promise<SessionRecord> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.ensureAgentSession(agentId, projectId);
  }
  if (!isTauriAvailable()) {
    const agent = await getAgent(agentId, projectId);
    const runtime = ensureMockAgentRuntime(agentId, projectId ?? activeProjectId());
    const existingSession = runtime.mainSessionId
      ? getStoredSessions().find((session) => session.id === runtime.mainSessionId) ?? null
      : null;

    const session: SessionRecord = existingSession
      ? { ...existingSession, subscribed: true, terminalAttached: runtime.terminalAttached ?? false, status: "active", updatedAt: nowIso() }
      : {
          ...createMockSessionRecord(
            `${agent.name} main session`,
            `${agent.name} is ready. This persistent session keeps the agent's context and can be reopened from anywhere in Orchestra.`,
          ),
          subscribed: true,
          terminalAttached: false,
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
        entry.agentId === agentId
          ? {
              ...entry,
              mainSessionId: session.id,
              runtimeCwd: entry.runtimeCwd ?? getProjectRuntimeCwd(entry.projectId),
              status: entry.currentQueueEntryId ? "running" : "idle",
              terminalAttached: entry.terminalAttached ?? false,
              updatedAt: nowIso(),
            }
          : entry,
      ),
    );

    emitMockSessionChange({ sessionIds: [session.id], reason: existingSession ? "sessions.ensure_agent.reused" : "sessions.ensure_agent.created" });
    return session;
  }

  return invoke<SessionRecord>("ensure_agent_session", { agentId, projectId: projectId ?? null });
}

export async function updateAgentMainSession(
  agentId: string,
  mainSessionId: string | null,
  projectId?: string | null,
): Promise<AgentRuntimeState> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.updateAgentMainSession(agentId, mainSessionId, projectId);
  }
  if (!isTauriAvailable()) {
    const runtime = ensureMockAgentRuntime(agentId, projectId ?? activeProjectId());
    const runtimes = getStoredAgentRuntimes();
    const updated = runtimes.map((entry) =>
      entry.agentId === agentId && entry.projectId === runtime.projectId
        ? { ...entry, mainSessionId: mainSessionId ?? entry.mainSessionId, updatedAt: nowIso() }
        : entry,
    );
    saveStoredAgentRuntimes(updated);
    const updatedEntry = updated.find((entry) => entry.agentId === agentId);
    if (!updatedEntry) {
      throw new Error(`Agent runtime state for ${agentId} was not found`);
    }
    return updatedEntry;
  }

  return invoke<AgentRuntimeState>("update_agent_main_session", {
    agentId,
    projectId: projectId ?? null,
    mainSessionId,
  });
}

export async function openAgentSessionInTerminal(agentId: string, projectId?: string | null): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const runtime = ensureMockAgentRuntime(agentId);
    if (runtime.status === "running" || runtime.currentQueueEntryId) {
      throw new Error("Only idle agent sessions can be opened in a terminal window.");
    }

    const session = await ensureAgentSession(agentId, projectId);
    const timestamp = nowIso();
    const nextSession: SessionRecord = { ...session, subscribed: false, terminalAttached: true, updatedAt: timestamp };
    upsertMockSession(nextSession);
    saveStoredAgentRuntimes(
      getStoredAgentRuntimes().map((entry) =>
        entry.agentId === agentId
          ? { ...entry, mainSessionId: session.id, terminalAttached: true, updatedAt: timestamp }
          : entry,
      ),
    );
    openMockAgentTerminalWindow(session.id);
    emitMockSessionChange({ sessionIds: [session.id], reason: "sessions.terminal.attach" });
    return nextSession;
  }

  return invoke<SessionRecord>("open_agent_session_terminal", { agentId, projectId: projectId ?? null });
}

export async function writeAgentTerminalInput(sessionId: string, data: string): Promise<void> {
  if (!isTauriAvailable()) {
    return;
  }

  await invoke("write_agent_terminal_input", { sessionId, data });
}

export async function resizeAgentTerminal(sessionId: string, cols: number, rows: number): Promise<void> {
  if (!isTauriAvailable()) {
    return;
  }

  await invoke("resize_agent_terminal", { sessionId, cols, rows });
}

export async function getAgentTerminalBuffer(sessionId: string): Promise<string> {
  if (!isTauriAvailable()) {
    return `Connected to ${sessionId}\r\nEmbedded mock terminal ready.\r\n`;
  }

  return invoke<string>("get_agent_terminal_buffer", { sessionId });
}

export async function shutdownAgentTerminalSession(sessionId: string): Promise<void> {
  if (!isTauriAvailable()) {
    const timestamp = nowIso();
    saveStoredSessions(
      getStoredSessions().map((session) =>
        session.id === sessionId ? { ...session, subscribed: true, terminalAttached: false, updatedAt: timestamp } : session,
      ),
    );
    saveStoredAgentRuntimes(
      getStoredAgentRuntimes().map((entry) =>
        entry.mainSessionId === sessionId ? { ...entry, terminalAttached: false, updatedAt: timestamp } : entry,
      ),
    );
    emitMockSessionChange({ sessionIds: [sessionId], reason: "sessions.terminal.detach" });
    return;
  }

  await invoke("shutdown_agent_terminal_session", { sessionId });
}

export async function enqueueAgentWork(input: AgentQueueEntryInput): Promise<AgentQueueEntry> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.enqueueAgentWork(input);
  }
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

export async function deleteAgentQueueEntry(queueEntryId: string): Promise<AgentQueueEntry> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.deleteAgentQueueEntry(queueEntryId);
  }
  if (!isTauriAvailable()) {
    const entries = getStoredAgentQueue();
    const entry = entries.find((current) => current.id === queueEntryId);
    if (!entry) {
      throw new Error(`Agent queue entry ${queueEntryId} was not found`);
    }
    if (entry.status !== "queued") {
      throw new Error(`Agent queue entry ${queueEntryId} is ${entry.status} and cannot be deleted unless it is queued`);
    }
    saveStoredAgentQueue(entries.filter((current) => current.id !== queueEntryId));
    return entry;
  }

  return invoke<AgentQueueEntry>("delete_agent_queue_entry", { queueEntryId });
}

export async function validateAgent(input: AgentUpsertInput): Promise<AgentValidationResult> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.validateAgent(input);
  }
  if (!isTauriAvailable()) {
    return buildMockAgentValidation(input);
  }

  return invoke<AgentValidationResult>("validate_agent", { input });
}

export async function createAgent(input: AgentUpsertInput): Promise<AgentDefinition> {
  let agent: AgentDefinition;
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    agent = await hostedWebClient.workers.createAgent(input);
  } else if (!isTauriAvailable()) {
    const validation = buildMockAgentValidation(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    agent = normalizeMockAgentInput(input);
    saveStoredAgents([agent, ...ensureMockAgents()]);
  } else {
    agent = await invoke<AgentDefinition>("create_agent", { input });
  }

  dispatchAgentCatalogChanged({ agentId: agent.id, projectId: agent.projectId ?? null, reason: "created" });
  return agent;
}

export async function updateAgent(agentId: string, input: AgentUpsertInput): Promise<AgentDefinition> {
  let updated: AgentDefinition;
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    updated = await hostedWebClient.workers.updateAgent(agentId, input);
  } else if (!isTauriAvailable()) {
    const validation = buildMockAgentValidation(input);
    if (!validation.valid) {
      throw new Error(validation.errors.map((error) => `${error.path}: ${error.message}`).join("; "));
    }

    const agents = ensureMockAgents();
    const existing = agents.find((agent) => agent.id === agentId);
    if (!existing) {
      throw new Error(`Agent ${agentId} was not found`);
    }

    updated = existing.immutable || existing.system
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
  } else {
    updated = await invoke<AgentDefinition>("update_agent", { agentId, input });
  }

  dispatchAgentCatalogChanged({ agentId: updated.id, projectId: updated.projectId ?? null, reason: "updated" });
  return updated;
}

export async function archiveAgent(agentId: string): Promise<AgentDefinition> {
  let archived: AgentDefinition;
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    archived = await hostedWebClient.workers.archiveAgent(agentId);
  } else if (!isTauriAvailable()) {
    const agents = ensureMockAgents();
    const existing = agents.find((agent) => agent.id === agentId);
    if (!existing) {
      throw new Error(`Agent ${agentId} was not found`);
    }

    if (existing.system || existing.immutable) {
      throw new Error(`Agent ${agentId} is protected and cannot be archived`);
    }

    archived = {
      ...existing,
      archived: true,
      updatedAt: nowIso(),
    };

    saveStoredAgents(agents.map((agent) => (agent.id === agentId ? archived : agent)));
  } else {
    archived = await invoke<AgentDefinition>("archive_agent", { agentId });
  }

  dispatchAgentCatalogChanged({ agentId: archived.id, projectId: archived.projectId ?? null, reason: "archived" });
  return archived;
}

export async function getAgentMemoryInfo(agentId: string): Promise<AgentMemoryInfo> {
  const hostedWebClient = getHostedWebClient();
  if (hostedWebClient) {
    return hostedWebClient.workers.getAgentMemoryInfo(agentId);
  }
  if (!isTauriAvailable()) {
    const agent = ensureMockAgents().find((entry) => entry.id === agentId);
    if (!agent) {
      throw new Error(`Agent ${agentId} was not found`);
    }
    return buildMockAgentMemoryInfo(agent);
  }

  return invoke<AgentMemoryInfo>("get_agent_memory_info", { agentId });
}
