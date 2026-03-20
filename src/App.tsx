import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  clearLogs,
  createSession,
  deleteSession,
  getAppInfo,
  getLogs,
  getSessionModelState,
  isCurrentLogsWindow,
  listSessions,
  listenToSessionStream,
  openLogsWindow,
  sendSessionMessage,
  setSessionModel,
  subscribeSession,
  unsubscribeSession,
} from "./lib/tauri";
import { getActiveProjectId, listProjects, setActiveProjectId } from "./lib/projects";
import { AgentsPage } from "./agents/AgentsPage";
import { RuntimeLogPanel } from "./components/RuntimeLogPanel";
import { SessionsPage } from "./pages/SessionsPage";
import { TasksPage } from "./pages/TasksPage";
import { AgentsPanel } from "./settings/AgentsPanel";
import { ProjectsPanel } from "./settings/ProjectsPanel";
import { RolesPanel } from "./settings/RolesPanel";
import { WorkflowsPanel } from "./settings/WorkflowsPanel";
import type {
  AppInfo,
  JsonValue,
  LogEntry,
  PrimaryPage,
  ProjectSummary,
  SessionEvent,
  SessionModelState,
  SessionRecord,
  SessionStatus,
  SessionStreamEnvelope,
} from "./types";

const NAV_ITEMS: Array<{ id: PrimaryPage; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

const SETTINGS_TABS = [
  { id: "projects", label: "Projects" },
  { id: "agents", label: "Agents" },
  { id: "roles", label: "Roles" },
  { id: "workflows", label: "Workflows" },
  { id: "logs", label: "Logs" },
] as const;

type SettingsTab = (typeof SETTINGS_TABS)[number]["id"];

interface PendingSessionRun {
  runId: string;
  userEvent: SessionEvent;
  assistantEvent?: SessionEvent;
}

function buildPendingAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: `pending-assistant-${runId}`,
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    runId,
    ...overrides,
  };
}

function createClientId(prefix: string) {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}-${Date.now().toString(36)}`;
}

function nowIso() {
  return new Date().toISOString();
}

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatDateTime(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function getStatusTone(status: SessionStatus) {
  switch (status) {
    case "active":
    case "streaming":
      return "success";
    case "paused":
      return "warning";
    case "failed":
      return "error";
    default:
      return "neutral";
  }
}

function getEventTone(kind: SessionEvent["kind"]) {
  switch (kind) {
    case "assistant":
      return "assistant";
    case "user":
      return "user";
    default:
      return "system";
  }
}

function formatModelOptionLabel(modelState: SessionModelState | undefined) {
  if (!modelState) {
    return "Loading models…";
  }

  if (modelState.currentModel) {
    return `${modelState.currentModel.name} · ${modelState.currentModel.provider}`;
  }

  return "Choose a model";
}

function isObject(value: JsonValue | undefined | null): value is Record<string, JsonValue> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asArray(value: JsonValue | undefined | null) {
  return Array.isArray(value) ? value : [];
}

function asString(value: JsonValue | undefined | null) {
  return typeof value === "string" ? value : "";
}

function extractRpcMessageText(message: JsonValue | undefined | null) {
  if (!isObject(message)) {
    return "";
  }

  return asArray(message.content)
    .map((block) => {
      if (!isObject(block)) {
        return "";
      }

      if (asString(block.type) === "text") {
        return asString(block.text);
      }

      if (asString(block.type) === "thinking") {
        return asString(block.thinking);
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n");
}

function getRpcEventType(envelope: SessionStreamEnvelope) {
  return isObject(envelope.event) ? asString(envelope.event.type) : "";
}

function getRpcAssistantDeltaType(envelope: SessionStreamEnvelope) {
  if (!isObject(envelope.event)) {
    return "";
  }

  const delta = envelope.event.assistantMessageEvent;
  return isObject(delta) ? asString(delta.type) : "";
}

function buildTranscriptEvent(kind: SessionEvent["kind"], message: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: createClientId(`event-${kind}`),
    kind,
    message,
    timestamp,
    ...overrides,
  };
}

function buildToolPlaceholder(runId: string, timestamp: string) {
  return buildPendingAssistantEvent(runId, timestamp, {
    message: "Running tools…",
    thinking: false,
  });
}

function buildStreamAssistantEvent(runId: string, timestamp: string, overrides?: Partial<SessionEvent>): SessionEvent {
  return {
    id: createClientId(`stream-assistant-${runId}`),
    kind: "assistant",
    message: "",
    timestamp,
    pending: true,
    thinking: false,
    runId,
    ...overrides,
  };
}

function hasVisibleAssistantText(event?: SessionEvent) {
  return Boolean(event?.message.trim() && event.message.trim() !== "Running tools…");
}

export function App() {
  const [activePage, setActivePage] = useState<PrimaryPage>("sessions");
  const [settingsTab, setSettingsTab] = useState<SettingsTab>("projects");
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [activeProjectId, setActiveProjectIdState] = useState<string | null>(getActiveProjectId());
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [clearingLogs, setClearingLogs] = useState(false);
  const [isLogsWindow, setIsLogsWindow] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [draftMessage, setDraftMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, PendingSessionRun>>({});
  const [modelStates, setModelStates] = useState<Record<string, SessionModelState>>({});
  const [loadingModelSessionId, setLoadingModelSessionId] = useState<string | null>(null);
  const [changingModelSessionId, setChangingModelSessionId] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const viewedSessionIdRef = useRef<string | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? projects[0] ?? null,
    [activeProjectId, projects],
  );

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null,
    [selectedSessionId, sessions],
  );

  const selectedSessionPendingRun = selectedSession ? pendingRuns[selectedSession.id] : undefined;
  const selectedModelState = selectedSession ? modelStates[selectedSession.id] : undefined;
  const displayedEvents = selectedSession?.events ?? [];

  const mergeSessionRecord = useCallback((updatedSession: SessionRecord, options?: { select?: boolean }) => {
    setSessions((current) => {
      const withoutOld = current.filter((session) => session.id !== updatedSession.id);
      return [updatedSession, ...withoutOld].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    });

    if (options?.select !== false) {
      setSelectedSessionId(updatedSession.id);
    }
  }, []);

  const applySessionUpdate = useCallback((updatedSession: SessionRecord) => {
    mergeSessionRecord(updatedSession);
  }, [mergeSessionRecord]);

  const removePendingRun = useCallback((sessionId: string, runId?: string) => {
    setPendingRuns((current) => {
      const existing = current[sessionId];
      if (!existing || (runId && existing.runId !== runId)) {
        return current;
      }

      const next = { ...current };
      delete next[sessionId];
      return next;
    });
  }, []);

  const patchSessionRecord = useCallback((sessionId: string, patch: (session: SessionRecord) => SessionRecord) => {
    setSessions((current) => current.map((session) => (session.id === sessionId ? patch(session) : session)));
  }, []);

  const patchStreamingAssistantEvent = useCallback(
    (sessionId: string, runId: string, timestamp: string, patch: (event: SessionEvent) => SessionEvent) => {
      patchSessionRecord(sessionId, (session) => {
        const existingIndex = session.events.findIndex((event) => event.runId === runId && event.kind === "assistant");
        const baseEvent = existingIndex >= 0 ? session.events[existingIndex]! : buildStreamAssistantEvent(runId, timestamp);
        const nextEvent = patch(baseEvent);
        const nextEvents = existingIndex >= 0
          ? session.events.map((event, index) => (index === existingIndex ? nextEvent : event))
          : [...session.events, nextEvent];
        return {
          ...session,
          status: "streaming",
          updatedAt: timestamp,
          events: nextEvents,
        };
      });
    },
    [patchSessionRecord],
  );

  const updatePendingRun = useCallback((sessionId: string, updater: (run: PendingSessionRun) => PendingSessionRun) => {
    let nextRun: PendingSessionRun | undefined;

    setPendingRuns((current) => {
      const existing = current[sessionId];
      if (!existing) {
        return current;
      }

      const updatedRun = updater(existing);
      nextRun = updatedRun;
      return {
        ...current,
        [sessionId]: updatedRun,
      };
    });

    if (!nextRun) {
      return;
    }

    const resolvedRun = nextRun;
    patchSessionRecord(sessionId, (session) => {
      const persistedEvents = session.events.filter((event) => event.runId !== resolvedRun.runId);
      return {
        ...session,
        status: "streaming",
        updatedAt: resolvedRun.userEvent.timestamp,
        events: [
          ...persistedEvents,
          resolvedRun.userEvent,
          ...(resolvedRun.assistantEvent ? [resolvedRun.assistantEvent] : []),
        ],
      };
    });
  }, [patchSessionRecord]);

  async function loadLogs() {
    setLoadingLogs(true);
    try {
      setLogs(await getLogs());
    } finally {
      setLoadingLogs(false);
    }
  }

  async function handleClearLogs() {
    setClearingLogs(true);
    try {
      await clearLogs();
      setLogs([]);
    } finally {
      setClearingLogs(false);
    }
  }

  async function handleOpenLogsWindow() {
    await openLogsWindow();
  }

  async function loadSessions() {
    setLoadingSessions(true);
    setSessionActionError(null);

    try {
      const nextSessions = await listSessions();
      setSessions(nextSessions);
      setSelectedSessionId((current) => {
        if (current && nextSessions.some((session) => session.id === current)) {
          return current;
        }

        return nextSessions[0]?.id ?? null;
      });
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to load sessions.");
    } finally {
      setLoadingSessions(false);
    }
  }

  async function runSessionAction(action: () => Promise<SessionRecord>) {
    setIsSubmitting(true);
    setSessionActionError(null);

    try {
      const updatedSession = await action();
      applySessionUpdate(updatedSession);
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Session action failed.");
    } finally {
      setIsSubmitting(false);
    }
  }

  async function handleDeleteSession(sessionId: string) {
    setSessionActionError(null);
    setIsSubmitting(true);

    try {
      await deleteSession(sessionId);
      setPendingRuns((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      setModelStates((current) => {
        const next = { ...current };
        delete next[sessionId];
        return next;
      });
      await loadSessions();
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to delete session.");
    } finally {
      setIsSubmitting(false);
    }
  }

  const handleSessionStreamEvent = useCallback(
    (payload: SessionStreamEnvelope) => {
      const eventType = getRpcEventType(payload);
      const eventTimestamp = payload.receivedAt ?? nowIso();
      const runId = payload.runId ?? createClientId("run");

      if (eventType === "agent_start") {
        patchSessionRecord(payload.sessionId, (session) => ({
          ...session,
          status: "streaming",
          updatedAt: eventTimestamp,
        }));
        return;
      }

      if (eventType === "message_start") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const message = rpcEvent?.message;
        const role = isObject(message) ? asString(message.role) : "";

        if (role === "user") {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            userEvent: {
              ...current.userEvent,
              pending: false,
              timestamp: eventTimestamp,
            },
          }));
          return;
        }

        if (role === "assistant") {
          if (pendingRuns[payload.sessionId]) {
            updatePendingRun(payload.sessionId, (current) => ({
              ...current,
              userEvent: {
                ...current.userEvent,
                pending: false,
              },
              assistantEvent: current.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp),
            }));
          } else {
            patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
              ...event,
              pending: true,
              thinking: false,
              timestamp: eventTimestamp,
            }));
          }
        }
        return;
      }

      if (eventType === "message_update") {
        const deltaType = getRpcAssistantDeltaType(payload);
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const message = rpcEvent?.message;
        const delta = isObject(rpcEvent?.assistantMessageEvent) ? rpcEvent?.assistantMessageEvent : null;

        switch (deltaType) {
          case "thinking_start":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                userEvent: {
                  ...current.userEvent,
                  pending: false,
                },
                assistantEvent: current.assistantEvent
                  ? {
                      ...current.assistantEvent,
                      pending: true,
                      thinking: true,
                      timestamp: eventTimestamp,
                    }
                  : buildPendingAssistantEvent(runId, eventTimestamp, { thinking: true }),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                pending: true,
                thinking: true,
                timestamp: eventTimestamp,
              }));
            }
            return;
          case "thinking_end":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                assistantEvent: current.assistantEvent
                  ? {
                      ...current.assistantEvent,
                      thinking: false,
                      pending: true,
                    }
                  : buildPendingAssistantEvent(runId, eventTimestamp),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                thinking: false,
                pending: true,
              }));
            }
            return;
          case "text_start":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                userEvent: {
                  ...current.userEvent,
                  pending: false,
                },
                assistantEvent: current.assistantEvent
                  ? {
                      ...current.assistantEvent,
                      pending: true,
                      thinking: false,
                      message: hasVisibleAssistantText(current.assistantEvent) ? current.assistantEvent.message : "",
                    }
                  : buildPendingAssistantEvent(runId, eventTimestamp),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                pending: true,
                thinking: false,
                message: hasVisibleAssistantText(event) ? event.message : "",
              }));
            }
            return;
          case "text_delta":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => {
                const base = current.assistantEvent ?? buildPendingAssistantEvent(runId, eventTimestamp);
                const chunk = delta ? asString(delta.delta) : "";
                const nextMessage = hasVisibleAssistantText(base) ? `${base.message}${chunk}` : chunk;
                return {
                  ...current,
                  userEvent: {
                    ...current.userEvent,
                    pending: false,
                  },
                  assistantEvent: {
                    ...base,
                    message: nextMessage,
                    pending: true,
                    thinking: false,
                  },
                };
              });
            } else {
              const chunk = delta ? asString(delta.delta) : "";
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                message: hasVisibleAssistantText(event) ? `${event.message}${chunk}` : chunk,
                pending: true,
                thinking: false,
              }));
            }
            return;
          case "toolcall_start":
          case "toolcall_delta":
          case "toolcall_end":
            if (pendingRuns[payload.sessionId]) {
              updatePendingRun(payload.sessionId, (current) => ({
                ...current,
                userEvent: {
                  ...current.userEvent,
                  pending: false,
                },
                assistantEvent: current.assistantEvent ?? buildToolPlaceholder(runId, eventTimestamp),
              }));
            } else {
              patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
                ...event,
                message: event.message || "Running tools…",
                pending: true,
                thinking: false,
              }));
            }
            return;
          case "error":
            patchSessionRecord(payload.sessionId, (session) => ({
              ...session,
              status: "failed",
              updatedAt: eventTimestamp,
              events: session.events.filter((event) => event.runId !== runId),
            }));
            removePendingRun(payload.sessionId, runId);
            setSessionActionError(asString(delta?.message) || extractRpcMessageText(message) || "Session action failed.");
            return;
          default:
            return;
        }
      }

      if (eventType === "tool_execution_start" || eventType === "tool_execution_update" || eventType === "tool_execution_end") {
        if (pendingRuns[payload.sessionId]) {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            userEvent: {
              ...current.userEvent,
              pending: false,
            },
            assistantEvent: current.assistantEvent ?? buildToolPlaceholder(runId, eventTimestamp),
          }));
        } else {
          patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
            ...event,
            message: event.message || "Running tools…",
            pending: true,
            thinking: false,
          }));
        }
        return;
      }

      if (eventType === "turn_end") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        const finalMessage = extractRpcMessageText(rpcEvent?.message);
        if (!finalMessage.trim()) {
          return;
        }

        if (pendingRuns[payload.sessionId]) {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            userEvent: {
              ...current.userEvent,
              pending: false,
            },
            assistantEvent: current.assistantEvent
              ? {
                  ...current.assistantEvent,
                  message: finalMessage,
                  pending: false,
                  thinking: false,
                  timestamp: eventTimestamp,
                }
              : buildPendingAssistantEvent(runId, eventTimestamp, {
                  message: finalMessage,
                  pending: false,
                  thinking: false,
                }),
          }));
        } else {
          patchStreamingAssistantEvent(payload.sessionId, runId, eventTimestamp, (event) => ({
            ...event,
            message: finalMessage,
            pending: false,
            thinking: false,
            timestamp: eventTimestamp,
          }));
        }
        return;
      }

      if (eventType === "agent_end") {
        void subscribeSession(payload.sessionId)
          .then((record) => {
            applySessionUpdate(record);
            removePendingRun(payload.sessionId, runId);
          })
          .catch((error) => {
            removePendingRun(payload.sessionId, runId);
            setSessionActionError(error instanceof Error ? error.message : "Unable to refresh session.");
          });
        return;
      }

      if (eventType === "error") {
        const rpcEvent = isObject(payload.event) ? payload.event : null;
        patchSessionRecord(payload.sessionId, (session) => ({
          ...session,
          status: "failed",
          updatedAt: eventTimestamp,
          events: session.events.filter((event) => event.runId !== runId),
        }));
        removePendingRun(payload.sessionId, runId);
        setSessionActionError(asString(rpcEvent?.message) || "Session action failed.");
      }
    },
    [applySessionUpdate, patchSessionRecord, patchStreamingAssistantEvent, pendingRuns, removePendingRun, updatePendingRun],
  );

  useEffect(() => {
    const loadProjectCatalog = () => {
      void listProjects().then((nextProjects) => {
        setProjects(nextProjects);
        setActiveProjectIdState((current) => {
          if (current && nextProjects.some((project) => project.id === current)) {
            return current;
          }
          const fallback = nextProjects[0]?.id ?? null;
          if (fallback) {
            setActiveProjectId(fallback);
          }
          return fallback;
        });
      });
    };

    void getAppInfo().then(setAppInfo);
    void isCurrentLogsWindow().then(setIsLogsWindow);
    loadProjectCatalog();
    const onProjectsChanged = () => loadProjectCatalog();
    window.addEventListener("orchestra:projects-changed", onProjectsChanged);
    return () => window.removeEventListener("orchestra:projects-changed", onProjectsChanged);
  }, []);

  useEffect(() => {
    if (activeProjectId) {
      setActiveProjectId(activeProjectId);
    }
  }, [activeProjectId]);

  useEffect(() => {
    if (isLogsWindow) {
      return;
    }

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    void listenToSessionStream(handleSessionStreamEvent).then((dispose) => {
      if (cancelled) {
        void dispose();
        return;
      }
      unlisten = dispose;
    });

    return () => {
      cancelled = true;
      unlisten?.();
    };
  }, [handleSessionStreamEvent, isLogsWindow]);

  useEffect(() => {
    if (isLogsWindow) {
      void loadLogs();
      const intervalId = window.setInterval(() => {
        void loadLogs();
      }, 1000);
      return () => {
        window.clearInterval(intervalId);
      };
    }

    if (activePage === "sessions") {
      void loadSessions();
    }
  }, [activePage, isLogsWindow]);

  useEffect(() => {
    if (isLogsWindow) {
      return;
    }

    const previousViewedSessionId = viewedSessionIdRef.current;
    const nextViewedSessionId = activePage === "sessions" ? selectedSession?.id ?? null : null;

    viewedSessionIdRef.current = nextViewedSessionId;

    if (previousViewedSessionId && previousViewedSessionId !== nextViewedSessionId) {
      void unsubscribeSession(previousViewedSessionId)
        .then((record) => {
          mergeSessionRecord(record, { select: false });
        })
        .catch(() => {
          // Ignore auto-unsubscribe failures; explicit actions will surface errors.
        });
    }

    if (activePage !== "sessions" || !selectedSession) {
      return;
    }

    let cancelled = false;

    if (!selectedSession.subscribed) {
      void subscribeSession(selectedSession.id)
        .then((record) => {
          if (!cancelled) {
            applySessionUpdate(record);
          }
        })
        .catch((error) => {
          if (!cancelled) {
            setSessionActionError(error instanceof Error ? error.message : "Unable to subscribe to session.");
          }
        });
    }

    setLoadingModelSessionId(selectedSession.id);

    void getSessionModelState(selectedSession.id)
      .then((state) => {
        if (cancelled) {
          return;
        }

        setModelStates((current) => ({
          ...current,
          [state.sessionId]: state,
        }));
      })
      .catch((error) => {
        if (!cancelled) {
          setSessionActionError(error instanceof Error ? error.message : "Unable to load session model.");
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoadingModelSessionId((current) => (current === selectedSession.id ? null : current));
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activePage, isLogsWindow, selectedSession?.id, selectedSession?.subscribed, applySessionUpdate, mergeSessionRecord]);

  useEffect(() => {
    if (isLogsWindow) {
      return;
    }

    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [displayedEvents, isLogsWindow, selectedSession?.id]);

  const activeNavItems = useMemo(() => NAV_ITEMS.filter((item) => item.id !== "settings"), []);
  const selectedSessionDisplayStatus: SessionStatus = selectedSessionPendingRun ? "streaming" : selectedSession?.status ?? "idle";

  async function handleModelChange(value: string) {
    if (!selectedSession) {
      return;
    }

    const [provider, ...modelParts] = value.split("/");
    const modelId = modelParts.join("/");
    if (!provider || !modelId) {
      return;
    }

    setSessionActionError(null);
    setChangingModelSessionId(selectedSession.id);

    try {
      const state = await setSessionModel(selectedSession.id, provider, modelId);
      setModelStates((current) => ({
        ...current,
        [state.sessionId]: state,
      }));
    } catch (error) {
      setSessionActionError(error instanceof Error ? error.message : "Unable to change models.");
    } finally {
      setChangingModelSessionId((current) => (current === selectedSession.id ? null : current));
    }
  }

  function handleSendMessage() {
    if (!selectedSession) {
      return;
    }

    const trimmedMessage = draftMessage.trim();
    if (!trimmedMessage || pendingRuns[selectedSession.id]) {
      return;
    }

    const runId = createClientId("run");
    const timestamp = nowIso();
    const sessionId = selectedSession.id;

    const pendingUserEvent: SessionEvent = {
      id: `pending-user-${runId}`,
      kind: "user",
      message: trimmedMessage,
      timestamp,
      pending: true,
      runId,
    };

    setSessionActionError(null);
    setDraftMessage("");
    setPendingRuns((current) => ({
      ...current,
      [sessionId]: {
        runId,
        userEvent: pendingUserEvent,
      },
    }));
    patchSessionRecord(sessionId, (session) => ({
      ...session,
      status: "streaming",
      updatedAt: timestamp,
      events: [...session.events.filter((event) => event.runId !== runId), pendingUserEvent],
    }));

    void sendSessionMessage(sessionId, trimmedMessage, runId).catch((error) => {
      patchSessionRecord(sessionId, (session) => ({
        ...session,
        status: "failed",
        events: session.events.filter((event) => event.runId !== runId),
      }));
      removePendingRun(sessionId, runId);
      setDraftMessage((current) => (current.length === 0 ? trimmedMessage : current));
      setSessionActionError(error instanceof Error ? error.message : "Unable to queue message.");
    });
  }

  if (isLogsWindow) {
    return (
      <main className="logs-window-shell">
        <header className="logs-window-header">
          <div>
            <p className="eyebrow">Orchestra diagnostics</p>
            <h1>Logs</h1>
          </div>

          <div className="status-cluster">
            <div className="status-pill">
              <span className="status-pill__label">Environment</span>
              <strong>{appInfo?.environment ?? "loading"}</strong>
            </div>
            <div className="status-pill">
              <span className="status-pill__label">Backend</span>
              <strong>{appInfo?.backendStatus ?? "loading"}</strong>
            </div>
          </div>
        </header>

        <RuntimeLogPanel
          logs={logs}
          loadingLogs={loadingLogs}
          clearingLogs={clearingLogs}
          onRefresh={() => void loadLogs()}
          onClear={() => void handleClearLogs()}
        />
      </main>
    );
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="project-switcher">
            <span className="project-switcher__label">Project</span>
            <select
              className="project-switcher__button"
              data-role="project-switcher"
              value={activeProject?.id ?? ""}
              onChange={(event) => setActiveProjectIdState(event.target.value || null)}
            >
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </div>

          <nav className="primary-nav" aria-label="Primary">
            {activeNavItems.map((item) => (
              <button
                key={item.id}
                className={item.id === activePage ? "nav-item nav-item--active" : "nav-item"}
                type="button"
                onClick={() => setActivePage(item.id)}
              >
                {item.label}
              </button>
            ))}
          </nav>
        </div>

        <div className="sidebar__bottom">
          <div className="settings-nav">
            <button
              className={activePage === "settings" ? "nav-item nav-item--active" : "nav-item"}
              type="button"
              onClick={() => setActivePage("settings")}
            >
              Settings
            </button>

            {activePage === "settings" ? (
              <div className="settings-subnav" role="tablist" aria-label="Settings sections">
                {SETTINGS_TABS.map((tab) => (
                  <button
                    key={tab.id}
                    className={settingsTab === tab.id ? "settings-subnav__item settings-subnav__item--active" : "settings-subnav__item"}
                    type="button"
                    role="tab"
                    aria-selected={settingsTab === tab.id}
                    onClick={() => setSettingsTab(tab.id)}
                  >
                    {tab.id === "logs" ? "General" : tab.label}
                  </button>
                ))}
              </div>
            ) : null}
          </div>
        </div>
      </aside>

      <main className="content">
        <header className="page-header page-header--compact">
          <div>
            {activePage === "sessions" ? (
              <button
                className="primary-button"
                data-role="create-session"
                type="button"
                disabled={isSubmitting}
                onClick={() =>
                  void runSessionAction(async () => createSession())
                }
              >
                Create session
              </button>
            ) : null}
          </div>
          <div className="status-cluster">
            <button className="secondary-button" type="button" onClick={() => void handleOpenLogsWindow()}>
              Open logs
            </button>
            <div className="status-pill">
              <span className="status-pill__label">Environment</span>
              <strong>{appInfo?.environment ?? "loading"}</strong>
            </div>
            <div className="status-pill">
              <span className="status-pill__label">Backend</span>
              <strong>{appInfo?.backendStatus ?? "loading"}</strong>
            </div>
          </div>
        </header>

        {activePage === "settings" ? (
          settingsTab === "projects" ? (
            <ProjectsPanel />
          ) : settingsTab === "agents" ? (
            <AgentsPanel />
          ) : settingsTab === "roles" ? (
            <RolesPanel />
          ) : settingsTab === "workflows" ? (
            <WorkflowsPanel />
          ) : (
            <section className="panel panel--split">
              <div>
                <p className="eyebrow">General</p>
                <h3>Open runtime logs in a separate window</h3>
                <p>
                  Keep the log window open while testing sessions so backend/runtime events stay visible without covering the main UI.
                </p>
              </div>

              <div className="settings-log-actions">
                <button className="primary-button" type="button" onClick={() => void handleOpenLogsWindow()}>
                  Open logs window
                </button>
                <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleClearLogs()} disabled={clearingLogs}>
                  {clearingLogs ? "Clearing…" : "Clear logs"}
                </button>
              </div>
            </section>
          )
        ) : activePage === "agents" ? (
          <AgentsPage key={activeProject?.id ?? "default"} />
        ) : activePage === "sessions" ? (
          <SessionsPage
            sessions={sessions}
            selectedSession={selectedSession}
            displayedEvents={displayedEvents}
            selectedSessionPending={Boolean(selectedSessionPendingRun)}
            selectedSessionDisplayStatus={selectedSessionDisplayStatus}
            selectedModelState={selectedModelState}
            loadingSessions={loadingSessions}
            loadingModelSessionId={loadingModelSessionId}
            changingModelSessionId={changingModelSessionId}
            draftMessage={draftMessage}
            sessionActionError={sessionActionError}
            transcriptRef={transcriptRef}
            formatDateTime={formatDateTime}
            formatTimestamp={formatTimestamp}
            formatModelOptionLabel={formatModelOptionLabel}
            getStatusTone={getStatusTone}
            getEventTone={getEventTone}
            onSelectSession={setSelectedSessionId}
            onDeleteSession={(sessionId) => void handleDeleteSession(sessionId)}
            onModelChange={(value) => void handleModelChange(value)}
            onDraftChange={setDraftMessage}
            onSendMessage={handleSendMessage}
          />
        ) : (
          <TasksPage key={activeProject?.id ?? "default"} />
        )}
      </main>
    </div>
  );
}
