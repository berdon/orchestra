import { isTauriAvailable } from "./tauri";

export interface SystemNotificationInput {
  title: string;
  body: string;
  tag?: string;
}

interface SystemNotificationTestDriver {
  permission?: NotificationPermission;
  requestPermission?: () => Promise<NotificationPermission>;
  notify?: (input: SystemNotificationInput) => Promise<void> | void;
}

declare global {
  interface Window {
    __orchestraTestNotifications?: Array<SystemNotificationInput & { issuedAt: string }>;
    __orchestraNotificationTestDriver?: SystemNotificationTestDriver;
  }
}

let permissionRequest: Promise<NotificationPermission> | null = null;
let nativeNotificationModulePromise: Promise<typeof import("@tauri-apps/plugin-notification")> | null = null;

function recordNotificationForTests(input: SystemNotificationInput) {
  if (typeof window === "undefined") {
    return;
  }
  window.__orchestraTestNotifications = [
    ...(window.__orchestraTestNotifications ?? []),
    {
      ...input,
      issuedAt: new Date().toISOString(),
    },
  ];
}

function getTestDriver() {
  if (typeof window === "undefined") {
    return null;
  }
  return window.__orchestraNotificationTestDriver ?? null;
}

async function ensureWebNotificationPermission() {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "denied" as const;
  }
  if (window.Notification.permission !== "default") {
    return window.Notification.permission;
  }
  if (!permissionRequest) {
    permissionRequest = window.Notification.requestPermission().finally(() => {
      permissionRequest = null;
    });
  }
  return permissionRequest;
}

async function loadNativeNotificationModule() {
  if (!nativeNotificationModulePromise) {
    nativeNotificationModulePromise = import("@tauri-apps/plugin-notification");
  }
  return nativeNotificationModulePromise;
}

async function ensureNativeNotificationPermission() {
  const { isPermissionGranted, requestPermission } = await loadNativeNotificationModule();
  if (await isPermissionGranted()) {
    return "granted" as const;
  }
  return await requestPermission();
}

export async function sendSystemNotification(input: SystemNotificationInput) {
  recordNotificationForTests(input);

  const testDriver = getTestDriver();
  if (testDriver) {
    const permission = testDriver.permission
      ?? (testDriver.requestPermission ? await testDriver.requestPermission() : "granted");
    if (permission !== "granted") {
      return false;
    }
    await testDriver.notify?.(input);
    return true;
  }

  if (isTauriAvailable()) {
    try {
      const permission = await ensureNativeNotificationPermission();
      if (permission !== "granted") {
        return false;
      }

      const { sendNotification } = await loadNativeNotificationModule();
      await sendNotification({
        title: input.title,
        body: input.body,
      });
      return true;
    } catch {
      // Fall through to the web Notification API if the native path is unavailable.
    }
  }

  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return false;
  }

  const permission = await ensureWebNotificationPermission();
  if (permission !== "granted") {
    return false;
  }

  const notification = new window.Notification(input.title, {
    body: input.body,
    tag: input.tag,
  });
  notification.onclick = () => {
    window.focus();
  };
  return true;
}
