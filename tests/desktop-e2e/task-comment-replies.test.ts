import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  waitForText,
} from "./driver";
import { createProjectViaSettings, createTaskViaTasks, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task comment replies", () => {
  it.skipIf(!isDesktopE2E)("supports replying to task comments in the task detail UI", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Comment Reply Project", "Desktop task comment replies test.");
      await switchProject(sessionId, "Comment Reply Project");
      await createTaskViaTasks(sessionId, {
        title: "Comment reply task",
        description: "Exercise threaded comment replies in the task detail UI.",
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Comment Reply Project'));
      expect(project).toBeTruthy();
      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Comment reply task'));
      expect(task).toBeTruthy();

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Comment reply task");
      await clickByText(sessionId, '[data-role="task-card"]', "Comment reply task");
      await waitForText(sessionId, "Comment reply task");
      await clickByText(sessionId, '[role="tab"]', "Comments");
      await waitForText(sessionId, "Task conversation");

      await setInputValue(sessionId, '[data-role="task-comment-author"]', 'Reviewer');
      await setInputValue(sessionId, '[data-role="task-comment-message"]', 'Please split this into smaller steps.');
      await executeScript(sessionId, `
        const textarea = document.querySelector('[data-role="task-comment-message"]');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        return true;
      `);
      await waitForText(sessionId, 'Please split this into smaller steps.');

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await clickSelector(sessionId, '[data-role="reply-task-comment-summary"]');
      await setInputValue(sessionId, '[data-role="task-reply-author"]', 'Worker');
      await setInputValue(sessionId, '[data-role="task-reply-message"]', 'Split complete; follow-up tasks are queued.');
      await executeScript(sessionId, `
        const textarea = document.querySelector('[data-role="task-reply-message"]');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', ctrlKey: true, bubbles: true }));
        return true;
      `);

      await waitForText(sessionId, 'Worker');
      await waitForText(sessionId, 'Split complete; follow-up tasks are queued.');

      const comments = await invokeCommand<Array<{ id: string; parentCommentId?: string | null; message: string }>>(sessionId, 'list_task_comments', {
        taskId: task!.id,
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
