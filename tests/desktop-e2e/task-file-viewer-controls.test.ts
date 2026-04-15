import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectByLabel,
  waitForSelectedLabel,
  waitForText,
} from "./driver";
import { openTaskCard } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task file viewer controls", () => {
  it.skipIf(!isDesktopE2E)("scrolls the default file viewer to the bottom and omits the Resizable label", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "task-file-viewer-controls-repo", "repository");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "design.md"),
      [
        "Alpha line",
        "Beta line",
        "Gamma line",
        ...Array.from({ length: 80 }, (_, index) => `Extra filler line ${index + 4}`),
      ].join("\n"),
      "utf8",
    );
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
          name: "File Viewer Controls Project",
          description: "Desktop file viewer controls test.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "File Viewer Controls Repo",
          repositoryPath: repoPath,
          defaultBranch: "main",
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Viewer controls task",
          description: "Exercise the default file viewer controls.",
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

      await openTaskCard(sessionId, task.title);
      await waitForText(sessionId, "Default repo file");
      await waitForText(sessionId, "docs/design.md");

      const headerText = await executeScript<string>(sessionId, `
        return document.querySelector('.file-content-viewer__header')?.textContent || '';
      `);
      expect(headerText).not.toContain("Resizable");

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
      await waitForText(sessionId, "Expand");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
