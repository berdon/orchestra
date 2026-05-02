import { describe, expect, it } from "vitest";

import {
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForTextContent(sessionId: string, selector: string, expected: string, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = "";
  while (Date.now() < deadline) {
    lastValue = await executeScript<string>(
      sessionId,
      `return document.querySelector(arguments[0])?.textContent?.trim() ?? '';`,
      [selector],
    );
    if (lastValue === expected) {
      return lastValue;
    }
    await sleep(250);
  }

  throw new Error(`Expected ${selector} text to be ${JSON.stringify(expected)}, received ${JSON.stringify(lastValue)}`);
}

describe("desktop task comment unread badges", () => {
  it.skipIf(!isDesktopE2E)("hides unread task comment badges on completed tasks and still clears active-task badges when task details open", async () => {
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

      const activeTask = await invokeCommand<any>(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Unread active task comments",
          description: "Unread comment badge coverage for active work.",
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
      const completedTask = await invokeCommand<any>(sessionId, "create_task", {
        projectId: "orchestra",
        input: {
          title: "Unread completed task comments",
          description: "Unread comment badge coverage for completed work.",
          type: "task",
          status: "completed",
          priority: "P2",
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
        taskId: activeTask.id,
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
        taskId: activeTask.id,
        input: {
          author: "User",
          originType: "user",
          originId: null,
          message: "Acknowledged.",
          interruptAgent: false,
          parentCommentId: null,
        },
      });
      await invokeCommand(sessionId, "comment_on_task", {
        taskId: completedTask.id,
        input: {
          author: "Reviewer",
          originType: "agent",
          originId: "agent-reviewer",
          message: "Final follow-up after completion.",
          interruptAgent: false,
          parentCommentId: null,
        },
      });

      const activeTaskDetail = await invokeCommand<any>(sessionId, "get_task", { taskId: activeTask.id });
      const completedTaskDetail = await invokeCommand<any>(sessionId, "get_task", { taskId: completedTask.id });
      expect(activeTaskDetail.unreadCommentCount).toBeGreaterThan(0);
      expect(completedTaskDetail.unreadCommentCount).toBeGreaterThan(0);
      const expectedActiveUnreadBadge = `${activeTaskDetail.unreadCommentCount} unread`;

      await clickSelector(sessionId, '[data-role="nav-item-tasks"]');
      await waitForText(sessionId, "Unread active task comments");

      const cardBadge = await waitForTextContent(
        sessionId,
        `[data-role="task-card"][data-task-id="${activeTask.id}"] [data-role="task-card-unread-comments-badge"]`,
        expectedActiveUnreadBadge,
      );
      expect(cardBadge).toBe(expectedActiveUnreadBadge);

      await clickSelector(sessionId, '[data-role="task-filter-done"]');
      await waitForText(sessionId, "Unread completed task comments");
      const completedCardBadge = await waitForTextContent(
        sessionId,
        `[data-role="task-card"][data-task-id="${completedTask.id}"] [data-role="task-card-unread-comments-badge"]`,
        "",
      );
      expect(completedCardBadge).toBe("");

      await clickSelector(sessionId, '[data-role="task-view-table"]');
      const completedTableBadge = await waitForTextContent(
        sessionId,
        `[data-role="task-table-row"][data-task-id="${completedTask.id}"] [data-role="task-table-unread-comments-badge"]`,
        "",
      );
      expect(completedTableBadge).toBe("");

      await clickSelector(sessionId, `[data-role="task-table-row"][data-task-id="${completedTask.id}"]`);
      const completedUnreadState = await executeScript(
        sessionId,
        `return {
          footer: Boolean(document.querySelector('[data-role="task-unread-comments-footer-badge"]'))
        };`,
      );
      expect(completedUnreadState.footer).toBe(false);

      await clickSelector(sessionId, '[data-role="nav-item-tasks"]');
      await clickSelector(sessionId, '[data-role="task-filter-all"]');
      await clickSelector(sessionId, '[data-role="task-view-table"]');
      const activeTableBadge = await waitForTextContent(
        sessionId,
        `[data-role="task-table-row"][data-task-id="${activeTask.id}"] [data-role="task-table-unread-comments-badge"]`,
        expectedActiveUnreadBadge,
      );
      expect(activeTableBadge).toBe(expectedActiveUnreadBadge);

      await clickSelector(sessionId, `[data-role="task-table-row"][data-task-id="${activeTask.id}"]`);
      await sleep(500);
      let unreadState = await executeScript(
        sessionId,
        `return {
          footer: Boolean(document.querySelector('[data-role="task-unread-comments-footer-badge"]')),
          navBadge: Boolean(document.querySelector('[data-role="nav-badge-tasks"]'))
        };`,
      );
      expect(unreadState.footer).toBe(true);
      expect(unreadState.navBadge).toBe(true);

      await clickSelector(sessionId, '[data-role="task-detail-tab-comments"]');
      await sleep(500);
      unreadState = await executeScript(
        sessionId,
        `return {
          footer: Boolean(document.querySelector('[data-role="task-unread-comments-footer-badge"]')),
          navBadge: Boolean(document.querySelector('[data-role="nav-badge-tasks"]'))
        };`,
      );
      expect(unreadState.footer).toBe(false);
      expect(unreadState.navBadge).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
