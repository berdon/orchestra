import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  setInputValue,
  waitForText,
} from "./driver";
import { createTaskViaTasks, openTaskCard } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task markdown lists", () => {
  it.skipIf(!isDesktopE2E)("renders ordered lists with incrementing numbers in task descriptions and comments", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createTaskViaTasks(sessionId, {
        title: "Markdown ordered list task",
        description: "First line\nSecond line with **bold** text\n\n1. Step one\n2. Step two",
      });
      await openTaskCard(sessionId, "Markdown ordered list task");

      const descriptionListState = await executeScript<{
        orderedListCount: number;
        secondValue: string | null;
      }>(sessionId, `
        const list = document.querySelector('[data-role="task-description-markdown"] ol');
        const secondItem = list?.querySelectorAll('li')?.[1] ?? null;
        return {
          orderedListCount: document.querySelectorAll('[data-role="task-description-markdown"] ol').length,
          secondValue: secondItem instanceof HTMLLIElement ? secondItem.getAttribute('value') : null,
        };
      `);
      expect(descriptionListState.orderedListCount).toBe(1);
      expect(descriptionListState.secondValue).toBe('2');

      await clickByText(sessionId, '[role="tab"]', 'Comments');
      await waitForText(sessionId, 'Task conversation');
      await setInputValue(sessionId, '[data-role="task-comment-author"]', 'Reviewer');
      await setInputValue(sessionId, '[data-role="task-comment-message"]', 'Please double-check this flow.\n\n1. Check API shape\n2. Confirm UI');
      await clickSelector(sessionId, '[data-role="add-task-comment"]');
      await waitForText(sessionId, 'Please double-check this flow.');

      const commentListState = await executeScript<{
        orderedListCount: number;
        secondValue: string | null;
        hasErrorCopy: boolean;
      }>(sessionId, `
        const comments = Array.from(document.querySelectorAll('[data-role="task-comment-markdown"] ol'));
        const latest = comments[comments.length - 1] ?? null;
        const secondItem = latest?.querySelectorAll('li')?.[1] ?? null;
        const errorCopy = Array.from(document.querySelectorAll('.error-copy')).some((node) =>
          (node.textContent || '').includes('Unable to add comment.')
        );
        return {
          orderedListCount: comments.length,
          secondValue: secondItem instanceof HTMLLIElement ? secondItem.getAttribute('value') : null,
          hasErrorCopy: errorCopy,
        };
      `);
      expect(commentListState.orderedListCount).toBeGreaterThanOrEqual(1);
      expect(commentListState.secondValue).toBe('2');
      expect(commentListState.hasErrorCopy).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
