import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
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
  selectValue,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectOption,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForActiveAssignmentSession(sessionId: string, taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await invokeCommand<any>(sessionId, "get_task", { taskId });
    const activeSessionId = task.activeLaneAssignment?.sessionId as string | undefined;
    if (activeSessionId) {
      return { task, sessionId: activeSessionId };
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for active assignment session on task ${taskId}`);
}

async function waitForTaskStatus(sessionId: string, taskId: string, status: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const task = await invokeCommand<any>(sessionId, "get_task", { taskId });
    if (task.status === status) {
      return task;
    }
    await sleep(500);
  }
  throw new Error(`Timed out waiting for task ${taskId} to reach status ${status}`);
}

describe("desktop single-use role runtimes", () => {
  it.skipIf(!isDesktopE2E)("creates a fresh role instance/session/worktree for each dispatched task", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "single-use-role-repo");
    rmSync(repoPath, { recursive: true, force: true });
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "single-use role runtime repo\n", "utf8");
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
      await setInputValue(sessionId, '[data-role="project-name"]', "Single Use Role Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Desktop regression for single-use role runtimes.");
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, "Single Use Role Project");
      await waitForSelector(sessionId, '[data-role="repository-name"]');

      await setFieldByLabel(sessionId, "Repository name", "Single Use Role Repo");
      await setFieldByLabel(sessionId, "Repository Path", repoPath);
      await setFieldByLabel(sessionId, "Default branch", "main");
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, "Single Use Role Repo");
      await clickByText(sessionId, "button", "Make default");
      await waitForText(sessionId, "Default");

      const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const project = projects.find((entry) => entry.name === 'Single Use Role Project');
      expect(project).toBeTruthy();

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Single Use Role Project");
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', "Single Use Role Project");
      await sleep(500);

      await clickByText(sessionId, '[role="tab"]', "Roles");
      await clickSelector(sessionId, '[data-role="new-role"]');
      await setInputValue(sessionId, '[data-role="role-name"]', 'Single Use Worker');
      await setFieldByLabel(sessionId, 'Capacity', '1');
      await setFieldByLabel(sessionId, 'Description', 'Transient single-use worker for regression coverage.');
      await clickSelector(sessionId, '[data-role="save-role"]');
      await waitForText(sessionId, 'Single Use Worker');
      const roles = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false });
      const role = roles.find((entry) => entry.name === 'Single Use Worker');
      expect(role).toBeTruthy();

      await clickByText(sessionId, '[role="tab"]', 'Workflows');
      await clickByText(sessionId, 'button', 'New workflow');
      await setFieldByLabel(sessionId, 'Workflow name', 'Single Use Flow');
      await setFieldByLabel(sessionId, 'Lane name', 'Implement');
      await setFieldByLabel(sessionId, 'Lane key', 'implement');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', 'single-use-worker');
      await clickSelector(sessionId, '[data-role="save-workflow"]');
      await waitForText(sessionId, 'Single Use Flow');

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'New task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'First single-use task');
      await setInputValue(sessionId, '[data-role="task-description"]', 'Dispatch the first role-owned task.');
      await waitForSelectOption(sessionId, '[data-role="task-repositories"]', { label: 'Single Use Role Repo' });
      await selectByLabel(sessionId, '[data-role="task-repositories"]', 'Single Use Role Repo');
      await waitForSelectOption(sessionId, '[data-role="task-workflow"]', { label: 'Single Use Flow' });
      await selectByLabel(sessionId, '[data-role="task-workflow"]', 'Single Use Flow');
      await clickSelector(sessionId, '[data-role="publish-task"]');
      await waitForText(sessionId, 'First single-use task');

      const firstTasks = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', { projectId: project!.id, includeArchived: false });
      const firstTask = firstTasks.find((task) => task.title === 'First single-use task');
      expect(firstTask).toBeTruthy();

      const firstAssignment = await waitForActiveAssignmentSession(sessionId, firstTask!.id);
      const firstSession = await invokeCommand<any>(sessionId, 'get_session_record', { sessionId: firstAssignment.sessionId });
      expect(firstSession.debugInfo?.projectRoot).toBe(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(firstSession.debugInfo?.managedRepositoryPath).toBe(join(testHome!, '.orchestra', 'projects', 'single-use-role-project', 'repositories', 'single-use-role-repo', 'repository'));
      expect(firstSession.debugInfo?.worktreePath).toContain(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(firstSession.debugInfo?.sessionCwd).toContain(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(existsSync(firstSession.debugInfo?.worktreePath ?? '')).toBe(true);
      const firstRoleOperations = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      const firstRunningInstance = firstRoleOperations.instances.find((entry: any) => entry.status === 'running');
      expect(firstRunningInstance).toBeTruthy();

      await clickSelector(sessionId, '[data-role="complete-task-success"]');
      await waitForTaskStatus(sessionId, firstTask!.id, 'completed');

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'New task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'Second single-use task');
      await setInputValue(sessionId, '[data-role="task-description"]', 'Dispatch the second role-owned task.');
      await waitForSelectOption(sessionId, '[data-role="task-repositories"]', { label: 'Single Use Role Repo' });
      await selectByLabel(sessionId, '[data-role="task-repositories"]', 'Single Use Role Repo');
      await waitForSelectOption(sessionId, '[data-role="task-workflow"]', { label: 'Single Use Flow' });
      await selectByLabel(sessionId, '[data-role="task-workflow"]', 'Single Use Flow');
      await clickSelector(sessionId, '[data-role="publish-task"]');
      await waitForText(sessionId, 'Second single-use task');

      const secondTasks = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', { projectId: project!.id, includeArchived: false });
      const secondTask = secondTasks.find((task) => task.title === 'Second single-use task');
      expect(secondTask).toBeTruthy();

      const secondAssignment = await waitForActiveAssignmentSession(sessionId, secondTask!.id);
      const secondSession = await invokeCommand<any>(sessionId, 'get_session_record', { sessionId: secondAssignment.sessionId });
      expect(secondSession.debugInfo?.projectRoot).toBe(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(secondSession.debugInfo?.managedRepositoryPath).toBe(join(testHome!, '.orchestra', 'projects', 'single-use-role-project', 'repositories', 'single-use-role-repo', 'repository'));
      expect(secondSession.debugInfo?.worktreePath).toContain(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(secondSession.debugInfo?.sessionCwd).toContain(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(existsSync(secondSession.debugInfo?.worktreePath ?? '')).toBe(true);

      const roleOperations = await invokeCommand<any>(sessionId, 'get_role_operations', { roleId: role!.id });
      const runningInstance = roleOperations.instances.find((entry: any) => entry.status === 'running');
      expect(runningInstance).toBeTruthy();
      expect(secondAssignment.sessionId).not.toBe(firstAssignment.sessionId);
      expect(runningInstance.sessionId).toBe(secondAssignment.sessionId);
      expect(runningInstance.worktreePath).toContain(join(testHome!, '.orchestra', 'projects', 'single-use-role-project'));
      expect(runningInstance.id).not.toBe(firstRunningInstance.id);
      expect(runningInstance.worktreePath).not.toBe(firstRunningInstance.worktreePath);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
