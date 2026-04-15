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

      const workflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Unread comment workflow",
          description: "User-owned task board lane for unread comment coverage.",
          lanes: [
            {
              id: "lane-user-review",
              key: "user-review",
              name: "User review",
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: null,
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const task = await invokeCommand<any>(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Unread task comments",
          description: "Unread comment badge coverage.",
          type: "task",
          status: "in_review",
          priority: "P1",
          workflowId: workflow.id,
          currentLaneId: "lane-user-review",
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

      const cardBadge = await executeScript<string>(
        sessionId,
        `return document.querySelector('[data-role="task-card"][data-task-id="${task.id}"] [data-role="task-card-unread-comments-badge"]')?.textContent?.trim() ?? '';`,
      );
      expect(cardBadge).toBe("1 unread");

      await clickSelector(sessionId, '[data-role="task-view-table"]');
      await waitForSelector(sessionId, '[data-role="task-table-unread-comments-badge"]');
      const tableBadge = await executeScript<string>(
        sessionId,
        `return document.querySelector('[data-role="task-table-row"][data-task-id="${task.id}"] [data-role="task-table-unread-comments-badge"]')?.textContent?.trim() ?? '';`,
      );
      expect(tableBadge).toBe("1 unread");

      await clickSelector(sessionId, `[data-role="task-table-row"][data-task-id="${task.id}"]`);
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
