import { useEffect, useRef } from "react";

import { deliverNotificationIntent } from "../localNotifications";
import { useOrchestraEventSubscription } from "./events";
import type { OrchestraLocalNotificationsExtension } from "../orchestraClient/extensions";

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
