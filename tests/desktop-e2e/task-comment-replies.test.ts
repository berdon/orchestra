import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  invokeCommand,
  selectByLabel,
  setInputValue,
  waitForSelectedLabel,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task comment replies", () => {
  it.skipIf(!isDesktopE2E)("supports replying to task comments in the task detail UI", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Comment Reply Project",
          description: "Desktop task comment replies test.",
        },
      });

      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Comment reply task",
          description: "Exercise threaded comment replies in the task detail UI.",
          type: "task",
          status: "draft",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          parentTaskId: null,
          archived: false,
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[data-role="task-card"]', task.title);
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[role="tab"]', "Comments");
      await waitForText(sessionId, "Task conversation");

      await setInputValue(sessionId, '[data-role="task-comment-author"]', 'Reviewer');
      await setInputValue(sessionId, '[data-role="task-comment-message"]', 'Please split this into smaller steps.');
      await clickSelector(sessionId, '[data-role="add-task-comment"]');
      await waitForText(sessionId, 'Please split this into smaller steps.');

      await clickSelector(sessionId, '[data-role="reply-task-comment"]');
      await setInputValue(sessionId, '[data-role="task-reply-author"]', 'Worker');
      await setInputValue(sessionId, '[data-role="task-reply-message"]', 'Split complete; follow-up tasks are queued.');
      await clickSelector(sessionId, '[data-role="add-task-reply"]');

      await waitForText(sessionId, 'Worker');
      await waitForText(sessionId, 'Split complete; follow-up tasks are queued.');

      const comments = await invokeCommand<Array<{ id: string; parentCommentId?: string | null; message: string }>>(sessionId, 'list_task_comments', {
        taskId: task.id,
      });
      expect(comments).toHaveLength(2);
      const parent = comments.find((entry) => entry.message.includes('Please split this into smaller steps.'));
      const reply = comments.find((entry) => entry.message.includes('Split complete; follow-up tasks are queued.'));
      expect(parent).toBeTruthy();
      expect(reply?.parentCommentId).toBe(parent?.id);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
