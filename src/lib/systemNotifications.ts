import { invoke } from "@tauri-apps/api/core";

import { isTauriAvailable } from "./tauri";
import type {
  SystemNotificationEnvironmentStatus,
  SystemNotificationPermissionState,
} from "../types";

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

interface NativeNotificationModule {
  isPermissionGranted: () => Promise<boolean>;
  requestPermission: () => Promise<NotificationPermission>;
  sendNotification: (input: { title: string; body?: string }) => Promise<void>;
}

declare global {
  interface Window {
    __orchestraTestNotifications?: Array<SystemNotificationInput & { issuedAt: string }>;
    __orchestraNotificationTestDriver?: SystemNotificationTestDriver;
  }
}

let permissionRequest: Promise<NotificationPermission> | null = null;
let nativeNotificationModulePromise: Promise<NativeNotificationModule> | null = null;

function mapWebPermission(permission: NotificationPermission): SystemNotificationPermissionState {
  switch (permission) {
    case "granted":
      return "granted";
    case "denied":
      return "denied";
    default:
      return "not_determined";
  }
}

function unsupportedEnvironmentStatus(reason?: string): SystemNotificationEnvironmentStatus {
  return {
    platform: typeof navigator !== "undefined" ? navigator.platform : "unknown",
    nativeSupported: false,
    reason: reason ?? "Native Orchestra notifications are unavailable in this environment.",
    appBundlePath: null,
  };
}

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

async function ensureWebNotificationPermission(): Promise<NotificationPermission> {
  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return "denied";
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

async function loadPluginNotificationModule() {
  if (!nativeNotificationModulePromise) {
    const specifier = "@tauri-apps/plugin-notification";
    nativeNotificationModulePromise = import(/* @vite-ignore */ specifier) as Promise<NativeNotificationModule>;
  }
  return nativeNotificationModulePromise;
}

async function ensurePluginNotificationPermission(): Promise<NotificationPermission> {
  const { isPermissionGranted, requestPermission } = await loadPluginNotificationModule();
  if (await isPermissionGranted()) {
    return "granted";
  }
  return await requestPermission();
}

export async function getSystemNotificationEnvironmentStatus(): Promise<SystemNotificationEnvironmentStatus> {
  if (!isTauriAvailable()) {
    if (typeof window === "undefined" || typeof window.Notification === "undefined") {
      return unsupportedEnvironmentStatus();
    }
    return {
      platform: "browser",
      nativeSupported: false,
      reason: "Browser and web test runs use the Web Notification API instead of Orchestra's native macOS notification bridge.",
      appBundlePath: null,
    };
  }

  try {
    return await invoke<SystemNotificationEnvironmentStatus>("get_system_notification_environment_status");
  } catch {
    return unsupportedEnvironmentStatus();
  }
}

async function getDesktopPermissionState(): Promise<SystemNotificationPermissionState> {
  if (!isTauriAvailable()) {
    if (typeof window === "undefined" || typeof window.Notification === "undefined") {
      return "unsupported";
    }
    return mapWebPermission(window.Notification.permission);
  }

  try {
    return await invoke<SystemNotificationPermissionState>("get_system_notification_permission_state");
  } catch {
    return "unsupported";
  }
}

export async function getSystemNotificationPermissionState(): Promise<SystemNotificationPermissionState> {
  const testDriver = getTestDriver();
  if (testDriver) {
    return mapWebPermission(testDriver.permission ?? "default");
  }
  return getDesktopPermissionState();
}

export async function requestSystemNotificationPermission(): Promise<SystemNotificationPermissionState> {
  const testDriver = getTestDriver();
  if (testDriver) {
    const permission = testDriver.requestPermission
      ? await testDriver.requestPermission()
      : (testDriver.permission ?? "granted");
    return mapWebPermission(permission);
  }

  if (isTauriAvailable()) {
    try {
      return await invoke<SystemNotificationPermissionState>("request_system_notification_permission");
    } catch {
      return "unsupported";
    }
  }

  return mapWebPermission(await ensureWebNotificationPermission());
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
      const permission = await requestSystemNotificationPermission();
      if (![("granted"), ("provisional"), ("ephemeral")].includes(permission)) {
        return false;
      }

      const delivered = await invoke<boolean>("send_system_notification", {
        request: {
          title: input.title,
          body: input.body,
          tag: input.tag ?? null,
        },
      });
      return delivered;
    } catch {
      return false;
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

export async function sendTestSystemNotification() {
  return sendSystemNotification({
    title: "Orchestra — Test notification",
    body: "Native macOS notification delivery is configured for this Orchestra desktop build.",
    tag: "system-test",
  });
}

