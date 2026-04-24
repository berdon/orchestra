import type { ReactNode } from "react";

import type { OrchestraConnectionSnapshot } from "../lib/orchestraClient";

interface ConnectionStatusBannerProps {
  connection: OrchestraConnectionSnapshot;
  onRetry?: (() => void) | null;
  retryLabel?: string;
  actions?: ReactNode;
  dataRole?: string;
}

export function ConnectionStatusBanner({
  connection,
  onRetry = null,
  retryLabel = "Retry now",
  actions,
  dataRole = "connection-status-banner",
}: ConnectionStatusBannerProps) {
  if (connection.hostState === "online" && !connection.degraded) {
    return null;
  }

  let title = "Connection issue";
  let message = "Orchestra connectivity is degraded.";

  if (connection.hostState === "offline") {
    title = "Offline";
    message = "Orchestra is offline right now. Cached content may be stale until connectivity returns.";
  } else if (connection.liveState === "reconnecting") {
    title = "Reconnecting live updates";
    message = connection.retryAttempt > 0
      ? `Realtime updates are reconnecting now. Attempt ${connection.retryAttempt}. Cached content may lag behind live activity.`
      : "Realtime updates are reconnecting now. Cached content may lag behind live activity.";
  } else if (connection.liveState === "disconnected") {
    title = "Live updates disconnected";
    message = "Realtime updates are disconnected. Existing data stays visible, but new activity may not appear until you reconnect.";
  }

  return (
    <div className="session-readonly-banner app-status-banner" data-role={dataRole}>
      <div>
        <strong>{title}.</strong> {message}
      </div>
      <div className="action-cluster action-cluster--wrap">
        {onRetry ? (
          <button className="secondary-button" type="button" onClick={onRetry}>
            {retryLabel}
          </button>
        ) : null}
        {actions}
      </div>
    </div>
  );
}
