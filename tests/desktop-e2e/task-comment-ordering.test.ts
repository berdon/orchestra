import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectByLabel,
  sleep,
  waitForSelectedLabel,
} from "./driver";
import { addTaskCommentViaUi, openTaskCard } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task comment ordering", () => {
  it.skipIf(!isDesktopE2E)("shows newest task comments first in the comments section", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Comment Ordering Project",
          taskPrefix: "COP",
          description: "Desktop task comment ordering test.",
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Comment ordering task",
          description: "Newest comments should appear first.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          parentTaskId: null,
          archived: false,
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [task.id], reason: "task.created" });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await openTaskCard(sessionId, task.title);
      await addTaskCommentViaUi(sessionId, "Reviewer", "First comment");
      await sleep(25);
      await addTaskCommentViaUi(sessionId, "Reviewer", "Second comment");

      const comments = await executeScript<string[]>(sessionId, `
        return Array.from(document.querySelectorAll('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-item"]')).map((entry) => entry.textContent || '');
      `);

      expect(comments).toHaveLength(2);
      expect(comments[0]).toContain('Second comment');
      expect(comments[1]).toContain('First comment');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
