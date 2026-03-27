import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop inbox and messaging", () => {
  it.skipIf(!isDesktopE2E)("shows user mailbox items and attention tasks through the real desktop UI", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await invokeCommand(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Inbox attention task",
          description: "Needs review from the desktop Inbox.",
          type: "task",
          status: "in_review",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          whipMaxAttempts: 10,
          archived: false,
        },
      });

      await invokeCommand(sessionId, "send_mailbox_message", {
        input: {
          projectId: "orchestra",
          recipientType: "user",
          body: "Desktop Inbox regression message.",
          priority: "normal",
        },
      });

      await clickByText(sessionId, "button", "Inbox");
      await waitForText(sessionId, "Desktop Inbox regression message.");
      await waitForText(sessionId, "Review & intervention requests");
      await waitForText(sessionId, "Open task");

      await clickSelector(sessionId, '[data-role^="mark-inbox-read-"]');
      const inboxMessages = await invokeCommand<any[]>(sessionId, "list_inbox_messages", { projectId: "orchestra" });
      expect(inboxMessages.some((message) => message.body === "Desktop Inbox regression message." && message.readAt)).toBe(true);

      await waitForText(sessionId, "Inbox attention task");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
