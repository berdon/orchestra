import { buildSeededMockProjects } from "../defaultInstallBaseline";
import { getActiveProjectId } from "../projects";
import { sortSessionRecords } from "../sessionList";
import type { SessionEvent, SessionRecord } from "../../types";

const SESSION_STORAGE_KEY = "orchestra.mock.sessions";
const PROJECT_STORAGE_KEY = "orchestra.mock.projects";
const NO_PROJECT_STORAGE_KEY = "no-project";

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
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

function getStoredMockProjectsForSettings() {
  const value = window.localStorage.getItem(PROJECT_STORAGE_KEY);
  return value
    ? (JSON.parse(value) as Array<{ id: string; slug: string }>)
    : buildSeededMockProjects().map((project) => ({ id: project.id, slug: project.slug }));
}

function resolveCurrentMockProjectId(preferredProjectId?: string | null) {
  const projects = getStoredMockProjectsForSettings();
  if (preferredProjectId && projects.some((project) => project.id === preferredProjectId)) {
    return preferredProjectId;
  }
  return projects[0]?.id ?? null;
}

function sessionStorageKey(projectId?: string | null) {
  return `${SESSION_STORAGE_KEY}.${resolveCurrentMockProjectId(projectId ?? getActiveProjectId()) ?? NO_PROJECT_STORAGE_KEY}`;
}

function getStoredMockSessions(projectId?: string | null) {
  const value = window.localStorage.getItem(sessionStorageKey(projectId));
  return value ? (JSON.parse(value) as SessionRecord[]) : [];
}

function saveMockSessions(sessions: SessionRecord[], projectId?: string | null) {
  window.localStorage.setItem(sessionStorageKey(projectId), JSON.stringify(sessions));
}

export function upsertMockSession(session: SessionRecord, projectId?: string | null) {
  const sessions = getStoredMockSessions(projectId).filter((entry) => entry.id !== session.id);
  saveMockSessions(sortSessionRecords([session, ...sessions]), projectId);
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
    controlCapabilities: {
      reload: { status: "supported", reason: null },
      compact: { status: "supported", reason: null },
      autoCompact: { status: "supported", reason: null },
      effectiveCompactionWindow: "10%",
      effectiveCompactionWindowSource: "global",
    },
    controlOperation: null,
  };
}
