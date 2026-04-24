import { describe, expect, it } from "vitest";

import { filterInboxMessages, getArchivableInboxMessages, mergeInboxMessageUpdates } from "../src/lib/inboxMessages";
import type { MailboxMessage } from "../src/types";

function buildMessage(overrides: Partial<MailboxMessage> & Pick<MailboxMessage, "deliveryId" | "body">): MailboxMessage {
  return {
    deliveryId: overrides.deliveryId,
    messageId: `${overrides.deliveryId}-message`,
    projectId: "orchestra",
    taskId: null,
    taskNumber: null,
    taskTitle: null,
    senderType: "agent",
    senderId: "agent-1",
    senderLabel: "Agent",
    recipientType: "user",
    recipientId: "desktop-user",
    recipientLabel: "User",
    assignmentId: null,
    body: overrides.body,
    priority: "normal",
    readAt: null,
    readSessionId: null,
    archivedAt: null,
    lastNotifiedAt: "2026-04-24T12:00:00.000Z",
    createdAt: "2026-04-24T12:00:00.000Z",
    updatedAt: "2026-04-24T12:00:00.000Z",
    ...overrides,
  };
}

const unreadActive = buildMessage({ deliveryId: "unread-active", body: "Unread active", createdAt: "2026-04-24T12:03:00.000Z" });
const readActive = buildMessage({
  deliveryId: "read-active",
  body: "Read active",
  readAt: "2026-04-24T12:02:00.000Z",
  readSessionId: "desktop-user",
  createdAt: "2026-04-24T12:02:00.000Z",
});
const unreadArchived = buildMessage({
  deliveryId: "unread-archived",
  body: "Unread archived",
  archivedAt: "2026-04-24T12:01:00.000Z",
  createdAt: "2026-04-24T12:01:00.000Z",
});
const readArchived = buildMessage({
  deliveryId: "read-archived",
  body: "Read archived",
  readAt: "2026-04-24T12:00:00.000Z",
  readSessionId: "desktop-user",
  archivedAt: "2026-04-24T12:00:30.000Z",
});

const inboxMessages = [unreadActive, readActive, unreadArchived, readArchived];

describe("inbox message helpers", () => {
  it("filters unread and read views without showing archived rows by default", () => {
    expect(filterInboxMessages(inboxMessages, "unread", false).map((message) => message.deliveryId)).toEqual(["unread-active"]);
    expect(filterInboxMessages(inboxMessages, "read", false).map((message) => message.deliveryId)).toEqual(["read-active"]);
  });

  it("keeps archived rows visible only when requested and excludes them from archive-all targets", () => {
    const visibleMessages = filterInboxMessages(inboxMessages, "all", true);

    expect(visibleMessages.map((message) => message.deliveryId)).toEqual([
      "unread-active",
      "read-active",
      "unread-archived",
      "read-archived",
    ]);
    expect(getArchivableInboxMessages(visibleMessages).map((message) => message.deliveryId)).toEqual([
      "unread-active",
      "read-active",
    ]);
  });

  it("scopes archive-all targets to the current filtered view", () => {
    const unreadVisibleMessages = filterInboxMessages(inboxMessages, "unread", true);
    const readVisibleMessages = filterInboxMessages(inboxMessages, "read", true);

    expect(getArchivableInboxMessages(unreadVisibleMessages).map((message) => message.deliveryId)).toEqual(["unread-active"]);
    expect(getArchivableInboxMessages(readVisibleMessages).map((message) => message.deliveryId)).toEqual(["read-active"]);
  });

  it("merges archive responses into local state and re-sorts archived rows behind active mail", () => {
    const archivedUnreadActive = {
      ...unreadActive,
      archivedAt: "2026-04-24T12:04:00.000Z",
      updatedAt: "2026-04-24T12:04:00.000Z",
    };

    expect(mergeInboxMessageUpdates(inboxMessages, [archivedUnreadActive]).map((message) => message.deliveryId)).toEqual([
      "read-active",
      "unread-active",
      "unread-archived",
      "read-archived",
    ]);
  });
});
