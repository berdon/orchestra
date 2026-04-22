import { useEffect, useState } from "react";

import { RuntimeLogPanel } from "../components/RuntimeLogPanel";
import type { OrchestraThemeDefinition, OrchestraThemeId } from "../lib/theme";
import type { BridgeDiagnostics, LogEntry, PiRuntimeSettings, ProjectSessionPromptSettings, SystemNotificationEnvironmentStatus, SystemNotificationPermissionState } from "../types";

interface GeneralPanelProps {
  availableThemes: readonly OrchestraThemeDefinition[];
  selectedThemeId: OrchestraThemeId;
  bridgeDiagnostics: BridgeDiagnostics | null;
  sessionPromptSettings: ProjectSessionPromptSettings | null;
  piRuntimeSettings: PiRuntimeSettings | null;
  systemNotificationEnvironment: SystemNotificationEnvironmentStatus | null;
  systemNotificationPermission: SystemNotificationPermissionState;
  refreshingSystemNotificationPermission: boolean;
  requestingSystemNotificationPermission: boolean;
  sendingTestSystemNotification: boolean;
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
  onSavePiRuntimeSettings: (input: { extraExtensions: string[]; defaultCompactionWindow: string }) => void;
  onRefreshSystemNotificationPermission: () => void;
  onRequestSystemNotificationPermission: () => void;
  onSendTestSystemNotification: () => void;
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

function formatNotificationPermissionLabel(value: SystemNotificationPermissionState) {
  switch (value) {
    case "not_determined":
      return "Not determined";
    case "denied":
      return "Denied";
    case "granted":
      return "Granted";
    case "provisional":
      return "Provisional";
    case "ephemeral":
      return "Ephemeral";
    default:
      return "Unsupported";
  }
}

export function GeneralPanel({
  availableThemes,
  selectedThemeId,
  bridgeDiagnostics,
  sessionPromptSettings,
  piRuntimeSettings,
  systemNotificationEnvironment,
  systemNotificationPermission,
  refreshingSystemNotificationPermission,
  requestingSystemNotificationPermission,
  sendingTestSystemNotification,
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
  onSavePiRuntimeSettings,
  onRefreshSystemNotificationPermission,
  onRequestSystemNotificationPermission,
  onSendTestSystemNotification,
  onRefreshLogs,
  onToggleIncludeRelatedSessionSnapshot,
  onExportLogs,
  onClearLogs,
}: GeneralPanelProps) {
  const [templateDraft, setTemplateDraft] = useState("");
  const [piExtensionsDraft, setPiExtensionsDraft] = useState("");
  const [defaultCompactionWindowDraft, setDefaultCompactionWindowDraft] = useState("10%");
  const selectedTheme = availableThemes.find((theme) => theme.id === selectedThemeId) ?? availableThemes[0] ?? null;

  useEffect(() => {
    setTemplateDraft(sessionPromptSettings?.template ?? "");
  }, [sessionPromptSettings?.template]);

  useEffect(() => {
    setPiExtensionsDraft(piRuntimeSettings?.extraExtensions.join("\n") ?? "");
    setDefaultCompactionWindowDraft(piRuntimeSettings?.defaultCompactionWindow ?? "10%");
  }, [piRuntimeSettings?.defaultCompactionWindow, piRuntimeSettings?.extraExtensions]);
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

        {piRuntimeSettings ? (
          <section className="task-section task-section--compact" data-role="pi-runtime-settings-panel">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Harness configuration</p>
                <h4>PI settings</h4>
                <p className="muted-copy">Add extra pi extensions to load for newly spawned Orchestra runtime sessions. Enter one extension name or path per line. Orchestra still loads its built-in extension, and existing sessions keep their current extension set.</p>
              </div>
              <div className="action-cluster action-cluster--wrap">
                <button className="secondary-button" data-role="reset-pi-runtime-extensions" type="button" onClick={() => {
                  setPiExtensionsDraft("");
                  setDefaultCompactionWindowDraft("10%");
                }}>
                  Reset to built-in defaults
                </button>
                <button
                  className="secondary-button"
                  data-role="save-pi-runtime-extensions"
                  type="button"
                  onClick={() => onSavePiRuntimeSettings({
                    extraExtensions: piExtensionsDraft.split(/\r?\n/g),
                    defaultCompactionWindow: defaultCompactionWindowDraft,
                  })}
                >
                  Save PI settings
                </button>
              </div>
            </div>
            <label className="field-group field-group--compact">
              <span className="field-group__label">Default compaction window</span>
              <input
                className="text-input"
                data-role="pi-runtime-default-compaction-window"
                type="text"
                placeholder="10%"
                value={defaultCompactionWindowDraft}
                onChange={(event) => setDefaultCompactionWindowDraft(event.target.value)}
              />
              <span className="field-group__hint">Use `10%`, a token reserve like `16000`, or `off` to disable Orchestra-managed auto-compaction by default.</span>
            </label>
            <label className="field-group">
              <span className="field-group__label">Extra runtime extensions</span>
              <textarea
                className="text-area"
                data-role="pi-runtime-extensions"
                rows={6}
                placeholder="npm:my-extension\n./extensions/local-extension.ts"
                value={piExtensionsDraft}
                onChange={(event) => setPiExtensionsDraft(event.target.value)}
              />
            </label>
            <p className="muted-copy">Last updated: {formatDateTime(piRuntimeSettings.updatedAt)}</p>
          </section>
        ) : null}

        <section className="task-section task-section--compact" data-role="system-notifications-panel">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Desktop integration</p>
              <h4>System notifications</h4>
              <p className="muted-copy">Orchestra uses a native macOS notification bridge so Notification Center sees the app as Orchestra instead of a browser/webview sender.</p>
            </div>
            <div className="action-cluster action-cluster--wrap">
              <button
                className="secondary-button"
                data-role="refresh-system-notification-permission"
                type="button"
                disabled={refreshingSystemNotificationPermission}
                onClick={onRefreshSystemNotificationPermission}
              >
                {refreshingSystemNotificationPermission ? "Refreshing…" : "Refresh status"}
              </button>
              <button
                className="secondary-button"
                data-role="request-system-notification-permission"
                type="button"
                disabled={requestingSystemNotificationPermission || systemNotificationPermission === "unsupported"}
                onClick={onRequestSystemNotificationPermission}
              >
                {requestingSystemNotificationPermission ? "Requesting…" : "Request permission"}
              </button>
              <button
                className="secondary-button"
                data-role="send-test-system-notification"
                type="button"
                disabled={sendingTestSystemNotification || !["granted", "provisional", "ephemeral"].includes(systemNotificationPermission)}
                onClick={onSendTestSystemNotification}
              >
                {sendingTestSystemNotification ? "Sending…" : "Send test notification"}
              </button>
            </div>
          </div>
          <p className="muted-copy" data-role="system-notification-permission-state">
            Permission status: {formatNotificationPermissionLabel(systemNotificationPermission)}
          </p>
          {systemNotificationEnvironment?.appBundlePath ? (
            <p className="muted-copy" data-role="system-notification-bundle-path">App bundle: {systemNotificationEnvironment.appBundlePath}</p>
          ) : null}
          {systemNotificationEnvironment?.reason ? (
            <p className="muted-copy" data-role="system-notification-environment-reason">{systemNotificationEnvironment.reason}</p>
          ) : systemNotificationPermission === "unsupported" ? (
            <p className="muted-copy">Native Orchestra system notifications are currently only available in macOS desktop builds.</p>
          ) : (
            <p className="muted-copy">If Orchestra does not appear in macOS Notification Center yet, request permission here and then send a test notification from this panel.</p>
          )}
        </section>

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
