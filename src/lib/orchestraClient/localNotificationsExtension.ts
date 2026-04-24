import {
  deliverSystemNotification,
  getSystemNotificationEnvironmentStatus,
  getSystemNotificationPermissionState,
  requestSystemNotificationPermission,
  sendSystemNotification,
  sendTestSystemNotification,
} from "../systemNotifications";
import type { OrchestraLocalNotificationsExtension } from "./extensions";

export function createLocalNotificationsExtension(): OrchestraLocalNotificationsExtension {
  return {
    getEnvironmentStatus: getSystemNotificationEnvironmentStatus,
    getPermissionState: getSystemNotificationPermissionState,
    requestPermission: requestSystemNotificationPermission,
    send: sendSystemNotification,
    deliver: deliverSystemNotification,
    sendTest: sendTestSystemNotification,
  };
}
