export interface SystemNotificationInput {
  title: string;
  body: string;
  tag?: string;
}

declare global {
  interface Window {
    __orchestraTestNotifications?: Array<SystemNotificationInput & { issuedAt: string }>;
  }
}

let permissionRequest: Promise<NotificationPermission> | null = null;

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

async function ensureNotificationPermission() {
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

export async function sendSystemNotification(input: SystemNotificationInput) {
  recordNotificationForTests(input);

  if (typeof window === "undefined" || typeof window.Notification === "undefined") {
    return false;
  }

  const permission = await ensureNotificationPermission();
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
