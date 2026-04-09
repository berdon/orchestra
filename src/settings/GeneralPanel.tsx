import { useEffect, useState } from "react";

import { RuntimeLogPanel } from "../components/RuntimeLogPanel";
import type { OrchestraThemeDefinition, OrchestraThemeId } from "../lib/theme";
import type { BridgeDiagnostics, LogEntry, ProjectSessionPromptSettings } from "../types";

interface GeneralPanelProps {
  availableThemes: readonly OrchestraThemeDefinition[];
  selectedThemeId: OrchestraThemeId;
  bridgeDiagnostics: BridgeDiagnostics | null;
  sessionPromptSettings: ProjectSessionPromptSettings | null;
  loadingBridgeDiagnostics: boolean;
  refreshingBridgeDiagnostics: boolean;
  logs: LogEntry[];
  loadingLogs: boolean;
  clearingLogs: boolean;
  exportingLogs: boolean;
  logExportMessage: string | null;
  logExportError: string | null;
  includeRelatedSessionSnapshot: boolean;
  onThemeChange: (themeId: OrchestraThemeId) => void;
  onRefreshBridgeDiagnostics: () => void;
  onCleanupStaleBridges: () => void;
  onOpenLogsWindow: () => void;
  onSaveSessionPromptTemplate: (template: string | null) => void;
  onRefreshLogs: () => void;
  onToggleIncludeRelatedSessionSnapshot: (nextValue: boolean) => void;
  onExportLogs: () => void;
  onClearLogs: () => void;
}

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function GeneralPanel({
  availableThemes,
  selectedThemeId,
  bridgeDiagnostics,
  sessionPromptSettings,
  loadingBridgeDiagnostics,
  refreshingBridgeDiagnostics,
  logs,
  loadingLogs,
  clearingLogs,
  exportingLogs,
  logExportMessage,
  logExportError,
  includeRelatedSessionSnapshot,
  onThemeChange,
  onRefreshBridgeDiagnostics,
  onCleanupStaleBridges,
  onOpenLogsWindow,
  onSaveSessionPromptTemplate,
  onRefreshLogs,
  onToggleIncludeRelatedSessionSnapshot,
  onExportLogs,
  onClearLogs,
}: GeneralPanelProps) {
  const [templateDraft, setTemplateDraft] = useState("");
  const selectedTheme = availableThemes.find((theme) => theme.id === selectedThemeId) ?? availableThemes[0] ?? null;

  useEffect(() => {
    setTemplateDraft(sessionPromptSettings?.template ?? "");
  }, [sessionPromptSettings?.template]);
  return (
    <section className="panel-stack">
      <section className="panel general-panel">
        <section className="task-section task-section--compact" data-role="theme-selection-panel">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Appearance</p>
              <h3>Theme</h3>
              <p className="muted-copy">Choose the default Orchestra workbench theme from a larger built-in catalog inspired by popular VS Code and Ghostty palettes.</p>
            </div>
          </div>
          <label className="field-group field-group--compact">
            <span className="field-group__label">Current theme</span>
            <select
              className="select-input"
              data-role="theme-select"
              value={selectedThemeId}
              onChange={(event) => onThemeChange(event.target.value as OrchestraThemeId)}
            >
              {availableThemes.map((theme) => (
                <option key={theme.id} value={theme.id}>{theme.label}</option>
              ))}
            </select>
          </label>
          {selectedTheme ? (
            <p className="muted-copy" data-role="theme-current-kind">Mode: {selectedTheme.kind.replace(/-/g, " ")}</p>
          ) : null}
        </section>

        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">General</p>
            <h3>Session prompt</h3>
            <p className="muted-copy">Configure the task dynamic-session context prompt template with token replacement so you can iterate on worker instructions without code changes.</p>
          </div>
        </div>

        {sessionPromptSettings ? (
          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Template</p>
                <h4>Task session context prompt</h4>
              </div>
              <div className="action-cluster action-cluster--wrap">
                <button className="secondary-button" data-role="reset-session-prompt-template" type="button" onClick={() => setTemplateDraft(sessionPromptSettings.defaultTemplate)}>
                  Reset draft to default
                </button>
                <button className="secondary-button" data-role="save-session-prompt-template" type="button" onClick={() => onSaveSessionPromptTemplate(templateDraft)}>
                  Save template
                </button>
              </div>
            </div>
            <label className="field-group">
              <span className="field-group__label">Prompt template</span>
              <textarea
                className="text-area general-panel__prompt-template"
                data-role="session-prompt-template"
                rows={14}
                value={templateDraft}
                onChange={(event) => setTemplateDraft(event.target.value)}
              />
            </label>
            <p className="muted-copy">Last updated: {formatDateTime(sessionPromptSettings.updatedAt)}</p>
            <div className="bridge-diagnostics-table-wrap">
              <table className="task-table" data-role="session-prompt-token-table">
                <thead>
                  <tr>
                    <th>Token</th>
                    <th>Description</th>
                  </tr>
                </thead>
                <tbody>
                  {sessionPromptSettings.availableTokens.map((token) => (
                    <tr key={token.token} data-role="session-prompt-token-row">
                      <td><code>{token.token}</code></td>
                      <td>{token.description}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </section>
        ) : null}

        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">General</p>
            <h3>Bridge diagnostics</h3>
            <p className="muted-copy">Inspect Orchestra bridge health, active clients, recent requests, and stale-bridge cleanup activity.</p>
          </div>

          <div className="action-cluster action-cluster--wrap">
            <button className="secondary-button" type="button" onClick={onOpenLogsWindow}>
              Open logs window
            </button>
            <button className="secondary-button" data-role="refresh-bridge-diagnostics" type="button" onClick={onRefreshBridgeDiagnostics} disabled={refreshingBridgeDiagnostics}>
              {refreshingBridgeDiagnostics ? "Refreshing…" : "Refresh diagnostics"}
            </button>
            <button className="secondary-button secondary-button--danger" data-role="cleanup-stale-bridges" type="button" onClick={onCleanupStaleBridges} disabled={refreshingBridgeDiagnostics}>
              Cleanup stale bridges
            </button>
          </div>
        </div>

        {loadingBridgeDiagnostics ? <p className="muted-copy">Loading bridge diagnostics…</p> : null}

        {bridgeDiagnostics ? (
          <>
            <div className="workforce-metrics">
              <article className="status-card">
                <span className="status-card__label">Bridge instance</span>
                <strong data-role="bridge-instance-id">{bridgeDiagnostics.instance.instanceId}</strong>
              </article>
              <article className="status-card">
                <span className="status-card__label">Active clients</span>
                <strong data-role="bridge-active-client-count">{bridgeDiagnostics.instance.activeClientCount}</strong>
              </article>
              <article className="status-card">
                <span className="status-card__label">In-flight requests</span>
                <strong data-role="bridge-inflight-request-count">{bridgeDiagnostics.instance.inFlightRequestCount}</strong>
              </article>
              <article className="status-card">
                <span className="status-card__label">Last heartbeat</span>
                <strong>{formatDateTime(bridgeDiagnostics.instance.heartbeatAt)}</strong>
              </article>
            </div>

            <div className="task-section-list">
              <section className="task-section task-section--compact">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Bridge instance</p>
                    <h4>Listener details</h4>
                  </div>
                </div>
                <div className="workforce-meta-grid muted-copy" data-role="bridge-instance-metadata">
                  <span>URL: {bridgeDiagnostics.instance.url}</span>
                  <span>Owner PID: {bridgeDiagnostics.instance.ownerPid}</span>
                  <span>Started: {formatDateTime(bridgeDiagnostics.instance.startedAt)}</span>
                  <span>Metadata path: {bridgeDiagnostics.instance.metadataPath}</span>
                </div>
              </section>

              <section className="task-section task-section--compact">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Clients</p>
                    <h4>Active bridge clients</h4>
                  </div>
                </div>
                {bridgeDiagnostics.clients.length ? (
                  <div className="bridge-diagnostics-table-wrap">
                    <table className="task-table" data-role="bridge-clients-table">
                      <thead>
                        <tr>
                          <th>Client</th>
                          <th>Session</th>
                          <th>Actor</th>
                          <th>Last command</th>
                          <th>In-flight</th>
                          <th>Last seen</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bridgeDiagnostics.clients.map((client) => (
                          <tr key={client.clientId} data-role="bridge-client-row">
                            <td>{client.clientId}</td>
                            <td>{client.sessionId ?? "—"}</td>
                            <td>{client.actorType && client.actorId ? `${client.actorType}:${client.actorId}` : "—"}</td>
                            <td>{client.lastCommand ?? "—"}</td>
                            <td>{client.inFlightRequestCount}</td>
                            <td>{formatDateTime(client.lastSeenAt)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted-copy">No active bridge clients yet.</p>}
              </section>

              <section className="task-section task-section--compact">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Requests</p>
                    <h4>Recent bridge requests</h4>
                  </div>
                </div>
                {bridgeDiagnostics.recentRequests.length ? (
                  <div className="bridge-diagnostics-table-wrap">
                    <table className="task-table" data-role="bridge-requests-table">
                      <thead>
                        <tr>
                          <th>Command</th>
                          <th>Session</th>
                          <th>Started</th>
                          <th>Duration</th>
                          <th>Outcome</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bridgeDiagnostics.recentRequests.map((request) => (
                          <tr key={request.requestId} data-role="bridge-request-row">
                            <td>{request.command}</td>
                            <td>{request.sessionId ?? "—"}</td>
                            <td>{formatDateTime(request.startedAt)}</td>
                            <td>{request.durationMs ?? "—"}</td>
                            <td>{request.success ? "success" : request.error ?? "error"}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted-copy">No bridge requests recorded yet.</p>}
              </section>

              <section className="task-section task-section--compact">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Cleanup</p>
                    <h4>Recent stale-bridge cleanup events</h4>
                  </div>
                </div>
                {bridgeDiagnostics.recentCleanupEvents.length ? (
                  <div className="bridge-diagnostics-table-wrap">
                    <table className="task-table" data-role="bridge-cleanup-table">
                      <thead>
                        <tr>
                          <th>Action</th>
                          <th>Instance</th>
                          <th>Reason</th>
                          <th>Outcome</th>
                          <th>Timestamp</th>
                        </tr>
                      </thead>
                      <tbody>
                        {bridgeDiagnostics.recentCleanupEvents.map((event) => (
                          <tr key={event.id} data-role="bridge-cleanup-row">
                            <td>{event.action}</td>
                            <td>{event.instanceId ?? "—"}</td>
                            <td>{event.reason}</td>
                            <td>{event.success ? "success" : "failed"}</td>
                            <td>{formatDateTime(event.timestamp)}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </div>
                ) : <p className="muted-copy">No cleanup events recorded yet.</p>}
              </section>
            </div>
          </>
        ) : null}
      </section>

      <RuntimeLogPanel
        logs={logs}
        loadingLogs={loadingLogs}
        clearingLogs={clearingLogs}
        exportingLogs={exportingLogs}
        exportStatusMessage={logExportMessage}
        exportErrorMessage={logExportError}
        includeRelatedSessionSnapshot={includeRelatedSessionSnapshot}
        onRefresh={onRefreshLogs}
        onToggleIncludeRelatedSessionSnapshot={onToggleIncludeRelatedSessionSnapshot}
        onExport={onExportLogs}
        onClear={onClearLogs}
      />
    </section>
  );
}
