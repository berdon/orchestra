import type { LogEntry, LogLevel } from "../types";

interface RuntimeLogPanelProps {
  logs: LogEntry[];
  loadingLogs: boolean;
  clearingLogs: boolean;
  onRefresh: () => void;
  onClear: () => void;
}

function formatLogLevelCode(level: LogLevel) {
  switch (level) {
    case "debug":
      return "D";
    case "warn":
      return "W";
    case "error":
      return "E";
    default:
      return "I";
  }
}

function formatLogTimestamp(timestamp: string) {
  return new Date(timestamp).toLocaleString([], {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatLogMessage(message: string) {
  return message.replace(/\s+/g, " ").trim();
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

      <div className="log-list" role="log" aria-live="polite" data-role="runtime-log-list">
        {logs.map((entry) => (
          <div className={`log-line log-line--${entry.level}`} key={entry.id} data-role="runtime-log-line">
            <span className="log-line__level">[{formatLogLevelCode(entry.level)}]</span>{" "}
            <time dateTime={entry.timestamp}>{formatLogTimestamp(entry.timestamp)}</time>{" "}
            <span>({entry.target}):</span>{" "}
            <span>{formatLogMessage(entry.message)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}
