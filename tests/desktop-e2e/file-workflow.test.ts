import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  selectByLabel,
  selectValue,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;
const targetFile = "/tmp/file.md";
const targetContents = "desktop-e2e-ok\n";

describe("desktop file workflow", () => {
  it.skipIf(!isDesktopE2E)("creates /tmp/file.md from a UI-defined task and referenced project file", async () => {
    expect(testHome).toBeTruthy();
    rmSync(targetFile, { force: true });

    const repoPath = join(testHome!, "workspace", "file-workflow-repo");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(
      join(repoPath, "docs", "design.md"),
      `Create the file ${targetFile} with exactly this content:\n${targetContents}`,
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

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, "project catalog");
      await sleep(500);
      await clickByText(sessionId, "button", "New project");
      await sleep(500);
      await setInputValue(sessionId, '[data-role="project-name"]', 'File Workflow Project');
      await setInputValue(sessionId, '[data-role="project-description"]', 'Real desktop file creation workflow test.');
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, 'File Workflow Project');
      await waitForSelector(sessionId, '[data-role="repository-name"]');

      await setInputValue(sessionId, '[data-role="repository-name"]', 'File Workflow Repo');
      await setInputValue(sessionId, '[data-role="repository-local-path"]', repoPath);
      await setInputValue(sessionId, '[data-role="repository-default-branch"]', 'main');
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, 'File Workflow Repo');

      await selectByLabel(sessionId, '[data-role="project-switcher"]', 'File Workflow Project');
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', 'File Workflow Project');
      await sleep(1_500);

      await clickByText(sessionId, '[role="tab"]', 'Roles');
      await clickSelector(sessionId, '[data-role="new-role"]');
      await setInputValue(sessionId, '[data-role="role-name"]', 'File Builder');
      await setFieldByLabel(sessionId, 'Capacity', '1');
      await setFieldByLabel(sessionId, 'Description', 'Creates the requested file and closes the task automatically.');
      await setFieldByLabel(sessionId, 'System prompt', 'Read the referenced project files carefully, follow their instructions exactly, create the requested file for real, and mark the lane as success when the work is done.');
      await clickSelector(sessionId, '[data-role="role-supervisor-toggle"]');
      await clickSelector(sessionId, '[data-role="save-role"]');
      await waitForText(sessionId, 'File Builder');

      await clickByText(sessionId, '[role="tab"]', 'Workflows');
      await clickByText(sessionId, 'button', 'New workflow');
      await setFieldByLabel(sessionId, 'Workflow name', 'File Creation Flow');
      await setFieldByLabel(sessionId, 'Lane name', 'Create File');
      await setFieldByLabel(sessionId, 'Lane key', 'create-file');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', 'file-builder');
      await setFieldByLabel(sessionId, 'Entry prompt template', 'Read the task description and referenced project files, perform the required file creation for real, and mark success when complete.');
      await clickSelector(sessionId, '[data-role="save-workflow"]');
      await waitForText(sessionId, 'File Creation Flow');

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'new task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'Create /tmp/file.md');
      await setInputValue(sessionId, '[data-role="task-description"]', 'Read the referenced project file and do exactly what it says.');
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await selectByLabel(sessionId, '[data-role="task-workflow"]', 'File Creation Flow');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Create /tmp/file.md');
      await selectByLabel(sessionId, '[data-role="project-switcher"]', 'File Workflow Project');
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', 'File Workflow Project');
      await sleep(250);

      await selectByLabel(sessionId, '[data-role="task-file-reference-repository"]', 'File Workflow Repo');
      await waitForSelectedLabel(sessionId, '[data-role="task-file-reference-repository"]', 'File Workflow Repo');
      await setInputValue(sessionId, '[data-role="task-file-reference-path"]', 'docs/design.md');
      await sleep(500);
      await clickSelector(sessionId, '[data-role="add-task-file-reference"]');
      await waitForText(sessionId, 'File Workflow Repo · docs/design.md');
      await waitForText(sessionId, 'Available');
      await waitForText(sessionId, 'Absolute path:');

      await clickSelector(sessionId, '[data-role="dispatch-task-lane"]');

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && !existsSync(targetFile)) {
        await sleep(1_000);
      }

      expect(existsSync(targetFile)).toBe(true);
      expect(readFileSync(targetFile, 'utf8')).toBe(targetContents);

      await clickSelector(sessionId, '[data-role="complete-task-success"]');
      await waitForText(sessionId, 'completed');
      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'File Builder · ORC-1 · Create /tmp/file.md');
    } finally {
      await deleteWebdriverSession(sessionId);
      rmSync(targetFile, { force: true });
    }
  }, 240_000);
});
