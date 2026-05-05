function buildNotificationUrl(intent) {
  const url = new URL("/", self.location.origin);
  const action = intent && typeof intent === "object" ? intent.action : null;
  if (!action || typeof action !== "object") {
    return url.toString();
  }

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
    default:
      break;
  }

  return url.toString();
}

self.addEventListener("push", (event) => {
  let payload = null;
  try {
    payload = event.data ? event.data.json() : null;
  } catch {
    payload = null;
  }

  const intent = payload && typeof payload === "object" && payload.intent
    ? payload.intent
    : payload;
  const title = intent && intent.title ? intent.title : "Orchestra";
  const options = {
    body: intent && intent.body ? intent.body : "You have a new Orchestra notification.",
    tag: intent && intent.tag ? intent.tag : undefined,
    data: {
      url: buildNotificationUrl(intent),
    },
  };

  event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener("notificationclick", (event) => {
  event.notification.close();
  const url = event.notification && event.notification.data && event.notification.data.url
    ? event.notification.data.url
    : new URL("/", self.location.origin).toString();

  event.waitUntil((async () => {
    const windowClients = await self.clients.matchAll({
      type: "window",
      includeUncontrolled: true,
    });

    for (const client of windowClients) {
      if ("focus" in client) {
        if (client.url !== url && "navigate" in client) {
          await client.navigate(url);
        }
        await client.focus();
        return;
      }
    }

    if (self.clients.openWindow) {
      await self.clients.openWindow(url);
    }
  })());
});
