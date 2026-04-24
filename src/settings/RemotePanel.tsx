import { useEffect, useMemo, useState } from "react";

import { useOrchestraClient } from "../lib/orchestraClient";
import { useExplanatoryTooltipProps } from "../lib/tooltips";
import type { RemoteAccessStatus } from "../types";

function formatDateTime(value?: string | null) {
  if (!value) {
    return "—";
  }
  return new Date(value).toLocaleString();
}

async function copyTextToClipboard(text: string) {
  if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
    await navigator.clipboard.writeText(text);
    return;
  }

  if (typeof document === "undefined") {
    throw new Error("Clipboard is not available.");
  }

  const textarea = document.createElement("textarea");
  textarea.value = text;
  textarea.setAttribute("readonly", "true");
  textarea.style.position = "absolute";
  textarea.style.left = "-9999px";
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand("copy");
  document.body.removeChild(textarea);
}

export function RemotePanel() {
  const orchestraClient = useOrchestraClient();
  const remoteAccess = orchestraClient.hostAdmin?.remoteAccess;
  const [status, setStatus] = useState<RemoteAccessStatus | null>(null);
  const getTooltipProps = useExplanatoryTooltipProps();
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [creatingPairingCode, setCreatingPairingCode] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [copyStatus, setCopyStatus] = useState<string | null>(null);
  const [lastCreatedCode, setLastCreatedCode] = useState<string | null>(null);
  const [bindHostDraft, setBindHostDraft] = useState("0.0.0.0");
  const [portDraft, setPortDraft] = useState("49500");
  const [enabledDraft, setEnabledDraft] = useState(false);
  const [useTailscaleDraft, setUseTailscaleDraft] = useState(false);

  const activePairingCodes = useMemo(
    () => status?.pairingCodes.filter((code) => !code.consumedAt) ?? [],
    [status?.pairingCodes],
  );
  const endpointCards = useMemo(() => {
    const settings = status?.settings;
    if (!settings) {
      return [] as Array<{ key: string; label: string; hint: string; url?: string | null; recommended?: boolean }>;
    }

    return [
      {
        key: "pairing",
        label: "Pairing API URL",
        hint: settings.useTailscale
          ? "Enter this in the mobile app or the hosted Orchestra browser sign-in screen."
          : "Use this when pairing from the mobile app or a browser on your LAN.",
        url: settings.useTailscale ? settings.tailscaleUrl : (settings.lanBaseUrl ?? settings.baseUrl),
        recommended: true,
      },
      {
        key: "browser-app",
        label: "Hosted Orchestra web app URL",
        hint: settings.useTailscale
          ? "Open this in a browser to load the main shared Orchestra app on the same origin as the API."
          : "Open this in a browser on your LAN to load the hosted Orchestra web app.",
        url: settings.useTailscale
          ? (settings.tailscaleWebUrl ?? settings.tailscaleUrl)
          : (settings.lanBaseUrl ?? settings.webUrl ?? settings.baseUrl),
        recommended: true,
      },
      {
        key: "local-api",
        label: "Local API URL",
        hint: "Useful for local debugging on this machine.",
        url: settings.baseUrl,
      },
      {
        key: "websocket",
        label: "WebSocket URL",
        hint: "Live session and inbox updates for paired clients.",
        url: settings.websocketUrl,
      },
    ];
  }, [status?.settings]);

  async function loadStatus() {
    setLoading(true);
    setError(null);
    try {
      if (!remoteAccess) {
        setStatus(null);
        return;
      }
      const nextStatus = await remoteAccess.getStatus();
      setStatus(nextStatus);
      setBindHostDraft(nextStatus.settings.bindHost);
      setPortDraft(String(nextStatus.settings.port));
      setEnabledDraft(nextStatus.settings.enabled);
      setUseTailscaleDraft(nextStatus.settings.useTailscale);
    } catch (nextError) {
      setError(await orchestraClient.app.reportError("ui.remote.status", nextError, "Unable to load remote access status."));
    } finally {
      setLoading(false);
    }
  }

  useEffect(() => {
    void loadStatus();
  }, [remoteAccess]);

  async function handleSave() {
    setSaving(true);
    setError(null);
    try {
      if (!remoteAccess) {
        return;
      }
      const parsedPort = Number.parseInt(portDraft, 10);
      const nextStatus = await remoteAccess.updateSettings({
        enabled: enabledDraft,
        useTailscale: useTailscaleDraft,
        bindHost: bindHostDraft,
        port: Number.isFinite(parsedPort) ? parsedPort : 49500,
      });
      setStatus(nextStatus);
    } catch (nextError) {
      setError(await orchestraClient.app.reportError("ui.remote.settings.save", nextError, "Unable to save remote access settings."));
    } finally {
      setSaving(false);
    }
  }

  async function handleCreatePairingCode() {
    setCreatingPairingCode(true);
    setError(null);
    try {
      if (!remoteAccess) {
        return;
      }
      const pairingCode = await remoteAccess.createPairingCode();
      setLastCreatedCode(pairingCode.code ?? pairingCode.displayCode);
      await loadStatus();
    } catch (nextError) {
      setError(await orchestraClient.app.reportError("ui.remote.pairing.create", nextError, "Unable to create pairing code."));
    } finally {
      setCreatingPairingCode(false);
    }
  }

  async function handleRevokeDevice(deviceId: string) {
    setSaving(true);
    setError(null);
    try {
      if (!remoteAccess) {
        return;
      }
      await remoteAccess.revokeDevice(deviceId);
      await loadStatus();
    } catch (nextError) {
      setError(await orchestraClient.app.reportError("ui.remote.device.revoke", nextError, "Unable to revoke remote device."));
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyEndpoint(label: string, value?: string | null) {
    if (!value) {
      return;
    }
    try {
      await copyTextToClipboard(value);
      setCopyStatus(`${label} copied.`);
    } catch (nextError) {
      setError(await orchestraClient.app.reportError("ui.remote.endpoint.copy", nextError, `Unable to copy ${label}.`));
    }
  }

  if (!remoteAccess) {
    return (
      <section className="panel">
        <div className="empty-state">
          <p className="eyebrow">Remote access unavailable</p>
          <h3>Host administration is not available in this client</h3>
          <p>This shared frontend host does not expose local remote-access controls.</p>
        </div>
      </section>
    );
  }

  return (
    <section className="task-shell">
      <aside className="task-nav-panel">
        <div className="panel__header panel__header--stacked">
          <div>
            <p className="eyebrow">Remote access</p>
            <h3>Hosted Orchestra web app + mobile pairing</h3>
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
        {copyStatus ? <p className="success-copy" data-role="remote-copy-status">{copyStatus}</p> : null}

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
                <span>Start the Orchestra remote API so browsers and Android/iOS devices can pair and connect.</span>
              </label>
            </label>
            <label className="field-group" {...getTooltipProps("Use Tailscale Serve to expose Orchestra through a managed HTTPS endpoint.")}>
              <span className="field-group__label">Use Tailscale Serve</span>
              <label className="checkbox-row">
                <input type="checkbox" data-role="remote-use-tailscale" checked={useTailscaleDraft} onChange={(event) => setUseTailscaleDraft(event.target.checked)} />
                <span>Automatically expose the hosted Orchestra web app and API together on HTTPS port {portDraft || "49500"} via Tailscale Serve.</span>
              </label>
            </label>
            <label className="field-group" {...getTooltipProps("Choose which network interface the remote API listens on.")}>
              <span className="field-group__label">Bind host</span>
              <input className="text-input" data-role="remote-bind-host" value={useTailscaleDraft ? "127.0.0.1" : bindHostDraft} onChange={(event) => setBindHostDraft(event.target.value)} disabled={useTailscaleDraft} />
            </label>
            <label className="field-group" {...getTooltipProps("Choose which port the remote API listens on.")}>
              <span className="field-group__label">Port</span>
              <input className="text-input" data-role="remote-port" value={portDraft} onChange={(event) => setPortDraft(event.target.value)} />
            </label>
            <div className="remote-panel__endpoint-grid">
              {endpointCards.map((endpoint) => (
                <section className="remote-panel__endpoint-card" key={endpoint.key} data-role={`remote-endpoint-${endpoint.key}`}>
                  <div className="remote-panel__endpoint-header">
                    <div>
                      <p className="eyebrow">Endpoint</p>
                      <h5>{endpoint.label}</h5>
                    </div>
                    {endpoint.recommended ? <span className="status-badge status-badge--accent">Recommended</span> : null}
                  </div>
                  <p className="muted-copy">{endpoint.hint}</p>
                  <code className="remote-panel__endpoint-url">{endpoint.url ?? "—"}</code>
                  <div className="action-cluster action-cluster--wrap">
                    <button
                      className="secondary-button"
                      type="button"
                      onClick={() => void handleCopyEndpoint(endpoint.label, endpoint.url)}
                      disabled={!endpoint.url}
                      data-role={`copy-remote-endpoint-${endpoint.key}`}
                    >
                      Copy URL
                    </button>
                  </div>
                </section>
              ))}
            </div>
            <div className="workforce-meta-grid muted-copy">
              <span>Bind host: {useTailscaleDraft ? "127.0.0.1 (managed by Tailscale)" : (status?.settings.bindHost ?? "—")}</span>
              <span>Configured port: {status?.settings.port ?? "—"}</span>
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
              <h3>Browser + mobile pairing flow</h3>
            </div>
          </div>
          <ol className="muted-copy remote-panel__steps">
            <li>Enable remote access and save the server settings.</li>
            <li>Optional: turn on Tailscale Serve to expose the hosted Orchestra web app and API on the same HTTPS origin.</li>
            <li>Create a pairing code.</li>
            <li>For browser access, open the Hosted Orchestra web app URL and enter the pairing code on the sign-in screen.</li>
            <li>For Android/iOS pairing, paste the Pairing API URL into the mobile app and enter the same code there.</li>
          </ol>
        </section>
      </section>
    </section>
  );
}
