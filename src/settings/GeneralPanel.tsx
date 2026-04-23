import { RuntimeLogPanel } from "../components/RuntimeLogPanel";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { OrchestraThemeDefinition, OrchestraThemeId } from "../lib/theme";
import type { BridgeDiagnostics, LogEntry, SystemNotificationEnvironmentStatus, SystemNotificationPermissionState } from "../types";

interface GeneralPanelProps {
  availableThemes: readonly OrchestraThemeDefinition[];
  selectedThemeId: OrchestraThemeId;
  bridgeDiagnostics: BridgeDiagnostics | null;
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
  explanatoryTooltipsEnabled: boolean;
  onThemeChange: (themeId: OrchestraThemeId) => void;
  onToggleExplanatoryTooltips: (nextEnabled: boolean) => void;
  onRefreshBridgeDiagnostics: () => void;
  onCleanupStaleBridges: () => void;
  onOpenLogsWindow: () => void;
  onOpenPromptingSettings: () => void;
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
  explanatoryTooltipsEnabled,
  onThemeChange,
  onToggleExplanatoryTooltips,
  onRefreshBridgeDiagnostics,
  onCleanupStaleBridges,
  onOpenLogsWindow,
  onOpenPromptingSettings,
  onRefreshSystemNotificationPermission,
  onRequestSystemNotificationPermission,
  onSendTestSystemNotification,
  onRefreshLogs,
  onToggleIncludeRelatedSessionSnapshot,
  onExportLogs,
  onClearLogs,
}: GeneralPanelProps) {
  const selectedTheme = availableThemes.find((theme) => theme.id === selectedThemeId) ?? availableThemes[0] ?? null;
  const getTooltipProps = useExplanatoryTooltipProps();
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
          <label className="checkbox-field task-editor-grid__full" {...getTooltipProps("Turn brief hover help on or off across supported controls and form fields.")}>
            <input
              data-role="explanatory-tooltips-toggle"
              type="checkbox"
              checked={explanatoryTooltipsEnabled}
              onChange={(event) => onToggleExplanatoryTooltips(event.target.checked)}
            />
            <span>Show explanatory tooltips</span>
          </label>
          <p className="muted-copy">Hover supported controls and fields to see brief help text.</p>
        </section>

        <section className="task-section task-section--compact" data-role="general-prompting-moved-notice">
          <div className="task-section__header">
            <div>
              <p className="eyebrow">Prompting</p>
              <h4>Prompt settings moved</h4>
              <p className="muted-copy">Task session prompt editing now lives in Settings → Prompting so General can stay focused on appearance, diagnostics, notifications, and logs.</p>
            </div>
            <button className="secondary-button" data-role="open-prompting-settings" type="button" onClick={onOpenPromptingSettings}>
              Open Prompting
            </button>
          </div>
        </section>

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
