import type { ReactNode } from "react";

import type { OrchestraConnectionSnapshot } from "../lib/orchestraClient";
import type { UiErrorState } from "../lib/orchestraData/errors";
import { ConnectionStatusBanner } from "./ConnectionStatusBanner";

interface ResourceStatusBannerProps {
  connection: OrchestraConnectionSnapshot;
  error?: UiErrorState | null;
  hasData?: boolean;
  refreshing?: boolean;
  onRetry?: (() => void) | null;
  retryLabel?: string;
  refreshingLabel?: string;
  dataRolePrefix?: string;
  actions?: ReactNode;
}

export function ResourceStatusBanner({
  connection,
  error = null,
  hasData = false,
  refreshing = false,
  onRetry = null,
  retryLabel = "Retry",
  refreshingLabel = "Refreshing…",
  dataRolePrefix = "resource-status",
  actions,
}: ResourceStatusBannerProps) {
  return (
    <>
      <ConnectionStatusBanner
        connection={connection}
        onRetry={onRetry}
        retryLabel={retryLabel}
        dataRole={`${dataRolePrefix}-connection`}
      />
      {error ? (
        <div className="session-readonly-banner app-status-banner" data-role={`${dataRolePrefix}-error`}>
          <div>
            <strong>{error.title}.</strong> {error.message}
            {hasData && error.retryable ? " Showing the last loaded data while you retry." : ""}
            {error.detail ? <div className="muted-copy">{error.detail}</div> : null}
          </div>
          <div className="action-cluster action-cluster--wrap">
            {error.retryable && onRetry ? (
              <button className="secondary-button" type="button" onClick={onRetry}>
                {retryLabel}
              </button>
            ) : null}
            {actions}
          </div>
        </div>
      ) : null}
      {refreshing && !error ? (
        <div className="visually-hidden" role="status" aria-live="polite" data-role={`${dataRolePrefix}-refreshing-live`}>
          {refreshingLabel}
        </div>
      ) : null}
    </>
  );
}
