import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task comment unread badges", () => {
  it.skipIf(!isDesktopE2E)("shows unread task comment badges and clears them when opening the comments tab", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const task = await invokeCommand<any>(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Unread task comments",
          description: "Unread comment badge coverage.",
          type: "task",
          status: "in_progress",
          priority: "P1",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
        },
      });

      await invokeCommand(sessionId, "comment_on_task", {
        taskId: task.id,
        input: {
          author: "Reviewer",
          originType: "agent",
          originId: "agent-reviewer",
          message: "Please update the implementation plan.",
          interruptAgent: false,
          parentCommentId: null,
        },
      });
      await invokeCommand(sessionId, "comment_on_task", {
        taskId: task.id,
        input: {
          author: "User",
          originType: "user",
          originId: null,
          message: "Acknowledged.",
          interruptAgent: false,
          parentCommentId: null,
        },
      });

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Unread task comments");
      const navBadge = await executeScript<string>(
        sessionId,
        `return document.querySelector('[data-role="nav-badge-tasks"]')?.textContent?.trim() ?? '';`,
      );
      expect(navBadge).toBe("1");

      await clickByText(sessionId, '[data-role="task-card"]', 'Unread task comments');
      await waitForSelector(sessionId, '[data-role="task-unread-comments-footer-badge"]');
      const footerBadge = await executeScript<string>(
        sessionId,
        `return document.querySelector('[data-role="task-unread-comments-footer-badge"]')?.textContent?.trim() ?? '';`,
      );
      expect(footerBadge).toBe("1 unread");

      await clickSelector(sessionId, '[data-role="open-task-comments"]');
      await waitForSelector(sessionId, '[data-role="task-detail-tab-comments"][aria-selected="true"]');
      const unreadState = await executeScript(
        sessionId,
        `return {
          footer: Boolean(document.querySelector('[data-role="task-unread-comments-footer-badge"]')),
          tab: Boolean(document.querySelector('[data-role="task-unread-comments-tab-badge"]')),
          nav: document.querySelector('[data-role="nav-badge-tasks"]')?.textContent?.trim() ?? ''
        };`,
      );
      expect(unreadState.footer).toBe(false);
      expect(unreadState.tab).toBe(false);
      expect(unreadState.nav).toBe("");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
