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
  executeScript,
  invokeCommand,
  selectByLabel,
  selectValue,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";
import { completeTaskSuccessViaUi } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;
const targetFile = "/tmp/file.md";
const targetContents = "desktop-e2e-ok\n";

async function waitForDispatchButton(sessionId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastState: unknown = null;

  while (Date.now() < deadline) {
    lastState = await executeScript(sessionId, `
      const button = document.querySelector('[data-role="dispatch-task-lane"], [data-role="publish-task"]');
      return {
        present: Boolean(button),
        text: document.body ? document.body.innerText : "",
      };
    `);

    if ((lastState as { present?: boolean }).present) {
      return;
    }

    await sleep(250);
  }

  throw new Error(`Dispatch button did not appear: ${JSON.stringify(lastState)}`);
}

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

      await setFieldByLabel(sessionId, 'Repository name', 'File Workflow Repo');
      await setFieldByLabel(sessionId, 'Repository Path', repoPath);
      await setFieldByLabel(sessionId, 'Default branch', 'main');
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, 'File Workflow Repo');

      const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const project = projects.find((entry) => entry.name === 'File Workflow Project');
      expect(project).toBeTruthy();
      await clickByText(sessionId, 'button', 'Make default');

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
      await selectByLabel(sessionId, '[data-role="task-repositories"]', 'File Workflow Repo');
      await selectByLabel(sessionId, '[data-role="task-workflow"]', 'File Creation Flow');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Create /tmp/file.md');
      const savedTasks = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', { projectId: project!.id, includeArchived: false });
      const savedTask = savedTasks.find((task) => task.title === 'Create /tmp/file.md');
      expect(savedTask).toBeTruthy();

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

      await waitForDispatchButton(sessionId);
      const dispatchSelector = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="dispatch-task-lane"]') ? '[data-role="dispatch-task-lane"]' : '[data-role="publish-task"]';
      `);
      await clickSelector(sessionId, dispatchSelector);
      const worktreeDeadline = Date.now() + 30_000;
      let taskRepositories: Array<{ taskWorktreePath?: string | null }> = [];
      while (Date.now() < worktreeDeadline) {
        taskRepositories = await invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, 'list_task_repositories', { taskId: savedTask!.id });
        if (taskRepositories.some((entry) => typeof entry.taskWorktreePath === 'string' && entry.taskWorktreePath.length > 0)) {
          break;
        }
        await sleep(500);
      }
      expect(taskRepositories.some((entry) => typeof entry.taskWorktreePath === 'string' && entry.taskWorktreePath.length > 0)).toBe(true);

      const dispatchedTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: savedTask!.id });
      expect(dispatchedTask.activeLaneAssignment?.sessionId).toBeTruthy();
      const spawnedSession = await invokeCommand<any>(sessionId, 'get_session_record', {
        sessionId: dispatchedTask.activeLaneAssignment.sessionId,
      });
      expect(spawnedSession.debugInfo?.projectRoot).toBe(join(testHome!, '.orchestra', 'projects', 'file-workflow-project'));
      expect(spawnedSession.debugInfo?.managedRepositoryPath).toBe(join(testHome!, '.orchestra', 'projects', 'file-workflow-project', 'repositories', 'file-workflow-repo', 'repository'));
      expect(spawnedSession.debugInfo?.worktreePath).toContain(join(testHome!, '.orchestra', 'projects', 'file-workflow-project'));
      expect(spawnedSession.debugInfo?.sessionCwd).toContain(join(testHome!, '.orchestra', 'projects', 'file-workflow-project'));
      expect(spawnedSession.debugInfo?.sessionCwd).not.toBe(process.env.ORCHESTRA_PROJECT_ROOT);

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && !existsSync(targetFile)) {
        await sleep(1_000);
      }

      expect(existsSync(targetFile)).toBe(true);
      expect(readFileSync(targetFile, 'utf8')).toBe(targetContents);

      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await completeTaskSuccessViaUi(sessionId);
      await waitForText(sessionId, 'completed');
      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'File Builder · ORC-1 · Create /tmp/file.md');
    } finally {
      await deleteWebdriverSession(sessionId);
      rmSync(targetFile, { force: true });
    }
  }, 240_000);
});
