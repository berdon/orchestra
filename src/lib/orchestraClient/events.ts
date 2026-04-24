import type {
  InboxChangeEvent,
  NotificationIntent,
  SessionChangeEvent,
  SessionStreamEnvelope,
  TaskChangeEvent,
} from "../../types";

export type OrchestraClientEventKind =
  | "session.change"
  | "session.stream"
  | "task.change"
  | "inbox.change"
  | "notification.intent";

export type OrchestraSessionChangeDelivery = SessionChangeEvent & {
  kind: "session.change";
};

export type OrchestraSessionStreamDelivery = SessionStreamEnvelope & {
  kind: "session.stream";
};

export type OrchestraTaskChangeDelivery = TaskChangeEvent & {
  kind: "task.change";
};

export type OrchestraInboxChangeDelivery = InboxChangeEvent & {
  kind: "inbox.change";
};

export type OrchestraNotificationIntentDelivery = NotificationIntent & {
  kind: "notification.intent";
};

export type OrchestraClientEvent =
  | OrchestraSessionChangeDelivery
  | OrchestraSessionStreamDelivery
  | OrchestraTaskChangeDelivery
  | OrchestraInboxChangeDelivery
  | OrchestraNotificationIntentDelivery;

export type OrchestraUnsubscribe = () => void;
export type OrchestraClientEventHandler = (event: OrchestraClientEvent) => void;

export function toOrchestraSessionChangeDelivery(
  event: SessionChangeEvent,
): OrchestraSessionChangeDelivery {
  return {
    kind: "session.change",
    ...event,
  };
}

export function toOrchestraSessionStreamDelivery(
  event: SessionStreamEnvelope,
): OrchestraSessionStreamDelivery {
  return {
    kind: "session.stream",
    ...event,
  };
}

export function toOrchestraTaskChangeDelivery(
  event: TaskChangeEvent,
): OrchestraTaskChangeDelivery {
  return {
    kind: "task.change",
    ...event,
  };
}

export function toOrchestraInboxChangeDelivery(
  event: InboxChangeEvent,
): OrchestraInboxChangeDelivery {
  return {
    kind: "inbox.change",
    ...event,
  };
}

export function toOrchestraNotificationIntentDelivery(
  event: NotificationIntent,
): OrchestraNotificationIntentDelivery {
  return {
    kind: "notification.intent",
    ...event,
  };
}
