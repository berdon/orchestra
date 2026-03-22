import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  selectByLabel,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task repo files tab", () => {
  it.skipIf(!isDesktopE2E)("shows tracked repo files in the dedicated task detail tab", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "repo-files-tab-repo");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "docs", "design.md"), "Repo files tab fixture\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, "Project catalog");
      await clickByText(sessionId, "button", "New project");
      await waitForText(sessionId, "New project");
      await setInputValue(sessionId, '[data-role="project-name"]', "Repo Files Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Desktop repo files tab test.");
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, "Repo Files Project");
      await waitForSelector(sessionId, '[data-role="repository-name"]');

      await setFieldByLabel(sessionId, "Repository name", "Repo Files Repo");
      await setFieldByLabel(sessionId, "Repository Path", repoPath);
      await setFieldByLabel(sessionId, "Default branch", "main");
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, "Repo Files Repo");
      await clickByText(sessionId, "button", "Make default");
      await waitForText(sessionId, "Default");

      const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const project = projects.find((entry) => entry.name === 'Repo Files Project');
      expect(project).toBeTruthy();

      await selectByLabel(sessionId, '[data-role="project-switcher"]', 'Repo Files Project');
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', 'Repo Files Project');
      await sleep(500);

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'New task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'Track repo file');
      await setInputValue(sessionId, '[data-role="task-description"]', 'Track docs/design.md as a repo file on the task.');
      await selectByLabel(sessionId, '[data-role="task-repositories"]', 'Repo Files Repo');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Track repo file');

      const tasks = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', { projectId: project!.id, includeArchived: false });
      const task = tasks.find((entry) => entry.title === 'Track repo file');
      expect(task).toBeTruthy();

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await waitForText(sessionId, 'Tracked repository file changes and references');
      await selectByLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Repo');
      await waitForSelectedLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Repo');
      await setInputValue(sessionId, '[data-role="task-file-reference-path"]', 'docs/design.md');
      await clickSelector(sessionId, '[data-role="add-task-file-reference"]');
      await waitForText(sessionId, 'Repo Files Repo · docs/design.md');
      await waitForText(sessionId, 'Absolute path:');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
