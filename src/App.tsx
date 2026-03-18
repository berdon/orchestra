import { useEffect, useMemo, useState } from "react";
import {
  createSession,
  getAppInfo,
  getLogs,
  listSessions,
  resumeSession,
  sendSessionMessage,
  subscribeSession,
  unsubscribeSession,
} from "./lib/tauri";
import type { AppInfo, LogEntry, PrimaryPage, SessionEvent, SessionRecord, SessionStatus } from "./types";

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

  const selectedSession = useMemo(
    () => sessions.find((session) => session.id === selectedSessionId) ?? sessions[0] ?? null,
    [selectedSessionId, sessions],
  );

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

  function applySessionUpdate(updatedSession: SessionRecord) {
    setSessions((current) => {
      const withoutOld = current.filter((session) => session.id !== updatedSession.id);
      const next = [updatedSession, ...withoutOld].sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
      return next;
    });
    setSelectedSessionId(updatedSession.id);
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

  useEffect(() => {
    void getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    if (activePage === "settings") {
      void loadLogs();
      return;
    }

    if (activePage === "sessions") {
      void loadSessions();
    }
  }, [activePage]);

  const activeNavItems = useMemo(() => NAV_ITEMS.filter((item) => item.id !== "settings"), []);

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
          <section className="panel-stack">
            <section className="panel panel--hero panel--session-hero">
              <div>
                <p className="eyebrow">First shipping vertical slice</p>
                <h2>Sessions</h2>
                <p>
                  Create, resume, subscribe to, and interact with sessions directly from the app. This is the first real product
                  surface for Orchestra.
                </p>
              </div>

              <div className="session-hero__stats">
                <div className="metric-card">
                  <span className="metric-card__label">Known sessions</span>
                  <strong>{sessions.length}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Active</span>
                  <strong>{sessions.filter((session) => session.status === "active").length}</strong>
                </div>
                <div className="metric-card">
                  <span className="metric-card__label">Subscribed</span>
                  <strong>{sessions.filter((session) => session.subscribed).length}</strong>
                </div>
              </div>
            </section>

            <section className="session-shell">
              <aside className="panel session-list-panel">
                <div className="panel__header panel__header--stacked">
                  <div>
                    <p className="eyebrow">Session inventory</p>
                    <h3>Known sessions</h3>
                  </div>
                  <button className="secondary-button" type="button" onClick={() => void loadSessions()}>
                    Refresh
                  </button>
                </div>

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
                    <button
                      key={session.id}
                      className={session.id === selectedSession?.id ? "session-list-item session-list-item--active" : "session-list-item"}
                      type="button"
                      onClick={() => setSelectedSessionId(session.id)}
                    >
                      <div className="session-list-item__header">
                        <strong>{session.title}</strong>
                        <span className={`status-badge status-badge--${getStatusTone(session.status)}`}>{session.status}</span>
                      </div>
                      <div className="session-list-item__meta">
                        <span>{session.id}</span>
                        <span>{formatDateTime(session.updatedAt)}</span>
                      </div>
                      <div className="session-list-item__footer">
                        <span>{session.events.length} events</span>
                        <span>{session.subscribed ? "Subscribed" : "Unsubscribed"}</span>
                      </div>
                    </button>
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

                      <div className="action-cluster">
                        <span className={`status-badge status-badge--${getStatusTone(selectedSession.status)}`}>{selectedSession.status}</span>
                        <span className={selectedSession.subscribed ? "status-badge status-badge--accent" : "status-badge status-badge--neutral"}>
                          {selectedSession.subscribed ? "Subscribed" : "Not subscribed"}
                        </span>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={isSubmitting}
                          onClick={() => void runSessionAction(() => resumeSession(selectedSession.id))}
                        >
                          Resume session
                        </button>
                        <button
                          className="secondary-button"
                          type="button"
                          disabled={isSubmitting}
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

                    <div className="session-transcript" role="log" aria-live="polite">
                      {selectedSession.events.map((event) => (
                        <article className={`transcript-event transcript-event--${getEventTone(event.kind)}`} key={event.id}>
                          <div className="transcript-event__meta">
                            <span>{event.kind}</span>
                            <time dateTime={event.timestamp}>{formatTimestamp(event.timestamp)}</time>
                          </div>
                          <p>{event.message}</p>
                        </article>
                      ))}
                    </div>

                    <form
                      className="composer"
                      onSubmit={(event) => {
                        event.preventDefault();
                        if (!selectedSession) {
                          return;
                        }

                        void runSessionAction(async () => {
                          const session = await sendSessionMessage(selectedSession.id, draftMessage);
                          setDraftMessage("");
                          return session;
                        });
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
                        />
                      </label>
                      <div className="composer__footer">
                        <p className="muted-copy">
                          Desktop mode sends prompts through real pi sessions over RPC. Browser mode still uses the mock session
                          adapter.
                        </p>
                        <button className="primary-button" type="submit" disabled={isSubmitting || draftMessage.trim().length === 0}>
                          Send message
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
                <h3>Session-first app shell</h3>
                <ul className="bullet-list">
                  <li>Project switcher placeholder and stable left navigation</li>
                  <li>Runtime log surface in Settings</li>
                  <li>Browser-backed mock adapter for preview/dev-in-browser workflows</li>
                  <li>Tauri session controls wired to real pi session files and pi RPC turns</li>
                </ul>
              </div>

              <div>
                <p className="eyebrow">Next orchestration layers</p>
                <h3>After sessions</h3>
                <ul className="bullet-list">
                  <li>Projects and repositories</li>
                  <li>Task workflow lanes and lane history</li>
                  <li>Agents, roles, queues, and interruption semantics</li>
                  <li>Live RPC streaming, richer transcript metadata, and multi-session orchestration</li>
                </ul>
              </div>
            </section>
          </section>
        )}
      </main>
    </div>
  );
}
