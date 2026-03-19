import type { LogEntry } from "../types";

interface RuntimeLogPanelProps {
  logs: LogEntry[];
  loadingLogs: boolean;
  clearingLogs: boolean;
  onRefresh: () => void;
  onClear: () => void;
}

export function RuntimeLogPanel({ logs, loadingLogs, clearingLogs, onRefresh, onClear }: RuntimeLogPanelProps) {
  return (
    <section className="panel log-panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">Application logs</p>
          <h3>Runtime log</h3>
        </div>

        <div className="action-cluster">
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={loadingLogs || clearingLogs}>
            Refresh
          </button>
          <button className="secondary-button secondary-button--danger" type="button" onClick={onClear} disabled={clearingLogs}>
            {clearingLogs ? "Clearing…" : "Clear logs"}
          </button>
        </div>
      </div>

      {loadingLogs ? <p className="muted-copy">Loading logs…</p> : null}
      {!loadingLogs && logs.length === 0 ? <p className="muted-copy">No logs yet.</p> : null}

      <div className="log-list" role="log" aria-live="polite">
        {logs.map((entry) => (
          <article className="log-entry" key={entry.id}>
            <div className="log-entry__meta">
              <span className={`log-level log-level--${entry.level}`}>{entry.level}</span>
              <span>{entry.target}</span>
              <time dateTime={entry.timestamp}>{new Date(entry.timestamp).toLocaleTimeString([], {
                hour: "2-digit",
                minute: "2-digit",
                second: "2-digit",
              })}</time>
            </div>
            <p>{entry.message}</p>
          </article>
        ))}
      </div>
    </section>
  );
}
