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
  sleep,
  waitForSelectedLabel,
  waitForText,
} from "./driver";
import { openTaskCard } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task comment file mention links", () => {
  it.skipIf(!isDesktopE2E)("opens the referenced task file in the repo-files pane when a rendered $file mention is clicked", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "comment-file-links-repo");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "docs", "design.md"), "Design link target\n", "utf8");
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
          name: "Comment Link Project",
          description: "Desktop $file link test.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Comment Link Repo",
          repositoryPath: repoPath,
          defaultBranch: "main",
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Comment mention link task",
          description: "Clicking $file mentions should open the tracked file.",
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
      await invokeCommand(sessionId, "add_task_file_reference", {
        taskId: task.id,
        input: {
          repositoryId: repository.id,
          relativePath: "docs/design.md",
        },
      });
      await invokeCommand(sessionId, "comment_on_task", {
        taskId: task.id,
        input: {
          author: "Reviewer",
          message: "Please review $docs/design.md before you continue.",
          interruptAgent: false,
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [task.id], reason: "task.commented" });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await openTaskCard(sessionId, "Comment mention link task");
      await waitForText(sessionId, "Please review docs/design.md before you continue.");
      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="task-comment-mention-link"]');
        if (!(button instanceof HTMLElement)) return false;
        button.click();
        return true;
      `);
      await waitForText(sessionId, "Tracked repository file changes and references");
      let repoFileState: { selectedLabel: string; cardTop: number | null } | null = null;
      const deadline = Date.now() + 10_000;
      while (Date.now() < deadline) {
        repoFileState = await executeScript<{ selectedLabel: string; cardTop: number | null }>(sessionId, `
          const select = document.querySelector('[data-role="task-file-references"] select');
          const card = document.querySelector('[data-role="selected-task-file-reference-card"]');
          return {
            selectedLabel: select instanceof HTMLSelectElement ? (select.options[select.selectedIndex]?.textContent || '') : '',
            cardTop: card instanceof HTMLElement ? card.getBoundingClientRect().top : null,
          };
        `);
        if (repoFileState.cardTop !== null) {
          break;
        }
        await sleep(250);
      }
      if (!repoFileState) {
        throw new Error('Unable to read repo file navigation state');
      }
      expect(repoFileState.selectedLabel).toContain("docs/design.md");
      expect(repoFileState.cardTop).not.toBeNull();
      expect((repoFileState.cardTop ?? 0) >= 0).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
