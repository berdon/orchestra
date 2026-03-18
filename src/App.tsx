import { useEffect, useMemo, useState } from "react";
import { getAppInfo, getLogs } from "./lib/tauri";
import type { AppInfo, LogEntry, PrimaryPage } from "./types";

const NAV_ITEMS: Array<{ id: PrimaryPage; label: string }> = [
  { id: "tasks", label: "Tasks" },
  { id: "agents", label: "Agents" },
  { id: "sessions", label: "Sessions" },
  { id: "settings", label: "Settings" },
];

const PAGE_COPY: Record<Exclude<PrimaryPage, "settings">, { eyebrow: string; title: string; body: string }> = {
  tasks: {
    eyebrow: "Workflow operations",
    title: "Tasks",
    body: "Task and workflow management will live here once the session-first slice is complete.",
  },
  agents: {
    eyebrow: "Workforce overview",
    title: "Agents",
    body: "Agents and roles will share an operational view focused on workload, queues, and active sessions.",
  },
  sessions: {
    eyebrow: "First shipping vertical slice",
    title: "Sessions",
    body: "This page will be implemented next so Orchestra can create, resume, subscribe to, and interact with pi sessions as early as possible.",
  },
};

function formatTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function App() {
  const [activePage, setActivePage] = useState<PrimaryPage>("sessions");
  const [appInfo, setAppInfo] = useState<AppInfo | null>(null);
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [loadingLogs, setLoadingLogs] = useState(false);

  useEffect(() => {
    void getAppInfo().then(setAppInfo);
  }, []);

  useEffect(() => {
    if (activePage !== "settings") {
      return;
    }

    setLoadingLogs(true);
    void getLogs()
      .then(setLogs)
      .finally(() => setLoadingLogs(false));
  }, [activePage]);

  const activeNavItems = useMemo(
    () => NAV_ITEMS.filter((item) => item.id !== "settings"),
    [],
  );

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
                This first scaffold includes a dedicated log surface so backend and session activity can stay visible while the
                rest of the orchestration model is under construction.
              </p>
            </section>

            <section className="panel">
              <div className="panel__header">
                <div>
                  <p className="eyebrow">Application logs</p>
                  <h3>Runtime log</h3>
                </div>
                <button className="secondary-button" type="button" onClick={() => void getLogs().then(setLogs)}>
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
        ) : (
          <section className="panel-stack">
            <section className="panel panel--hero">
              <p className="eyebrow">{PAGE_COPY[activePage].eyebrow}</p>
              <h2>{PAGE_COPY[activePage].title}</h2>
              <p>{PAGE_COPY[activePage].body}</p>
            </section>

            <section className="panel panel--split">
              <div>
                <p className="eyebrow">Scaffold status</p>
                <h3>Base shell in place</h3>
                <ul className="bullet-list">
                  <li>Left navigation with fixed Settings entry</li>
                  <li>Project switcher placeholder at the top</li>
                  <li>Light visual direction with minimal grouping</li>
                  <li>Backend invoke wrapper ready for Tauri commands</li>
                </ul>
              </div>

              <div>
                <p className="eyebrow">Next up</p>
                <h3>Session-first implementation</h3>
                <ul className="bullet-list">
                  <li>Create session</li>
                  <li>Resume session</li>
                  <li>Subscribe to output</li>
                  <li>Send messages back into the session</li>
                </ul>
              </div>
            </section>
          </section>
        )}
      </main>
    </div>
  );
}
