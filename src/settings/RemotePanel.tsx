import { useEffect, useMemo, useState } from "react";

import { reportClientError } from "../lib/tauri";
import { createRemotePairingCode, getRemoteAccessStatus, revokeRemoteDevice, updateRemoteAccessSettings } from "../lib/remote";
import type { RemoteAccessStatus } from "../types";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

export function RemotePanel() {
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingPairingCode, setCreatingPairingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [lastCreatedCode, setLastCreatedCode] = useState<string | null>(null);
  const [bindHostDraft, setBindHostDraft] = useState("0.0.0.0");
  const [portDraft, setPortDraft] = useState("49500");
  const [enabledDraft, setEnabledDraft] = useState(false);

  const activePairingCodes = useMemo(
    () => status?.pairingCodes.filter((code) => !code.consumedAt) ?? [],
    [status?.pairingCodes],
  );

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      const nextStatus = await getRemoteAccessStatus();
      setStatus(nextStatus);
      setBindHostDraft(nextStatus.settings.bindHost);
      setPortDraft(String(nextStatus.settings.port));
      setEnabledDraft(nextStatus.settings.enabled);
    } catch (nextError) {
      setError(await reportClientError("ui.remote.status", nextError, "Unable to load remote access status."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, []);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      const parsedPort = Number.parseInt(portDraft, 10);
      const nextStatus = await updateRemoteAccessSettings({
        enabled: enabledDraft,
        bindHost: bindHostDraft,
        port: Number.isFinite(parsedPort) ? parsedPort : 49500,
      });
      setStatus(nextStatus);
    } catch (nextError) {
      setError(await reportClientError("ui.remote.settings.save", nextError, "Unable to save remote access settings."));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreatePairingCode() {
    setCreatingPairingCode(true);
    setError(null);
    try {
      const pairingCode = await createRemotePairingCode();
      setLastCreatedCode(pairingCode.code ?? pairingCode.displayCode);
      await loadStatus();
    } catch (nextError) {
      setError(await reportClientError("ui.remote.pairing.create", nextError, "Unable to create pairing code."));
    } finally {
      setCreatingPairingCode(false);
    }
  }

  async function handleRevokeDevice(deviceId: string) {
    setSaving(true);
    setError(null);
    try {
      await revokeRemoteDevice(deviceId);
      await loadStatus();
    } catch (nextError) {
      setError(await reportClientError("ui.remote.device.revoke", nextError, "Unable to revoke remote device."));
    } finally {
      setSaving(false);
    }
  }

  return (
    <section className="task-shell">
      <aside className="task-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Remote access</p>
            <h3>Mobile driver</h3>
            <p className="muted-copy">Enable Orchestra's host-side remote driver API, generate pairing codes, and manage trusted mobile devices.</p>
          </div>
          <div className="action-cluster action-cluster--wrap">
            <button className="secondary-button" type="button" onClick={() => void loadStatus()}>
              Refresh
            </button>
            <button className="primary-button" data-role="save-remote-settings" type="button" onClick={() => void handleSave()} disabled={saving}>
              {saving ? "Saving…" : "Save settings"}
            </button>
          </div>
        </div>

        {loading ? <p className="muted-copy">Loading remote access status…</p> : null}
        {error ? <p className="error-copy">{error}</p> : null}

        <div className="task-section-list">
          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Server</p>
                <h4>Remote API host</h4>
              </div>
            </div>
            <label className="field-group">
              <span className="field-group__label">Remote access enabled</span>
              <label className="checkbox-row">
                <input type="checkbox" data-role="remote-enabled" checked={enabledDraft} onChange={(event) => setEnabledDraft(event.target.checked)} />
                <span>Start the Orchestra remote driver API so Android/iOS devices can pair and connect.</span>
              </label>
            </label>
            <label className="field-group">
              <span className="field-group__label">Bind host</span>
              <input className="text-input" data-role="remote-bind-host" value={bindHostDraft} onChange={(event) => setBindHostDraft(event.target.value)} />
            </label>
            <label className="field-group">
              <span className="field-group__label">Port</span>
              <input className="text-input" data-role="remote-port" value={portDraft} onChange={(event) => setPortDraft(event.target.value)} />
            </label>
            <div className="workforce-meta-grid muted-copy">
              <span>Local URL: {status?.settings.baseUrl ?? "—"}</span>
              <span>LAN URL: {status?.settings.lanBaseUrl ?? "—"}</span>
              <span>WebSocket: {status?.settings.websocketUrl ?? "—"}</span>
              <span>Started: {formatDateTime(status?.settings.startedAt)}</span>
            </div>
            {status?.settings.lastError ? <p className="error-copy">{status.settings.lastError}</p> : null}
          </section>

          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Pairing</p>
                <h4>One-time device codes</h4>
              </div>
              <button className="secondary-button" data-role="create-remote-pairing-code" type="button" onClick={() => void handleCreatePairingCode()} disabled={creatingPairingCode}>
                {creatingPairingCode ? "Creating…" : "Create pairing code"}
              </button>
            </div>
            {lastCreatedCode ? <p className="success-copy" data-role="latest-remote-pairing-code">Latest code: <strong>{lastCreatedCode}</strong></p> : null}
            {activePairingCodes.length ? (
              <div className="bridge-diagnostics-table-wrap">
                <table className="task-table" data-role="remote-pairing-codes-table">
                  <thead>
                    <tr>
                      <th>Code</th>
                      <th>Created</th>
                      <th>Expires</th>
                    </tr>
                  </thead>
                  <tbody>
                    {activePairingCodes.map((code) => (
                      <tr key={code.id}>
                        <td>{code.code ?? code.displayCode}</td>
                        <td>{formatDateTime(code.createdAt)}</td>
                        <td>{formatDateTime(code.expiresAt)}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted-copy">No active pairing codes.</p>}
          </section>

          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Devices</p>
                <h4>Trusted remote devices</h4>
              </div>
            </div>
            {status?.devices.length ? (
              <div className="bridge-diagnostics-table-wrap">
                <table className="task-table" data-role="remote-devices-table">
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Platform</th>
                      <th>Last seen</th>
                      <th>Clients</th>
                      <th>State</th>
                      <th />
                    </tr>
                  </thead>
                  <tbody>
                    {status.devices.map((device) => (
                      <tr key={device.id}>
                        <td>{device.label}</td>
                        <td>{device.platform}</td>
                        <td>{formatDateTime(device.lastSeenAt)}</td>
                        <td>{device.activeClientCount}</td>
                        <td>{device.revokedAt ? `Revoked ${formatDateTime(device.revokedAt)}` : "Trusted"}</td>
                        <td>
                          {!device.revokedAt ? (
                            <button className="secondary-button secondary-button--danger" type="button" onClick={() => void handleRevokeDevice(device.id)}>
                              Revoke
                            </button>
                          ) : null}
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted-copy">No paired devices yet.</p>}
          </section>

          <section className="task-section task-section--compact">
            <div className="task-section__header">
              <div>
                <p className="eyebrow">Clients</p>
                <h4>Active remote connections</h4>
              </div>
            </div>
            {status?.activeClients.length ? (
              <div className="bridge-diagnostics-table-wrap">
                <table className="task-table" data-role="remote-clients-table">
                  <thead>
                    <tr>
                      <th>Device</th>
                      <th>Connected</th>
                      <th>Last seen</th>
                      <th>Project</th>
                      <th>Session subs</th>
                    </tr>
                  </thead>
                  <tbody>
                    {status.activeClients.map((client) => (
                      <tr key={client.clientId}>
                        <td>{client.deviceLabel ?? client.clientId}</td>
                        <td>{formatDateTime(client.connectedAt)}</td>
                        <td>{formatDateTime(client.lastSeenAt)}</td>
                        <td>{client.activeProjectId ?? "—"}</td>
                        <td>{client.subscribedSessionCount}</td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            ) : <p className="muted-copy">No active remote clients.</p>}
          </section>
        </div>
      </aside>

      <section className="panel-stack">
        <section className="panel">
          <div className="panel__header panel__header--stacked">
            <div>
              <p className="eyebrow">How to connect</p>
              <h3>Android / iOS pairing flow</h3>
            </div>
          </div>
          <ol className="muted-copy remote-panel__steps">
            <li>Enable remote access and save the server settings.</li>
            <li>Create a pairing code.</li>
            <li>Open the Orchestra mobile app and enter the LAN URL plus the pairing code.</li>
            <li>The device becomes trusted and can use the remote driver API over HTTP + WebSocket.</li>
          </ol>
        </section>
      </section>
    </section>
  );
}
