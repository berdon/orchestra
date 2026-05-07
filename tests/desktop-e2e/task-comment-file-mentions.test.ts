import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForText,
} from "./driver";
import { openTaskCard } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task comment file mentions", () => {
  it.skipIf(!isDesktopE2E)("shows $file autocomplete and automatically tracks referenced files from comments and replies", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "comment-file-mentions-repo");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "docs", "design.md"), "Design mention target\n", "utf8");
    writeFileSync(join(repoPath, "docs", "plan.md"), "Plan mention target\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, 'create_project', {
        input: {
          name: 'Comment Mention Project',
          taskPrefix: 'CMP',
          description: 'Desktop task comment file mention test.',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Comment Mention Repo',
          repositoryPath: repoPath,
          defaultBranch: 'main',
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Comment mention task',
          description: 'Use $file mentions inside comments.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: null,
          currentLaneId: null,
          assigneeType: 'unassigned',
          assigneeId: null,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          parentTaskId: null,
          archived: false,
        },
      });
      await dispatchWindowEvent(sessionId, 'orchestra:projects-changed');
      await dispatchWindowEvent(sessionId, 'orchestra:task-change', { taskIds: [task.id], reason: 'task.created' });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await openTaskCard(sessionId, "Comment mention task");
      await waitForText(sessionId, 'Task conversation');

      await setInputValue(sessionId, '[data-role="task-comment-author"]', 'Reviewer');
      await setInputValue(sessionId, '[data-role="task-comment-message"]', '$');
      await executeScript(sessionId, `
        const message = document.querySelector('[data-role="task-comment-message"]');
        if (!(message instanceof HTMLTextAreaElement)) return false;
        message.focus();
        message.setSelectionRange(message.value.length, message.value.length);
        message.dispatchEvent(new KeyboardEvent('keyup', { key: '$', bubbles: true }));
        return true;
      `);
      await waitForText(sessionId, 'docs/design.md');
      await waitForText(sessionId, 'docs/plan.md');

      await setInputValue(sessionId, '[data-role="task-comment-message"]', 'Please review $docs/des');
      await executeScript(sessionId, `
        const message = document.querySelector('[data-role="task-comment-message"]');
        if (!(message instanceof HTMLTextAreaElement)) return false;
        message.focus();
        message.setSelectionRange(message.value.length, message.value.length);
        message.dispatchEvent(new KeyboardEvent('keyup', { key: 's', bubbles: true }));
        return true;
      `);
      await waitForText(sessionId, 'docs/design.md');
      await executeScript(sessionId, `
        const option = document.querySelector('[data-role="task-comment-mention-option"]');
        if (!(option instanceof HTMLElement)) return false;
        option.dispatchEvent(new MouseEvent('mousedown', { bubbles: true }));
        option.click();
        return true;
      `);

      const topLevelMessage = await executeScript<string>(sessionId, `
        const textarea = document.querySelector('[data-role="task-comment-message"]');
        return textarea instanceof HTMLTextAreaElement ? textarea.value : '';
      `);
      expect(topLevelMessage).toContain('$docs/design.md');

      await clickSelector(sessionId, '[data-role="add-task-comment"]');
      await waitForText(sessionId, 'Please review docs/design.md');

      await clickSelector(sessionId, '[data-role="reply-task-comment"]');
      await setInputValue(sessionId, '[data-role="task-reply-author"]', 'Worker');
      await setInputValue(sessionId, '[data-role="task-reply-message"]', 'Implemented in $docs/pla');
      await executeScript(sessionId, `
        const message = document.querySelector('[data-role="task-reply-message"]');
        if (!(message instanceof HTMLTextAreaElement)) return false;
        message.focus();
        message.setSelectionRange(message.value.length, message.value.length);
        message.dispatchEvent(new KeyboardEvent('keyup', { key: 'a', bubbles: true }));
        return true;
      `);
      await waitForText(sessionId, 'docs/plan.md');
      await executeScript(sessionId, `
        const textarea = document.querySelector('[data-role="task-reply-message"]');
        if (!(textarea instanceof HTMLTextAreaElement)) return false;
        textarea.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
        return true;
      `);

      for (let attempt = 0; attempt < 20; attempt += 1) {
        const replyValue = await executeScript<string>(sessionId, `
          const textarea = document.querySelector('[data-role="task-reply-message"]');
          return textarea instanceof HTMLTextAreaElement ? textarea.value : '';
        `);
        if (replyValue.includes('$docs/plan.md')) {
          break;
        }
        await sleep(250);
      }

      await clickSelector(sessionId, '[data-role="add-task-reply"]');
      await waitForText(sessionId, 'Implemented in docs/plan.md');

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await waitForText(sessionId, 'Comment Mention Repo · docs/design.md');
      const fileOptions = await executeScript<string[]>(sessionId, `
        const select = document.querySelector('[data-role="task-file-references"] select');
        if (!(select instanceof HTMLSelectElement)) return [];
        return Array.from(select.options).map((option) => option.textContent || '');
      `);
      expect(fileOptions.some((option) => option.includes('docs/design.md'))).toBe(true);
      expect(fileOptions.some((option) => option.includes('docs/plan.md'))).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
