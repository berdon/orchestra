import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectByLabel,
  setInputValue,
  waitForSelectedLabel,
  waitForText,
} from "./driver";
import { openTaskCard } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task quick comment file mentions", () => {
  it.skipIf(!isDesktopE2E)("supports $file mention text in the quick comment composer and opens the referenced file from the rendered comment", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "quick-comment-file-mentions-repo");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "docs", "design.md"), "Design mention target\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Quick Comment Mention Project",
          taskPrefix: "QCM",
          description: "Desktop quick comment file mention test.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Quick Comment Repo",
          repositoryPath: repoPath,
          defaultBranch: "main",
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Quick comment mention task",
          description: "Use $file mentions in quick comments.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          parentTaskId: null,
          archived: false,
        },
      });
      const reference = await invokeCommand<{ id: string }>(sessionId, "add_task_file_reference", {
        taskId: task.id,
        input: {
          repositoryId: repository.id,
          relativePath: "docs/design.md",
        },
      });
      await invokeCommand(sessionId, "set_default_task_file_reference", { referenceId: reference.id });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [task.id], reason: "task.file_reference.added" });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await openTaskCard(sessionId, "Quick comment mention task");
      await waitForText(sessionId, "Comment on this task");

      await setInputValue(sessionId, '[data-role="default-file-quick-comment-message"]', 'Please inspect $docs/design.md');

      const quickCommentValue = await executeScript<string>(sessionId, `
        const textarea = document.querySelector('[data-role="default-file-quick-comment-message"]');
        return textarea instanceof HTMLTextAreaElement ? textarea.value : '';
      `);
      expect(quickCommentValue).toContain('$docs/design.md');

      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="add-default-file-quick-comment"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      `);
      await waitForText(sessionId, 'Please inspect docs/design.md');

      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="task-comment-mention-link"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      `);
      await waitForText(sessionId, 'Tracked repo files');
      const selectedLabel = await executeScript<string>(sessionId, `
        const select = document.querySelector('[data-role="task-file-references"] select');
        if (!(select instanceof HTMLSelectElement)) return '';
        return select.options[select.selectedIndex]?.textContent || '';
      `);
      expect(selectedLabel).toContain('docs/design.md');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
