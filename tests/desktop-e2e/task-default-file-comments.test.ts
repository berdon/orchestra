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

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop default-file anchored task comments", () => {
  it.skipIf(!isDesktopE2E)("supports quick comments, line comments, and selected-text comments on the default file preview", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "task-default-file-comments-repo", "repository");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "docs", "design.md"), [
      "Alpha line",
      "Beta selected text",
      "Gamma line",
      ...Array.from({ length: 40 }, (_, index) => `Extra filler line ${index + 4}`),
    ].join("\n"), "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });
    const commitHash = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Default File Comment Project",
          taskPrefix: "DFC",
          description: "Desktop anchored task comment test.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Default File Comment Repo",
          repositoryPath: repoPath,
          defaultBranch: "main",
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Annotate the default file",
          description: "Use the default file preview to add comments.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository.id,
          parentTaskId: null,
          archived: false,
        },
      });
      const fileReference = await invokeCommand<{ id: string }>(sessionId, "add_task_file_reference", {
        taskId: task.id,
        input: {
          repositoryId: repository.id,
          relativePath: "docs/design.md",
        },
      });
      await invokeCommand(sessionId, "set_default_task_file_reference", { referenceId: fileReference.id });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [task.id], reason: "task.file_reference.added" });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await sleep(500);

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[data-role="task-card"]', task.title);
      await waitForText(sessionId, "Default repo file");
      await waitForText(sessionId, "docs/design.md");

      await setInputValue(sessionId, '[data-role="task-comment-message"]', 'General note under the default file.');
      await clickSelector(sessionId, '[data-role="add-task-comment"]');
      await waitForText(sessionId, 'General note under the default file.');

      const viewerHeaderText = await executeScript<string>(sessionId, `
        return document.querySelector('.file-content-viewer__header')?.textContent || '';
      `);
      expect(viewerHeaderText).not.toContain('Resizable');

      await clickSelector(sessionId, '[data-role="default-file-scroll-bottom"]');
      const scrollTopBeforeLineComment = await executeScript<number>(sessionId, `
        const viewer = document.querySelector('[data-role="default-file-code-viewer"]');
        if (!(viewer instanceof HTMLElement)) {
          throw new Error('Default file viewer was not available');
        }
        return viewer.scrollTop;
      `);

      await executeScript(sessionId, `
        const openDraft = window.__orchestraOpenFileCommentDraft;
        if (typeof openDraft !== 'function') {
          throw new Error('Comment draft helper was not available');
        }
        openDraft({
          anchor: {
            repositoryId: ${JSON.stringify(repository.id)},
            relativePath: 'docs/design.md',
            absolutePath: ${JSON.stringify(join(repoPath, 'docs', 'design.md'))},
            lineStart: 3,
            lineEnd: 3,
            columnStart: null,
            columnEnd: null,
            selectedText: null,
          },
          top: 88,
          left: 220,
        });
        return true;
      `);
      await waitForText(sessionId, 'Line 3');
      await setInputValue(sessionId, '[data-role="default-file-comment-message"]', 'Please revisit this line.');
      await clickSelector(sessionId, '[data-role="add-default-file-comment"]');
      await waitForText(sessionId, 'Please revisit this line.');
      await waitForText(sessionId, 'docs/design.md · line 3');
      const scrollTopAfterLineComment = await executeScript<number>(sessionId, `
        const viewer = document.querySelector('[data-role="default-file-code-viewer"]');
        if (!(viewer instanceof HTMLElement)) {
          throw new Error('Default file viewer was not available after comment submission');
        }
        return viewer.scrollTop;
      `);
      expect(scrollTopAfterLineComment).toBeGreaterThan(scrollTopBeforeLineComment - 24);
      await executeScript(sessionId, `
        const viewer = document.querySelector('[data-role="default-file-code-viewer"]');
        if (viewer instanceof HTMLElement) {
          viewer.scrollTop = 0;
        }
        return true;
      `);
      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="default-file-line-comment-button"][data-line-number="3"]');
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('Line 3 comment button was not available');
        }
        button.click();
        return true;
      `);
      await waitForText(sessionId, 'Comments on line 3');
      await waitForText(sessionId, 'Please revisit this line.');
      await clickSelector(sessionId, '[data-role="default-file-open-reply"]');
      await setInputValue(sessionId, '[data-role="default-file-reply-message"]', 'Acknowledged on line 3.');
      await clickSelector(sessionId, '[data-role="add-default-file-reply"]');
      await waitForText(sessionId, 'Acknowledged on line 3.');

      await executeScript(sessionId, `
        const selection = window.getSelection();
        selection?.removeAllRanges?.();
        document.dispatchEvent(new Event('selectionchange', { bubbles: true }));
        return true;
      `);

      await executeScript(sessionId, `
        document.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
        return true;
      `);
      await executeScript(sessionId, `
        const openDraft = window.__orchestraOpenFileCommentDraft;
        if (typeof openDraft !== 'function') {
          throw new Error('Comment draft helper was not available');
        }
        openDraft({
          anchor: {
            repositoryId: ${JSON.stringify(repository.id)},
            relativePath: 'docs/design.md',
            absolutePath: ${JSON.stringify(join(repoPath, 'docs', 'design.md'))},
            lineStart: 2,
            lineEnd: 2,
            columnStart: 6,
            columnEnd: 18,
            selectedText: 'selected text',
          },
          top: 132,
          left: 260,
        });
        return true;
      `);
      await waitForText(sessionId, 'Selection');
      await waitForText(sessionId, 'selected text');
      await setInputValue(sessionId, '[data-role="default-file-comment-message"]', 'Clarify this selected text.');
      await clickSelector(sessionId, '[data-role="add-default-file-comment"]');
      await waitForText(sessionId, 'Clarify this selected text.');
      await waitForText(sessionId, 'selected text');

      const comments = await invokeCommand<Array<{
        message: string;
        relativePath?: string | null;
        lineStart?: number | null;
        lineEnd?: number | null;
        columnStart?: number | null;
        columnEnd?: number | null;
        selectedText?: string | null;
        anchorCommitHash?: string | null;
        anchorHasUncommittedChanges?: boolean | null;
      }>>(sessionId, 'list_task_comments', { taskId: task.id });

      expect(comments).toHaveLength(4);

      await clickSelector(sessionId, '[data-role="default-file-scroll-bottom"]');
      const distanceFromBottom = await executeScript<number>(sessionId, `
        const viewer = document.querySelector('[data-role="default-file-code-viewer"]');
        if (!(viewer instanceof HTMLElement)) {
          return -1;
        }
        return viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop;
      `);
      expect(distanceFromBottom).toBeLessThanOrEqual(4);

      await clickSelector(sessionId, '[data-role="default-file-viewer-toggle"]');
      await waitForText(sessionId, 'Expand');
      expect(comments[0]?.message).toContain('General note under the default file.');

      const lineComment = comments.find((entry) => entry.message.includes('Please revisit this line.'));
      expect(lineComment).toBeTruthy();
      expect(lineComment?.relativePath).toBe('docs/design.md');
      expect(lineComment?.lineStart).toBe(3);
      expect(lineComment?.lineEnd).toBe(3);
      expect(lineComment?.columnStart ?? null).toBeNull();
      expect(lineComment?.selectedText ?? null).toBeNull();
      expect(lineComment?.anchorCommitHash).toBe(commitHash);
      expect(lineComment?.anchorHasUncommittedChanges).toBe(false);

      const selectionComment = comments.find((entry) => entry.message.includes('Clarify this selected text.'));
      expect(selectionComment).toBeTruthy();
      expect(selectionComment?.relativePath).toBe('docs/design.md');
      expect(selectionComment?.lineStart).toBe(2);
      expect(selectionComment?.lineEnd).toBe(2);
      expect(selectionComment?.columnStart).toBe(6);
      expect(selectionComment?.columnEnd).toBe(18);
      expect(selectionComment?.selectedText).toBe('selected text');
      expect(selectionComment?.anchorCommitHash).toBe(commitHash);
      expect(selectionComment?.anchorHasUncommittedChanges).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
