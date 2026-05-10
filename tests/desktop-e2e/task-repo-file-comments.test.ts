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

describe("desktop repo-file anchored task comments", () => {
  it.skipIf(!isDesktopE2E)("supports anchored comments on non-default repo files from the repo files tab", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "task-repo-file-comments-repo", "repository");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "docs", "design.md"), [
      "Default repo file",
      "This file stays visible in the summary card.",
    ].join("\n"), "utf8");
    writeFileSync(join(repoPath, "docs", "notes.md"), [
      "Secondary repo file",
      "This line should accept repo-tab comments.",
      "Closing line",
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
          name: "Repo File Comment Project",
          taskPrefix: "RFC",
          description: "Desktop repo-file comment test.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Repo File Comment Repo",
          repositoryPath: repoPath,
          defaultBranch: "main",
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Annotate a repo-tab file",
          description: "Use the repo files tab to add comments on a non-default tracked file.",
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
      const defaultFileReference = await invokeCommand<{ id: string }>(sessionId, "add_task_file_reference", {
        taskId: task.id,
        input: {
          repositoryId: repository.id,
          relativePath: "docs/design.md",
        },
      });
      const secondaryFileReference = await invokeCommand<{ id: string }>(sessionId, "add_task_file_reference", {
        taskId: task.id,
        input: {
          repositoryId: repository.id,
          relativePath: "docs/notes.md",
        },
      });
      await invokeCommand(sessionId, "set_default_task_file_reference", { referenceId: defaultFileReference.id });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [task.id], reason: "task.file_reference.added" });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await sleep(500);

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[data-role="task-card"]', task.title);
      await waitForText(sessionId, "Default repo file");
      await clickByText(sessionId, '[role="tab"]', "Repo files");
      await waitForText(sessionId, "Tracked repo files");

      await executeScript(sessionId, `
        const select = document.querySelector('[data-role="task-file-references"] select');
        if (!(select instanceof HTMLSelectElement)) {
          throw new Error('Task file reference selector was not available');
        }
        select.value = ${JSON.stringify(secondaryFileReference.id)};
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `);
      await waitForText(sessionId, "docs/notes.md");
      await waitForText(sessionId, "Secondary repo file");

      await executeScript(sessionId, `
        const openDraft = window.__orchestraOpenFileCommentDraft;
        if (typeof openDraft !== 'function') {
          throw new Error('Comment draft helper was not available');
        }
        openDraft({
          viewerId: 'repo-file',
          anchor: {
            repositoryId: ${JSON.stringify(repository.id)},
            relativePath: 'docs/notes.md',
            absolutePath: ${JSON.stringify(join(repoPath, 'docs', 'notes.md'))},
            lineStart: 2,
            lineEnd: 2,
            columnStart: null,
            columnEnd: null,
            selectedText: null,
          },
          top: 88,
          left: 220,
        });
        return true;
      `);
      await waitForText(sessionId, "Line 2");
      await setInputValue(sessionId, '[data-role="repo-file-comment-message"]', 'Please expand the secondary notes.');
      await clickSelector(sessionId, '[data-role="add-repo-file-comment"]');
      await waitForText(sessionId, 'Please expand the secondary notes.');
      await waitForText(sessionId, 'docs/notes.md · line 2');

      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="repo-file-line-comment-button"][data-line-number="2"]');
        if (!(button instanceof HTMLButtonElement)) {
          throw new Error('Repo-file line 2 comment button was not available');
        }
        button.click();
        return true;
      `);
      await waitForText(sessionId, 'Comments on line 2');
      await waitForText(sessionId, 'Please expand the secondary notes.');

      const comments = await invokeCommand<Array<{
        message: string;
        relativePath?: string | null;
        lineStart?: number | null;
        lineEnd?: number | null;
        anchorCommitHash?: string | null;
        anchorHasUncommittedChanges?: boolean | null;
      }>>(sessionId, 'list_task_comments', { taskId: task.id });

      const lineComment = comments.find((entry) => entry.message.includes('Please expand the secondary notes.'));
      expect(lineComment).toBeTruthy();
      expect(lineComment?.relativePath).toBe('docs/notes.md');
      expect(lineComment?.lineStart).toBe(2);
      expect(lineComment?.lineEnd).toBe(2);
      expect(lineComment?.anchorCommitHash).toBe(commitHash);
      expect(lineComment?.anchorHasUncommittedChanges).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
