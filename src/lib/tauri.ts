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
} from "../types";

const LOG_STORAGE_KEY = "orchestra.mock.logs";
const SESSION_STORAGE_KEY = "orchestra.mock.sessions";
const SESSION_MODEL_STORAGE_KEY = "orchestra.mock.session-models";

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
        event: "assistantStart",
        timestamp: nowIso(),
      });

      chunks.forEach((chunk, index) => {
        window.setTimeout(() => {
          emitMockSessionStream({
            sessionId,
            runId,
            event: "assistantDelta",
            delta: chunk,
          });
        }, 80 * (index + 1));
      });

      window.setTimeout(() => {
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
          event: "sessionUpdated",
          record: session,
        });
      }, 80 * (chunks.length + 2));
    }, 120);

    return queued;
  }

  return invoke<QueuedSessionMessage>("send_session_message", { sessionId, message: trimmedMessage, runId });
}
