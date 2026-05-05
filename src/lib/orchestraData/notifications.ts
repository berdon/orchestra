import { useEffect, useRef, useState } from "react";

import { deliverNotificationIntent } from "../localNotifications";
import { syncRemoteWebPushRegistration, type RemoteWebPushState } from "../webPush";
import { useOrchestraEventSubscription } from "./events";
import type { OrchestraClientBootstrap } from "../orchestraClient";
import type { OrchestraLocalNotificationsExtension } from "../orchestraClient/extensions";
import type { SystemNotificationPermissionState } from "../../types";

interface UseNotificationControllerOptions {
  disabled?: boolean;
  enabled: boolean;
  notifications?: OrchestraLocalNotificationsExtension;
}

export function useNotificationController({ disabled, enabled, notifications }: UseNotificationControllerOptions) {
  const deliveredIntentIdsRef = useRef(new Set<string>());

  useEffect(() => {
    if (!enabled) {
      deliveredIntentIdsRef.current.clear();
    }
  }, [enabled]);

  useOrchestraEventSubscription((event) => {
    if (disabled || !enabled || !notifications || event.kind !== "notification.intent") {
      return;
    }

    if (deliveredIntentIdsRef.current.has(event.id)) {
      return;
    }
    deliveredIntentIdsRef.current.add(event.id);

    void deliverNotificationIntent(notifications, event, enabled).catch(() => {
      deliveredIntentIdsRef.current.delete(event.id);
    });
  }, { disabled: disabled || !notifications });
}

export function useRemoteWebPushController({
  bootstrap,
  enabled,
  notifications,
  permissionState,
}: {
  bootstrap: OrchestraClientBootstrap;
  enabled: boolean;
  notifications?: OrchestraLocalNotificationsExtension;
  permissionState: SystemNotificationPermissionState;
}) {
  const [state, setState] = useState<RemoteWebPushState>({
    status: "unsupported",
    detail: null,
  });

  useEffect(() => {
    if (!notifications) {
      setState({ status: "unsupported", detail: null });
      return;
    }

    let cancelled = false;
    const sync = async () => {
      try {
        const nextState = await syncRemoteWebPushRegistration({
          bootstrap,
          notifications,
          enabled,
        });
        if (!cancelled) {
          setState(nextState);
        }
      } catch (error) {
        if (!cancelled) {
          setState({
            status: "error",
            detail: error instanceof Error ? error.message : "Unable to sync remote web push registration.",
          });
        }
      }
    };

    void sync();
    const onFocus = () => {
      void sync();
    };
    window.addEventListener("focus", onFocus);
    return () => {
      cancelled = true;
      window.removeEventListener("focus", onFocus);
    };
  }, [bootstrap, enabled, notifications, permissionState]);

  return state;
}
