import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type {
  AgentDefinition,
  AgentMemoryInfo,
  AgentSummary,
  AgentUpsertInput,
  AgentValidationError,
  AgentValidationResult,
} from "../types";

const AGENT_STORAGE_KEY = "orchestra.mock.agents";

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

function summarizeAgent(agent: AgentDefinition): AgentSummary {
  return {
    id: agent.id,
    slug: agent.slug,
    name: agent.name,
    thinkingLevel: agent.thinkingLevel,
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
    thinkingLevel: ["off", "minimal", "low", "medium", "high", "xhigh"].includes(thinkingLevel) ? thinkingLevel : "off",
    archived: existing?.archived ?? false,
    createdAt: existing?.createdAt ?? timestamp,
    updatedAt: timestamp,
  };
}

function seedMockAgents(): AgentDefinition[] {
  const timestamp = nowIso();
  return [
    {
      id: createId("agent"),
      slug: "data",
      name: "Data",
      description: "Persistent collaborator for implementation and documentation work.",
      systemPrompt: "Keep context, preserve continuity, and move the project forward.",
      provider: "anthropic",
      model: "claude-sonnet-4-20250514",
      thinkingLevel: "medium",
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

    const updated = normalizeMockAgentInput(input, existing);
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
