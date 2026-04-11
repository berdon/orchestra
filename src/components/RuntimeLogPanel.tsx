import { useMemo, useState } from "react";

import type { LogEntry, LogLevel } from "../types";

interface RuntimeLogPanelProps {
  logs: LogEntry[];
  loadingLogs: boolean;
  clearingLogs: boolean;
  exportingLogs?: boolean;
  exportStatusMessage?: string | null;
  exportErrorMessage?: string | null;
  includeRelatedSessionSnapshot?: boolean;
  onRefresh: () => void;
  onClear: () => void;
  onToggleIncludeRelatedSessionSnapshot?: (nextValue: boolean) => void;
  onExport?: () => void;
}

const LOG_LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

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

function formatLogLevelLabel(level: LogLevel) {
  switch (level) {
    case "debug":
      return "Debug and above";
    case "warn":
      return "Warn and above";
    case "error":
      return "Error only";
    default:
      return "Info and above";
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

export function RuntimeLogPanel({
  logs,
  loadingLogs,
  clearingLogs,
  exportingLogs = false,
  exportStatusMessage = null,
  exportErrorMessage = null,
  includeRelatedSessionSnapshot = false,
  onRefresh,
  onClear,
  onToggleIncludeRelatedSessionSnapshot,
  onExport,
}: RuntimeLogPanelProps) {
  const [minimumLevel, setMinimumLevel] = useState<LogLevel>("info");

  const filteredLogs = useMemo(
    () => logs.filter((entry) => LOG_LEVEL_PRIORITY[entry.level] >= LOG_LEVEL_PRIORITY[minimumLevel]),
    [logs, minimumLevel],
  );

  return (
    <section className="panel log-panel">
      <div className="panel__header">
        <div>
          <p className="eyebrow">Application logs</p>
          <h3>Runtime log</h3>
        </div>

        <div className="action-cluster">
          <label className="field-group field-group--compact log-panel__filter">
            <span className="field-group__label">Log level</span>
            <select
              className="select-input"
              data-role="runtime-log-level-filter"
              value={minimumLevel}
              onChange={(event) => setMinimumLevel(event.target.value as LogLevel)}
              disabled={loadingLogs || clearingLogs || exportingLogs}
            >
              <option value="debug">Debug and above</option>
              <option value="info">Info and above</option>
              <option value="warn">Warn and above</option>
              <option value="error">Error only</option>
            </select>
          </label>
          <button className="secondary-button" type="button" onClick={onRefresh} disabled={loadingLogs || clearingLogs || exportingLogs}>
            Refresh
          </button>
          {onExport ? (
            <button className="secondary-button" data-role="export-log-bundle" type="button" onClick={onExport} disabled={loadingLogs || clearingLogs || exportingLogs}>
              {exportingLogs ? "Exporting…" : "Export zip"}
            </button>
          ) : null}
          <button className="secondary-button secondary-button--danger" type="button" onClick={onClear} disabled={clearingLogs || exportingLogs}>
            {clearingLogs ? "Clearing…" : "Clear logs"}
          </button>
        </div>
      </div>

      <p className="muted-copy">Showing {formatLogLevelLabel(minimumLevel)}.</p>

      {onToggleIncludeRelatedSessionSnapshot ? (
        <label className="checkbox-row" data-role="runtime-log-export-include-related">
          <input
            type="checkbox"
            checked={includeRelatedSessionSnapshot}
            onChange={(event) => onToggleIncludeRelatedSessionSnapshot(event.target.checked)}
            disabled={exportingLogs || loadingLogs || clearingLogs}
          />
          <span>Include related session files and database snapshot in the zip.</span>
        </label>
      ) : null}
      {exportStatusMessage ? <p className="muted-copy" data-role="runtime-log-export-success">{exportStatusMessage}</p> : null}
      {exportErrorMessage ? <p className="error-copy" data-role="runtime-log-export-error">{exportErrorMessage}</p> : null}
      {loadingLogs ? <p className="muted-copy">Loading logs…</p> : null}
      {!loadingLogs && logs.length === 0 ? <p className="muted-copy">No logs yet.</p> : null}
      {!loadingLogs && logs.length > 0 && filteredLogs.length === 0 ? <p className="muted-copy">No logs match the selected level.</p> : null}

      <div className="log-list" role="log" aria-live="polite" data-role="runtime-log-list">
        {filteredLogs.map((entry) => (
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
