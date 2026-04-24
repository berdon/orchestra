import type { NotificationAction, NotificationIntent } from "../types";
import type { OrchestraLocalNotificationsExtension } from "./orchestraClient/extensions";

export const LOCAL_NOTIFICATIONS_ENABLED_STORAGE_KEY = "orchestra.preferences.local-notifications-enabled";

export function loadStoredLocalNotificationsEnabled() {
  if (typeof window === "undefined") {
    return true;
  }
  const stored = window.localStorage.getItem(LOCAL_NOTIFICATIONS_ENABLED_STORAGE_KEY);
  return stored !== "disabled";
}

export function storeLocalNotificationsEnabled(enabled: boolean) {
  if (typeof window === "undefined") {
    return;
  }
  window.localStorage.setItem(LOCAL_NOTIFICATIONS_ENABLED_STORAGE_KEY, enabled ? "enabled" : "disabled");
}

export function resolveNotificationClickHandler(action?: NotificationAction | null) {
  if (typeof window === "undefined") {
    return undefined;
  }

  return () => {
    window.focus();
    if (!action) {
      return;
    }

    const url = new URL(window.location.href);
    switch (action.type) {
      case "open_inbox":
        url.searchParams.set("page", "inbox");
        break;
      case "open_task":
        url.searchParams.set("page", "tasks");
        if (action.taskId) {
          url.searchParams.set("selectedTaskId", action.taskId);
        }
        break;
    }
    window.history.replaceState(window.history.state, "", `${url.pathname}?${url.searchParams.toString()}${url.hash}`);
  };
}

export async function deliverNotificationIntent(
  notifications: OrchestraLocalNotificationsExtension,
  intent: NotificationIntent,
  enabled: boolean,
) {
  if (!enabled) {
    return false;
  }

  return notifications.deliver({
    title: intent.title,
    body: intent.body,
    tag: intent.tag,
    onClick: resolveNotificationClickHandler(intent.action),
  });
}
