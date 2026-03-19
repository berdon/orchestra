import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type { AgentSummary } from "../types";

const AGENT_STORAGE_KEY = "orchestra.mock.agents";

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function getStoredAgents() {
  const value = window.localStorage.getItem(AGENT_STORAGE_KEY);
  return value ? (JSON.parse(value) as AgentSummary[]) : null;
}

function saveStoredAgents(agents: AgentSummary[]) {
  window.localStorage.setItem(AGENT_STORAGE_KEY, JSON.stringify(agents));
}

function seedMockAgents(): AgentSummary[] {
  const timestamp = nowIso();
  return [
    {
      id: createId("agent"),
      slug: "data",
      name: "Data",
      thinkingLevel: "medium",
      archived: false,
      createdAt: timestamp,
      updatedAt: timestamp,
    },
  ];
}

function slugifyAgentName(value: string) {
  const normalized = value
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");

  return normalized || "agent";
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
    return ensureMockAgents().filter((agent) => includeArchived || !agent.archived);
  }

  return invoke<AgentSummary[]>("list_agents", { includeArchived });
}
