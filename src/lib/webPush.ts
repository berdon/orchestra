import type { RemoteWebPushConfig, SystemNotificationPermissionState } from "../types";
import type { OrchestraClientBootstrap } from "./orchestraClient";
import type { OrchestraLocalNotificationsExtension } from "./orchestraClient/extensions";

export type RemoteWebPushStatus =
  | "unsupported"
  | "disabled"
  | "permission_required"
  | "subscribed"
  | "error";

export interface RemoteWebPushState {
  status: RemoteWebPushStatus;
  detail?: string | null;
}

const REMOTE_WEB_PUSH_CONFIG_PATH = "/api/v1/devices/push-config";
const REMOTE_WEB_PUSH_TOKEN_PATH = "/api/v1/devices/push-token";
const SERVICE_WORKER_PATH = "/orchestra-sw.js";
const ALLOWED_NOTIFICATION_PERMISSIONS: SystemNotificationPermissionState[] = [
  "granted",
  "provisional",
  "ephemeral",
];

function buildRemoteApiUrl(baseUrl: string | null | undefined, path: string) {
  if (baseUrl) {
    return new URL(path, baseUrl.endsWith("/") ? baseUrl : `${baseUrl}/`).toString();
  }
  if (typeof window !== "undefined") {
    return new URL(path, window.location.origin).toString();
  }
  return path;
}

export function supportsRemoteWebPushSession(bootstrap: OrchestraClientBootstrap) {
  return bootstrap.hostKind === "remote_api" && bootstrap.authMode === "same_origin_cookie";
}

export function supportsRemoteWebPushBrowser() {
  return typeof window !== "undefined"
    && typeof navigator !== "undefined"
    && Boolean(window.isSecureContext)
    && "Notification" in window
    && "serviceWorker" in navigator
    && "PushManager" in window;
}

export function base64UrlToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = (value + padding).replace(/-/g, "+").replace(/_/g, "/");
  const raw = window.atob(base64);
  return Uint8Array.from(raw, (character) => character.charCodeAt(0));
}

export function serializeStoredWebPushSubscription(subscription: Pick<PushSubscription, "toJSON">) {
  return JSON.stringify({
    kind: "web_push",
    subscription: subscription.toJSON(),
  });
}

async function fetchRemoteWebPushConfig(apiBaseUrl: string | null | undefined) {
  const response = await fetch(buildRemoteApiUrl(apiBaseUrl, REMOTE_WEB_PUSH_CONFIG_PATH), {
    credentials: "include",
  });
  if (!response.ok) {
    throw new Error(`Unable to load remote web push config (${response.status}).`);
  }
  return response.json() as Promise<RemoteWebPushConfig>;
}

async function postRemotePushToken(apiBaseUrl: string | null | undefined, pushToken: string | null) {
  const response = await fetch(buildRemoteApiUrl(apiBaseUrl, REMOTE_WEB_PUSH_TOKEN_PATH), {
    method: "POST",
    credentials: "include",
    headers: {
      "content-type": "application/json",
    },
    body: JSON.stringify({ pushToken }),
  });
  if (!response.ok) {
    throw new Error(`Unable to update remote web push subscription (${response.status}).`);
  }
}

async function loadExistingSubscription() {
  if (typeof navigator === "undefined" || !("serviceWorker" in navigator)) {
    return null;
  }
  const registration = await navigator.serviceWorker.getRegistration();
  if (!registration) {
    return null;
  }
  return registration.pushManager.getSubscription();
}

async function clearRemoteWebPushRegistration(apiBaseUrl: string | null | undefined) {
  const existingSubscription = await loadExistingSubscription();
  if (existingSubscription) {
    try {
      await existingSubscription.unsubscribe();
    } catch {
      // best effort cleanup
    }
  }
  await postRemotePushToken(apiBaseUrl, null);
}

function unsupportedState(detail: string): RemoteWebPushState {
  return { status: "unsupported", detail };
}

export async function syncRemoteWebPushRegistration({
  bootstrap,
  notifications,
  enabled,
}: {
  bootstrap: OrchestraClientBootstrap;
  notifications: OrchestraLocalNotificationsExtension;
  enabled: boolean;
}): Promise<RemoteWebPushState> {
  if (!supportsRemoteWebPushSession(bootstrap)) {
    return unsupportedState("Background web push is available only in the hosted Orchestra browser session.");
  }

  if (!supportsRemoteWebPushBrowser()) {
    return unsupportedState(
      typeof window !== "undefined" && !window.isSecureContext
        ? "Background web push requires HTTPS or localhost because browsers do not allow push on insecure origins."
        : "This browser does not support service-worker web push.",
    );
  }

  const apiBaseUrl = bootstrap.urls.apiBaseUrl;
  if (!enabled) {
    await clearRemoteWebPushRegistration(apiBaseUrl);
    return {
      status: "disabled",
      detail: "Background web push is disabled on this browser because local notifications are turned off.",
    };
  }

  const permissionState = await notifications.getPermissionState();
  if (!ALLOWED_NOTIFICATION_PERMISSIONS.includes(permissionState)) {
    await clearRemoteWebPushRegistration(apiBaseUrl);
    return {
      status: "permission_required",
      detail: permissionState === "denied"
        ? "Browser notification permission is denied on this device."
        : "Grant browser notification permission to enable background web push on this device.",
    };
  }

  const config = await fetchRemoteWebPushConfig(apiBaseUrl);
  if (!config.supported || !config.vapidPublicKey) {
    return unsupportedState("The Orchestra host does not currently expose a usable web push configuration.");
  }

  const registration = await navigator.serviceWorker.register(SERVICE_WORKER_PATH);
  let subscription = await registration.pushManager.getSubscription();
  if (!subscription) {
    subscription = await registration.pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey: base64UrlToUint8Array(config.vapidPublicKey),
    });
  }

  await postRemotePushToken(
    apiBaseUrl,
    serializeStoredWebPushSubscription(subscription),
  );
  return {
    status: "subscribed",
    detail: "Background web push is subscribed on this browser.",
  };
}
