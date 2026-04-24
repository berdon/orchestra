import type { MailboxMessage } from "../types";

export type InboxMailFilter = "all" | "unread" | "read";

export function sortInboxMessages(messages: MailboxMessage[]): MailboxMessage[] {
  return [...messages].sort((left, right) => {
    if (!left.archivedAt && right.archivedAt) return -1;
    if (left.archivedAt && !right.archivedAt) return 1;
    if (!left.readAt && right.readAt) return -1;
    if (left.readAt && !right.readAt) return 1;
    return right.createdAt.localeCompare(left.createdAt);
  });
}

export function filterInboxMessages(messages: MailboxMessage[], mailFilter: InboxMailFilter, showArchived: boolean): MailboxMessage[] {
  return messages.filter((message) => {
    if (!showArchived && message.archivedAt) {
      return false;
    }
    if (mailFilter === "unread") {
      return !message.readAt;
    }
    if (mailFilter === "read") {
      return Boolean(message.readAt);
    }
    return true;
  });
}

export function getArchivableInboxMessages(messages: MailboxMessage[]): MailboxMessage[] {
  return messages.filter((message) => !message.archivedAt);
}

export function mergeInboxMessageUpdates(messages: MailboxMessage[], updates: MailboxMessage[]): MailboxMessage[] {
  if (!updates.length) {
    return messages;
  }

  const updatesByDeliveryId = new Map(updates.map((message) => [message.deliveryId, message]));
  const knownDeliveryIds = new Set(messages.map((message) => message.deliveryId));
  const merged = messages.map((message) => updatesByDeliveryId.get(message.deliveryId) ?? message);

  for (const update of updates) {
    if (!knownDeliveryIds.has(update.deliveryId)) {
      merged.push(update);
    }
  }

  return sortInboxMessages(merged);
}
