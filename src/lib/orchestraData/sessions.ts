import { useEffect } from "react";

import { useOrchestraEventSubscription } from "./events";

interface UseSessionEventRefreshOptions {
  disabled?: boolean;
  hasSession: (sessionId: string) => boolean;
  onSessionStream: (sessionId: string, event: { sessionId: string; runId?: string | null; event: unknown; receivedAt: string }) => void;
  requestRefresh: () => void;
}

export function useSessionEventRefresh({
  disabled = false,
  hasSession,
  onSessionStream,
  requestRefresh,
}: UseSessionEventRefreshOptions) {
  useOrchestraEventSubscription((event) => {
    if (event.kind === "session.stream") {
      onSessionStream(event.sessionId, event);
      if (!hasSession(event.sessionId)) {
        requestRefresh();
      }
      return;
    }

    if (event.kind === "session.change") {
      requestRefresh();
    }
  }, { disabled });
}

interface UseSessionPollingRefreshOptions {
  disabled?: boolean;
  active: boolean;
  refresh: () => void;
}

export function useSessionPollingRefresh({ disabled = false, active, refresh }: UseSessionPollingRefreshOptions) {
  useEffect(() => {
    if (disabled || !active) {
      return;
    }

    refresh();

    const intervalId = window.setInterval(refresh, 15000);
    window.addEventListener("focus", refresh);

    return () => {
      window.clearInterval(intervalId);
      window.removeEventListener("focus", refresh);
    };
  }, [active, disabled, refresh]);
}
