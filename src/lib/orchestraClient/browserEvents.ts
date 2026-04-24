import type {
  InboxChangeEvent,
  NotificationIntent,
  SessionChangeEvent,
  SessionStreamEnvelope,
  TaskChangeEvent,
} from "../../types";
import { ORCHESTRA_BROWSER_EVENT_NAMES } from "../mockOrchestra/events";
import type { OrchestraClientEventHandler, OrchestraUnsubscribe } from "./events";
import {
  toOrchestraInboxChangeDelivery,
  toOrchestraNotificationIntentDelivery,
  toOrchestraSessionChangeDelivery,
  toOrchestraSessionStreamDelivery,
  toOrchestraTaskChangeDelivery,
} from "./events";

async function listenToBrowserEvent<T>(eventName: string, handler: (event: T) => void): Promise<OrchestraUnsubscribe> {
  const listener = (event: Event) => {
    if (event instanceof CustomEvent) {
      handler(event.detail as T);
    }
  };

  window.addEventListener(eventName, listener);
  return () => {
    window.removeEventListener(eventName, listener);
  };
}

export function listenToSessionStream(handler: (event: SessionStreamEnvelope) => void) {
  return listenToBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.sessionStream, handler);
}

export function listenToSessionChanges(handler: (event: SessionChangeEvent) => void) {
  return listenToBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.sessionChange, handler);
}

export function listenToTaskChanges(handler: (event: TaskChangeEvent) => void) {
  return listenToBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.taskChange, handler);
}

export function listenToInboxChanges(handler: (event: InboxChangeEvent) => void) {
  return listenToBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.inboxChange, handler);
}

export function listenToNotificationIntents(handler: (event: NotificationIntent) => void) {
  return listenToBrowserEvent(ORCHESTRA_BROWSER_EVENT_NAMES.notificationIntent, handler);
}

export async function subscribeToOrchestraBrowserEvents(
  handler: OrchestraClientEventHandler,
): Promise<OrchestraUnsubscribe> {
  const [stopSessionStream, stopSessionChanges, stopTaskChanges, stopInboxChanges, stopNotificationIntents] = await Promise.all([
    listenToSessionStream((event) => handler(toOrchestraSessionStreamDelivery(event))),
    listenToSessionChanges((event) => handler(toOrchestraSessionChangeDelivery(event))),
    listenToTaskChanges((event) => handler(toOrchestraTaskChangeDelivery(event))),
    listenToInboxChanges((event) => handler(toOrchestraInboxChangeDelivery(event))),
    listenToNotificationIntents((event) => handler(toOrchestraNotificationIntentDelivery(event))),
  ]);

  return () => {
    stopSessionStream();
    stopSessionChanges();
    stopTaskChanges();
    stopInboxChanges();
    stopNotificationIntents();
  };
}
