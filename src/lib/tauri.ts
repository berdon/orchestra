import { invoke } from "@tauri-apps/api/core";
import type { AppInfo, LogEntry, LogLevel, SessionEvent, SessionRecord } from "../types";

const LOG_STORAGE_KEY = "orchestra.mock.logs";
const SESSION_STORAGE_KEY = "orchestra.mock.sessions";

function isTauriAvailable() {
  return Boolean((window as Window & { __TAURI_INTERNALS__?: unknown }).__TAURI_INTERNALS__);
}

function createId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
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
  return `Acknowledged: ${message}\n\nThis is the mock session layer. The UI flow for create, resume, subscribe, and interaction is wired and ready for the real pi-agent-core backend.`;
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

export async function sendSessionMessage(sessionId: string, message: string): Promise<SessionRecord> {
  if (!isTauriAvailable()) {
    const trimmedMessage = message.trim();
    if (!trimmedMessage) {
      throw new Error("Message cannot be empty");
    }

    const session = updateMockSession(sessionId, (current) => {
      const timestamp = nowIso();
      return {
        ...current,
        status: "active",
        updatedAt: timestamp,
        events: [
          ...current.events,
          createEvent("user", trimmedMessage),
          createEvent("assistant", generateAssistantReply(trimmedMessage)),
        ],
      };
    });

    if (!session) {
      throw new Error(`Unable to find session ${sessionId}`);
    }

    appendMockLog("info", "sessions.message", `Sent message to session ${session.id}`);
    return session;
  }

  return invoke<SessionRecord>("send_session_message", { sessionId, message });
}
