import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  setInputValue,
  sleep,
  waitForText,
} from "./driver";
import { addTaskCommentViaUi, createProjectViaSettings, createTaskViaTasks, openTaskCard, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function getRenderedThreads(sessionId: string) {
  return executeScript<Array<{ text: string; replies: string[] }>>(sessionId, `
    return Array.from(document.querySelectorAll('[data-role="task-comment-thread"]')).map((thread) => ({
      text: thread.textContent || '',
      replies: Array.from(thread.querySelectorAll('[data-role="task-comment-reply"]')).map((reply) => reply.textContent || ''),
    }));
  `);
}

describe("desktop task comment replies", () => {
  it.skipIf(!isDesktopE2E)("keeps replies in the correct thread, promotes threads by reply activity, and persists after reopen", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Comment Reply Project", "Desktop task comment replies test.");
      await switchProject(sessionId, "Comment Reply Project");
      await createTaskViaTasks(sessionId, {
        title: "Comment reply task",
        description: "Exercise threaded comment replies in the task detail UI.",
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "Comment Reply Project"));
      expect(project).toBeTruthy();
      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === "Comment reply task"));
      expect(task).toBeTruthy();

      await openTaskCard(sessionId, "Comment reply task");
      await addTaskCommentViaUi(sessionId, "Reviewer", "Older parent comment.");
      await sleep(25);
      await addTaskCommentViaUi(sessionId, "Reviewer", "Newer standalone comment.");

      await clickByText(sessionId, '[role="tab"]', "Repo files");
      await waitForText(sessionId, "Older parent comment.");
      const openedReplyComposer = await executeScript<boolean>(sessionId, `
        const threads = Array.from(document.querySelectorAll('[data-role="task-comments"] .task-comment-thread'));
        const target = threads.find((thread) => thread.textContent?.includes(arguments[0]));
        const button = target?.querySelector('[data-role="reply-task-comment"]');
        if (!(button instanceof HTMLElement)) {
          return false;
        }
        button.click();
        return true;
      `, ["Older parent comment."]);
      expect(openedReplyComposer).toBe(true);

      await waitForText(sessionId, "Reply to Reviewer");
      await setInputValue(sessionId, '[data-role="task-reply-author"]', "Worker");
      await setInputValue(sessionId, '[data-role="task-reply-message"]', "Reply on the older thread.");
      const submittedReply = await executeScript<boolean>(sessionId, `
        const button = document.querySelector('[data-role="add-task-reply"]');
        if (!(button instanceof HTMLElement)) {
          return false;
        }
        button.click();
        return true;
      `);
      expect(submittedReply).toBe(true);
      await waitForText(sessionId, "Reply on the older thread.");

      const comments = await invokeCommand<Array<{ id: string; parentCommentId?: string | null; message: string }>>(sessionId, "list_task_comments", {
        taskId: task!.id,
      });
      expect(comments).toHaveLength(3);
      const olderParent = comments.find((entry) => entry.message === "Older parent comment.");
      const newerStandalone = comments.find((entry) => entry.message === "Newer standalone comment.");
      const reply = comments.find((entry) => entry.message === "Reply on the older thread.");
      expect(olderParent?.parentCommentId ?? null).toBeNull();
      expect(newerStandalone?.parentCommentId ?? null).toBeNull();
      expect(reply?.parentCommentId).toBe(olderParent?.id);

      let renderedThreads = await getRenderedThreads(sessionId);
      expect(renderedThreads).toHaveLength(2);
      expect(renderedThreads[0]?.text).toContain("Older parent comment.");
      expect(renderedThreads[0]?.replies).toEqual(expect.arrayContaining([expect.stringContaining("Reply on the older thread.")]));
      expect(renderedThreads[1]?.text).toContain("Newer standalone comment.");
      expect(renderedThreads[1]?.replies ?? []).toHaveLength(0);

      await clickByText(sessionId, "button", "Tasks");
      await openTaskCard(sessionId, "Comment reply task");
      await waitForText(sessionId, "Reply on the older thread.");

      renderedThreads = await getRenderedThreads(sessionId);
      expect(renderedThreads).toHaveLength(2);
      expect(renderedThreads[0]?.text).toContain("Older parent comment.");
      expect(renderedThreads[0]?.replies).toEqual(expect.arrayContaining([expect.stringContaining("Reply on the older thread.")]));
      expect(renderedThreads[1]?.text).toContain("Newer standalone comment.");

      await addTaskCommentViaUi(sessionId, "Reviewer", "Fresh standalone note.");
      renderedThreads = await getRenderedThreads(sessionId);
      expect(renderedThreads).toHaveLength(3);
      expect(renderedThreads[0]?.text).toContain("Fresh standalone note.");
      expect(renderedThreads[1]?.text).toContain("Older parent comment.");
      expect(renderedThreads[1]?.replies).toEqual(expect.arrayContaining([expect.stringContaining("Reply on the older thread.")]));
      expect(renderedThreads[2]?.text).toContain("Newer standalone comment.");
      expect(renderedThreads.flatMap((thread) => thread.replies)).toHaveLength(1);

      const commentsAfterReload = await invokeCommand<Array<{ id: string; parentCommentId?: string | null; message: string }>>(sessionId, "list_task_comments", {
        taskId: task!.id,
      });
      expect(commentsAfterReload).toHaveLength(4);
      const freshStandalone = commentsAfterReload.find((entry) => entry.message === "Fresh standalone note.");
      expect(freshStandalone?.parentCommentId ?? null).toBeNull();
      expect(commentsAfterReload.find((entry) => entry.message === "Reply on the older thread.")?.parentCommentId).toBe(olderParent?.id);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
