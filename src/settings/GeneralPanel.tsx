import { useMemo } from "react";

import { AgentReferenceLink, RoleReferenceLink, SessionReferenceLink, buildEntityReferenceLookup } from "../components/entity-links";
import { RuntimeLogPanel } from "../components/RuntimeLogPanel";
import { SettingsSectionTabs } from "../components/SettingsSectionTabs";
import { type RemoteWebPushState } from "../lib/webPush";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { OrchestraThemeDefinition, OrchestraThemeId } from "../lib/theme";
import type { AgentSummary, BridgeDiagnostics, LogEntry, RoleSummary, SessionRecord, SystemNotificationEnvironmentStatus, SystemNotificationPermissionState } from "../types";

interface GeneralPanelProps {
  orchestraVersionDisplay?: string | null;
  availableThemes: readonly OrchestraThemeDefinition[];
  selectedThemeId: OrchestraThemeId;
  canManageBridgeDiagnostics: boolean;
  canManageRuntimeLogs: boolean;
  canManageSystemNotifications: boolean;
  canOpenLogsWindow: boolean;
  bridgeDiagnostics: BridgeDiagnostics | null;
  referenceSessions?: SessionRecord[];
  referenceAgents?: AgentSummary[];
  referenceRoles?: RoleSummary[];
  localNotificationsEnabled: boolean;
  systemNotificationEnvironment: SystemNotificationEnvironmentStatus | null;
  systemNotificationPermission: SystemNotificationPermissionState;
  remoteWebPushState: RemoteWebPushState;
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
  onOpenSession: (sessionId: string, projectId?: string | null) => void;
  onOpenAgent: (agentId: string) => void;
  onOpenRole: (roleId: string) => void;
  onOpenLogsWindow: () => void;
  onOpenPromptingSettings: () => void;
  onToggleLocalNotificationsEnabled: (nextEnabled: boolean) => void;
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

function formatRemoteWebPushLabel(state: RemoteWebPushState) {
  switch (state.status) {
    case "subscribed":
      return "Subscribed";
    case "disabled":
      return "Disabled";
    case "permission_required":
      return "Permission required";
    case "error":
      return "Error";
    default:
      return "Unavailable";
  }
}

export function GeneralPanel({
  orchestraVersionDisplay,
  availableThemes,
  selectedThemeId,
  canManageBridgeDiagnostics,
  canManageRuntimeLogs,
  canManageSystemNotifications,
  canOpenLogsWindow,
  bridgeDiagnostics,
  referenceSessions = [],
  referenceAgents = [],
  referenceRoles = [],
  localNotificationsEnabled,
  systemNotificationEnvironment,
  systemNotificationPermission,
  remoteWebPushState,
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
  onOpenSession,
  onOpenAgent,
  onOpenRole,
  onOpenLogsWindow,
  onOpenPromptingSettings,
  onToggleLocalNotificationsEnabled,
  onRefreshSystemNotificationPermission,
  onRequestSystemNotificationPermission,
  onSendTestSystemNotification,
  onRefreshLogs,
  onToggleIncludeRelatedSessionSnapshot,
  onExportLogs,
  onClearLogs,
}: GeneralPanelProps) {
  const selectedTheme = availableThemes.find((theme) => theme.id === selectedThemeId) ?? availableThemes[0] ?? null;
  const showRemoteWebPushStatus = remoteWebPushState.status !== "unsupported"
    || (remoteWebPushState.detail != null
      && remoteWebPushState.detail !== "Background web push is available only in the hosted Orchestra browser session.");

  const entityLookup = useMemo(
    () => buildEntityReferenceLookup({ sessions: referenceSessions, agents: referenceAgents, roles: referenceRoles }),
    [referenceAgents, referenceRoles, referenceSessions],
  );
  const getTooltipProps = useExplanatoryTooltipProps();
  return (
    <SettingsSectionTabs
      className="panel general-panel"
      ariaLabel="General settings sections"
      dataRolePrefix="general-detail"
      initialTabId="appearance"
      header={(
        <div className="panel__header panel__header--stacked general-panel__header">
          <div className="general-panel__version-card" data-role="general-version-display">
            <p className="eyebrow">Orchestra version</p>
            <p className="general-panel__version-value" data-role="general-version-value">
              {orchestraVersionDisplay ?? "Loading…"}
            </p>
          </div>
          <div>
            <p className="eyebrow">General settings</p>
            <h3>Client preferences and diagnostics</h3>
            <p className="supporting-copy">Use the floating dock to move between appearance, notifications, diagnostics, and logs.</p>
          </div>
        </div>
      )}
      tabs={[
        {
          id: "appearance",
          label: "Appearance",
          panel: (
            <>
              <section className="task-section task-section--compact" data-role="theme-selection-panel">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Appearance</p>
                    <h3>Theme</h3>
                    <p className="supporting-copy">Choose the default workbench theme.</p>
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
                <p className="supporting-copy">Hover supported controls to see brief help.</p>
              </section>

              <section className="task-section task-section--compact" data-role="general-prompting-moved-notice">
                <div className="task-section__header">
                  <div>
                    <p className="eyebrow">Prompting</p>
                    <h4>Prompt settings moved</h4>
                    <p className="supporting-copy">Task session prompts now live in Settings → Prompting.</p>
                  </div>
                  <button className="secondary-button" data-role="open-prompting-settings" type="button" onClick={onOpenPromptingSettings}>
                    Open Prompting
                  </button>
                </div>
              </section>
            </>
          ),
        },
        {
          id: "notifications",
          label: "Notifications",
          hidden: !canManageSystemNotifications,
          panel: (
            <section className="task-section task-section--compact" data-role="system-notifications-panel">
              <div className="task-section__header">
                <div>
                  <p className="eyebrow">Desktop integration</p>
                  <h4>Local notifications</h4>
                  <p className="supporting-copy">Enable local browser/macOS notifications for this client, manage permission access, and, in hosted web on HTTPS/localhost, register background web push for this paired browser. Orchestra suppresses duplicate push only while that same hosted-web client is foregrounded.</p>
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
              <label className="checkbox-field task-editor-grid__full" {...getTooltipProps("Turn local browser or desktop notifications on or off for this specific Orchestra client.")}>
                <input
                  data-role="local-notifications-enabled"
                  type="checkbox"
                  checked={localNotificationsEnabled}
                  onChange={(event) => onToggleLocalNotificationsEnabled(event.target.checked)}
                />
                <span>Enable local notifications on this device</span>
              </label>
              <p className="muted-copy" data-role="system-notification-permission-state">
                Permission status: {formatNotificationPermissionLabel(systemNotificationPermission)}
              </p>
              {showRemoteWebPushStatus ? (
                <>
                  <p className="muted-copy" data-role="remote-web-push-status">
                    Background web push: {formatRemoteWebPushLabel(remoteWebPushState)}
                  </p>
                  {remoteWebPushState.detail ? (
                    <p className="muted-copy" data-role="remote-web-push-detail">{remoteWebPushState.detail}</p>
                  ) : null}
                </>
              ) : null}
              {systemNotificationEnvironment?.appBundlePath ? (
                <p className="muted-copy" data-role="system-notification-bundle-path">App bundle: {systemNotificationEnvironment.appBundlePath}</p>
              ) : null}
              {systemNotificationEnvironment?.reason ? (
                <p className="muted-copy" data-role="system-notification-environment-reason">{systemNotificationEnvironment.reason}</p>
              ) : systemNotificationPermission === "unsupported" ? (
                <p className="supporting-copy">This client cannot deliver local notifications in the current environment.</p>
              ) : localNotificationsEnabled ? (
                <p className="supporting-copy">If Orchestra is missing from Notification Center or browser prompts were dismissed, refresh the status, request permission again, and send a test notification. Background web push additionally requires a secure origin (HTTPS or localhost); some mobile browsers may also require an installed web app context. When this client moves to the background, Orchestra should fall back to Web Push instead of suppressing it as an active live client.</p>
              ) : (
                <p className="supporting-copy">Local notifications are disabled for this client until you turn them back on here.</p>
              )}
            </section>
          ),
        },
        {
          id: "bridge",
          label: "Bridge",
          hidden: !canManageBridgeDiagnostics,
          panel: (
            <>
              <div className="panel__header panel__header--stacked">
                <div>
                  <p className="eyebrow">General</p>
                  <h3>Bridge diagnostics</h3>
                  <p className="supporting-copy">See bridge health, active clients, recent requests, and cleanup activity.</p>
                </div>

                <div className="action-cluster action-cluster--wrap">
                  {canOpenLogsWindow ? (
                    <button className="secondary-button" type="button" onClick={onOpenLogsWindow}>
                      Open logs window
                    </button>
                  ) : null}
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
                                  <td>
                                    <SessionReferenceLink
                                      lookup={entityLookup.sessions}
                                      onOpenSession={onOpenSession}
                                      rawIdMode="secondary"
                                      sessionId={client.sessionId ?? null}
                                      sessionTitle={client.sessionTitle ?? null}
                                    />
                                  </td>
                                  <td>
                                    {client.actorType === "agent" && client.actorId ? (
                                      <AgentReferenceLink
                                        agentId={client.actorId}
                                        agentName={client.actorLabel ?? null}
                                        lookup={entityLookup.agents}
                                        onOpenAgent={onOpenAgent}
                                        rawIdMode="secondary"
                                      />
                                    ) : client.actorType === "role" && client.actorId ? (
                                      <RoleReferenceLink
                                        lookup={entityLookup.roles}
                                        onOpenRole={onOpenRole}
                                        rawIdMode="secondary"
                                        roleId={client.actorId}
                                        roleName={client.actorLabel ?? null}
                                      />
                                    ) : "—"}
                                  </td>
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
                                  <td>
                                    <SessionReferenceLink
                                      lookup={entityLookup.sessions}
                                      onOpenSession={onOpenSession}
                                      rawIdMode="secondary"
                                      sessionId={request.sessionId ?? null}
                                      sessionTitle={request.sessionTitle ?? null}
                                    />
                                  </td>
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
            </>
          ),
        },
        {
          id: "logs",
          label: "Logs",
          hidden: !canManageRuntimeLogs,
          panel: (
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
          ),
        },
      ]}
    />
  );
}
