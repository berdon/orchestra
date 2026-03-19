import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  createSession,
  getAppInfo,
  getLogs,
  getSessionModelState,
  isTauriAvailable,
  listSessions,
  listenToSessionStream,
  resumeSession,
  sendSessionMessage,
  setSessionModel,
  subscribeSession,
  unsubscribeSession,
} from "./lib/tauri";
import type {
  AppInfo,
  LogEntry,
  PrimaryPage,
  SessionEvent,
  SessionModelState,
  SessionRecord,
  SessionStatus,
  SessionStreamEvent,
} from "./types";

const NAV_ITEMS: Array<{ id: PrimaryPage; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

const PAGE_COPY: Record<Exclude<PrimaryPage, "sessions" | "settings">, { eyebrow: string; title: string; body: string }> = {
  tasks: {
    eyebrow: "Workflow operations",
    title: "Tasks",
    body: "Task and workflow management will land after the session-first slice is proven end to end.",
  },
  agents: {
    eyebrow: "Workforce overview",
    title: "Agents",
    body: "Agents and roles will share an operational view focused on workload, queues, active sessions, and intervention pressure.",
  },
};

interface PendingSessionRun {
  runId: string;
  userEvent: SessionEvent;
  assistantEvent?: SessionEvent;
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

export function App() {
  const [activePage, setActivePage] = useState<PrimaryPage>("sessions");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);
  const [sessions, setSessions] = useState<SessionRecord[]>([]);
  const [selectedSessionId, setSelectedSessionId] = useState<string | null>(null);
  const [loadingSessions, setLoadingSessions] = useState(false);
  const [sessionActionError, setSessionActionError] = useState<string | null>(null);
  const [newSessionTitle, setNewSessionTitle] = useState("");
  const [draftMessage, setDraftMessage] = useState("");
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [pendingRuns, setPendingRuns] = useState<Record<string, PendingSessionRun>>({});
  const [modelStates, setModelStates] = useState<Record<string, SessionModelState>>({});
  const [loadingModelSessionId, setLoadingModelSessionId] = useState<string | null>(null);
  const [changingModelSessionId, setChangingModelSessionId] = useState<string | null>(null);

  const transcriptRef = useRef<HTMLDivElement | null>(null);
  const viewedSessionIdRef = useRef<string | null>(null);

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null,
    [selectedSessionId, sessions],
  );

  const selectedSessionPendingRun = selectedSession ? pendingRuns[selectedSession.id] : undefined;
  const selectedModelState = selectedSession ? modelStates[selectedSession.id] : undefined;

  const displayedEvents = useMemo(() => {
    if (!selectedSession) {
      return [];
    }

    const pendingRun = pendingRuns[selectedSession.id];
    if (!pendingRun) {
      return selectedSession.events;
    }

    return [
      ...selectedSession.events,
      pendingRun.userEvent,
      ...(pendingRun.assistantEvent ? [pendingRun.assistantEvent] : []),
    ];
  }, [pendingRuns, selectedSession]);

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

  const updatePendingRun = useCallback((sessionId: string, updater: (run: PendingSessionRun) => PendingSessionRun) => {
    setPendingRuns((current) => {
      const existing = current[sessionId];
      if (!existing) {
        return current;
      }

      return {
        ...current,
        [sessionId]: updater(existing),
      };
    });
  }, []);

  async function loadLogs() {
    setLoadingLogs(true);
    try {
      setLogs(await getLogs());
    } finally {
      setLoadingLogs(false);
    }
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

  const handleSessionStreamEvent = useCallback(
    (payload: SessionStreamEvent) => {
      switch (payload.event) {
        case "assistantStart": {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            assistantEvent: current.assistantEvent ?? {
              id: `pending-assistant-${payload.runId}`,
              kind: "assistant",
              message: "",
              timestamp: payload.timestamp ?? nowIso(),
              pending: true,
              runId: payload.runId,
            },
          }));
          break;
        }
        case "assistantDelta": {
          updatePendingRun(payload.sessionId, (current) => ({
            ...current,
            assistantEvent: {
              id: current.assistantEvent?.id ?? `pending-assistant-${payload.runId}`,
              kind: "assistant",
              message: `${current.assistantEvent?.message ?? ""}${payload.delta ?? ""}`,
              timestamp: current.assistantEvent?.timestamp ?? payload.timestamp ?? nowIso(),
              pending: true,
              runId: payload.runId,
            },
          }));
          break;
        }
        case "sessionUpdated": {
          if (payload.record) {
            applySessionUpdate(payload.record);
          }
          removePendingRun(payload.sessionId, payload.runId);
          break;
        }
        case "error": {
          removePendingRun(payload.sessionId, payload.runId);
          setSessionActionError(payload.message ?? "Session action failed.");
          break;
        }
        default:
          break;
      }
    },
    [applySessionUpdate, removePendingRun, updatePendingRun],
  );

  useEffect(() => {
    void getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    if (!isTauriAvailable()) {
      void listenToSessionStream(handleSessionStreamEvent).then((dispose) => {
        unlisten = dispose;
      });
      return () => {
        unlisten?.();
      };
    }

    void listenToSessionStream(handleSessionStreamEvent).then((dispose) => {
      unlisten = dispose;
    });

    return () => {
      unlisten?.();
    };
  }, [handleSessionStreamEvent]);

  useEffect(() => {
    if (activePage === "settings") {
      void loadLogs();
      return;
    }

    if (activePage === "sessions") {
      void loadSessions();
    }
  }, [activePage]);

  useEffect(() => {
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
  }, [activePage, selectedSession?.id, selectedSession?.subscribed, applySessionUpdate, mergeSessionRecord]);

  useEffect(() => {
    const node = transcriptRef.current;
    if (!node) {
      return;
    }

    node.scrollTop = node.scrollHeight;
  }, [displayedEvents, selectedSession?.id]);

  const activeNavItems = useMemo(() => NAV_ITEMS.filter((item) => item.id !== "settings"), []);
  const selectedSessionDisplayStatus: SessionStatus = selectedSessionPendingRun ? "streaming" : selectedSession?.status ?? "idle";
  const selectedSessionBusy = Boolean(selectedSessionPendingRun) || isSubmitting;

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

    setSessionActionError(null);
    setDraftMessage("");
    setPendingRuns((current) => ({
      ...current,
      [sessionId]: {
        runId,
        userEvent: {
          id: `pending-user-${runId}`,
          kind: "user",
          message: trimmedMessage,
          timestamp,
          pending: true,
          runId,
        },
      },
    }));

    void sendSessionMessage(sessionId, trimmedMessage, runId).catch((error) => {
      removePendingRun(sessionId, runId);
      setDraftMessage((current) => (current.length === 0 ? trimmedMessage : current));
      setSessionActionError(error instanceof Error ? error.message : "Unable to queue message.");
    });
  }

  return (
    <div className="app-shell">
      <aside className="sidebar">
        <div className="sidebar__top">
          <div className="project-switcher">
            <span className="project-switcher__label">Project</span>
            <button className="project-switcher__button" type="button">
              Orchestra <span aria-hidden="true">▾</span>
            </button>
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
          <button
            className={activePage === "settings" ? "nav-item nav-item--active" : "nav-item"}
            type="button"
            onClick={() => setActivePage("settings")}
          >
            Settings
          </button>
        </div>
      </aside>

      <main className="content">
        <header className="page-header">
          <div>
            <p className="eyebrow">Agent orchestration framework</p>
            <h1>Orchestra</h1>
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

        {activePage === "settings" ? (
          <section className="panel-stack">
            <section className="panel panel--hero">
              <p className="eyebrow">Development visibility</p>
              <h2>Settings</h2>
              <p>
                The Settings view keeps backend and session activity visible while the orchestration model is still being built.
                The session-first slice writes lifecycle activity here so failures stay diagnosable.
              </p>
            </section>

            <section className="panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Application logs</p>
                  <h3>Runtime log</h3>
                </div>
                <button className="secondary-button" type="button" onClick={() => void loadLogs()}>
                  Refresh
                </button>
              </div>

              {loadingLogs ? <p className="muted-copy">Loading logs…</p> : null}

              <div className="log-list" role="log" aria-live="polite">
                {logs.map((entry) => (
                  <article className="log-entry" key={entry.id}>
                    <div className="log-entry__meta">
                      <span className={`log-level log-level--${entry.level}`}>{entry.level}</span>
                      <span>{entry.target}</span>
                      <time dateTime={entry.timestamp}>{formatTimestamp(entry.timestamp)}</time>
                    </div>
                    <p>{entry.message}</p>
                  </article>
                ))}
              </div>
            </section>
          </section>
        ) : activePage === "sessions" ? (
          <section className="panel-stack panel-stack--sessions">
            <section className="session-shell">
              <aside className="panel session-list-panel">
                <form
                  className="session-create-form"
                  onSubmit={(event) => {
                    event.preventDefault();
                    void runSessionAction(async () => {
                      const session = await createSession(newSessionTitle);
                      setNewSessionTitle("");
                      return session;
                    });
                  }}
                >
                  <label className="field-group">
                    <span className="field-group__label">New session title</span>
                    <input
                      className="text-input"
                      type="text"
                      placeholder="e.g. Session-first spike"
                      value={newSessionTitle}
                      onChange={(event) => setNewSessionTitle(event.target.value)}
                    />
                  </label>
                  <button className="primary-button" type="submit" disabled={isSubmitting}>
                    Create session
                  </button>
                </form>

                {loadingSessions ? <p className="muted-copy">Loading sessions…</p> : null}
                {sessionActionError ? <p className="error-copy">{sessionActionError}</p> : null}

                <div className="session-list" role="list">
                  {sessions.map((session) => (
                    <a
                      key={session.id}
                      className={session.id === selectedSession?.id ? "session-list-link session-list-link--active" : "session-list-link"}
                      href="#"
                      onClick={(event) => {
                        event.preventDefault();
                        setSelectedSessionId(session.id);
                      }}
                    >
                      {session.title}
                    </a>
                  ))}
                </div>
              </aside>

              <section className="panel session-detail-panel">
                {selectedSession ? (
                  <>
                    <div className="panel__header panel__header--session-detail">
                      <div>
                        <p className="eyebrow">Session detail</p>
                        <h3>{selectedSession.title}</h3>
                        <div className="session-detail__meta">
                          <span>{selectedSession.id}</span>
                          <span>Created {formatDateTime(selectedSession.createdAt)}</span>
                          <span>Updated {formatDateTime(selectedSession.updatedAt)}</span>
                        </div>
                      </div>

                      <div className="action-cluster action-cluster--session-tools">
                        <label className="field-group field-group--compact session-model-field">
                          <span className="field-group__label">Model</span>
                          <select
                            className="select-input"
                            value={selectedModelState?.currentModel ? `${selectedModelState.currentModel.provider}/${selectedModelState.currentModel.id}` : ""}
                            disabled={
                              loadingModelSessionId === selectedSession.id ||
                              changingModelSessionId === selectedSession.id ||
                              Boolean(selectedSessionPendingRun)
                            }
                            onChange={(event) => void handleModelChange(event.target.value)}
                          >
                            {!selectedModelState?.availableModels.length || !selectedModelState.currentModel ? (
                              <option value="">{formatModelOptionLabel(selectedModelState)}</option>
                            ) : null}
                            {selectedModelState?.availableModels.map((model) => (
                              <option key={`${model.provider}/${model.id}`} value={`${model.provider}/${model.id}`}>
                                {model.name} · {model.provider}
                              </option>
                            ))}
                          </select>
                        </label>

                        <span className={`status-badge status-badge--${getStatusTone(selectedSessionDisplayStatus)}`}>{selectedSessionDisplayStatus}</span>
                        <span className={selectedSession.subscribed ? "status-badge status-badge--accent" : "status-badge status-badge--neutral"}>
                          {selectedSession.subscribed ? "Subscribed" : "Not subscribed"}
                        </span>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={selectedSessionBusy}
                          onClick={() => void runSessionAction(() => resumeSession(selectedSession.id))}
                        >
                          Resume session
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={selectedSessionBusy}
                          onClick={() =>
                            void runSessionAction(() =>
                              selectedSession.subscribed ? unsubscribeSession(selectedSession.id) : subscribeSession(selectedSession.id),
                            )
                          }
                        >
                          {selectedSession.subscribed ? "Unsubscribe" : "Subscribe"}
                        </button>
                      </div>
                    </div>

                    <div className="session-transcript" ref={transcriptRef} role="log" aria-live="polite">
                      {displayedEvents.map((event) => (
                        <article
                          className={`transcript-event transcript-event--${getEventTone(event.kind)}${event.pending ? " transcript-event--pending" : ""}`}
                          key={event.id}
                        >
                          <div className="transcript-event__meta">
                            <span>{event.kind}</span>
                            <div className="transcript-event__meta-group">
                              {event.pending ? <span className="pending-badge">Pending</span> : null}
                              <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                            </div>
                          </div>
                          <p>{event.message || (event.kind === "assistant" ? "Thinking…" : "Queued…")}</p>
                        </article>
                      ))}
                    </div>

                    <form
                      className="composer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        handleSendMessage();
                      }}
                    >
                      <label className="field-group field-group--composer">
                        <span className="field-group__label">Send message</span>
                        <textarea
                          className="text-area"
                          rows={4}
                          placeholder="Tell the session what to do next…"
                          value={draftMessage}
                          onChange={(event) => setDraftMessage(event.target.value)}
                          onKeyDown={(event) => {
                            if ((event.ctrlKey || event.metaKey) && event.key === "Enter") {
                              event.preventDefault();
                              handleSendMessage();
                            }
                          }}
                        />
                      </label>
                      <div className="composer__footer">
                        <p className="muted-copy">
                          {selectedSessionPendingRun ? "Response in progress…" : "Press Ctrl+Enter or ⌘+Enter to send."}
                        </p>
                        <button
                          className="primary-button"
                          type="submit"
                          disabled={Boolean(selectedSessionPendingRun) || draftMessage.trim().length === 0}
                        >
                          {selectedSessionPendingRun ? "Sending…" : "Send message"}
                        </button>
                      </div>
                    </form>
                  </>
                ) : (
                  <div className="empty-state">
                    <p className="eyebrow">No session selected</p>
                    <h3>Create or select a session</h3>
                    <p>Use the session list to select an existing session or create a new one to begin the interaction flow.</p>
                  </div>
                )}
              </section>
            </section>
          </section>
        ) : (
          <section className="panel-stack">
            <section className="panel panel--hero">
              <p className="eyebrow">{PAGE_COPY[activePage].eyebrow}</p>
              <h2>{PAGE_COPY[activePage].title}</h2>
              <p>{PAGE_COPY[activePage].body}</p>
            </section>

            <section className="panel panel--split">
              <div>
                <p className="eyebrow">Foundation</p>
                <h3>Session workspace</h3>
                <ul className="bullet-list">
                  <li>Project switcher placeholder and stable left navigation</li>
                  <li>Live transcript that stays pinned to the newest message</li>
                  <li>Keyboard-first composer with optimistic pending states</li>
                  <li>Per-session model selection from the app</li>
                </ul>
              </div>

              <div>
                <p className="eyebrow">Next orchestration layers</p>
                <h3>After sessions</h3>
                <ul className="bullet-list">
                  <li>Projects and repositories</li>
                  <li>Task workflow lanes and lane history</li>
                  <li>Agents, roles, queues, and interruption semantics</li>
                  <li>Multi-session orchestration and richer runtime controls</li>
                </ul>
              </div>
            </section>
          </section>
        )}
      </main>
    </div>
  );
}
