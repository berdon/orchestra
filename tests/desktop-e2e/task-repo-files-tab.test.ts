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
  executeScript,
  invokeCommand,
  selectByLabel,
  setFieldByLabel,
  setInputValue,
  sleep,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  createTaskViaTasks,
  dispatchRoleQueueViaUi,
  openRoleOperations,
  openTaskCard,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function dispatchTaskLaneWithRetries(sessionId: string, taskId: string, timeoutMs = 120_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = "";
  while (Date.now() < deadline) {
    try {
      await invokeCommand(sessionId, 'dispatch_task_lane', { taskId });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!lastError.includes('already processing a message')) {
        throw error;
      }
    }
    await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
    await invokeCommand<Array<{ title?: string; status?: string }>>(sessionId, 'list_sessions', {})
      .then((sessions) => {
        if (!sessions.every((entry) => !String(entry.title ?? '').includes('Supervisor main session') || ['idle', 'paused', 'closed'].includes(String(entry.status ?? '')))) {
          throw new Error('supervisor still busy');
        }
      })
      .catch(() => undefined);
    await sleep(1_000);
  }
  throw new Error(`Timed out dispatching task lane ${taskId}: ${lastError}`);
}

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

      await createProjectViaSettings(sessionId, 'Repo Files Project', 'Desktop repo files tab test.');
      await addRepositoryViaSettings(sessionId, {
        name: 'Repo Files Repo',
        path: repoPath,
        defaultBranch: 'main',
        makeDefault: true,
      });

      const projectsAfterDefault = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const selectedProject = projectsAfterDefault.find((entry) => entry.name === 'Repo Files Project');
      expect(selectedProject).toBeTruthy();

      await switchProject(sessionId, 'Repo Files Project');
      const repository = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_repositories', { projectId: selectedProject!.id })
        .then((repositories) => repositories.find((entry) => entry.name === 'Repo Files Repo'));
      expect(repository).toBeTruthy();
      await invokeCommand(sessionId, 'create_task', {
        projectId: selectedProject!.id,
        input: {
          title: 'Track repo file',
          description: 'Track docs/design.md as a repo file on the task.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: null,
          currentLaneId: null,
          repositoryId: repository!.id,
          repositoryIds: [repository!.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });
      await executeScript(sessionId, `window.dispatchEvent(new CustomEvent('orchestra:projects-changed')); window.location.reload(); return true;`);
      await sleep(1_000);
      await ensureReactReady(sessionId);
      await switchProject(sessionId, 'Repo Files Project');
      await openTaskCard(sessionId, 'Track repo file');

      const tasks = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', { projectId: selectedProject!.id, includeArchived: false });
      const task = tasks.find((entry) => entry.title === 'Track repo file');
      expect(task).toBeTruthy();

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await waitForText(sessionId, 'Tracked repo files');
      await selectByLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Repo');
      await waitForSelectedLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Repo');
      await setInputValue(sessionId, '[data-role="task-file-reference-path"]', 'docs/design.md');
      await clickSelector(sessionId, '[data-role="add-task-file-reference"]');
      await waitForText(sessionId, 'Repo Files Repo · docs/design.md');
      await waitForText(sessionId, 'Resolved path:');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("resolves tracked repo files from the active task worktree when they do not exist in the managed repository", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "repo-files-worktree-repo");
    mkdirSync(join(repoPath, "docs"), { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "Repo files worktree fixture\n", "utf8");
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
          name: 'Repo Files Worktree Project',
          description: 'Desktop task repo file worktree resolution test.',
          taskPrefix: 'RFW',
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, 'create_repository', {
        projectId: project.id,
        input: {
          name: 'Repo Files Worktree Repo',
          repositoryPath: repoPath,
          defaultBranch: 'main',
        },
      });
      await invokeCommand(sessionId, 'set_project_default_repository', {
        projectId: project.id,
        repositoryId: repository.id,
      });
      const developerRole = await invokeCommand<{ id: string; slug: string }>(sessionId, 'create_role', {
        input: {
          name: 'Repo Files Developer',
          description: 'Role for task worktree repo file testing.',
          systemPrompt: 'Create the requested repository file.',
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<any>(sessionId, 'create_workflow', {
        input: {
          name: 'Repo Files Worktree Flow',
          description: 'Single role lane for worktree file tests.',
          lanes: [
            {
              id: 'lane-implement',
              key: 'implement',
              name: 'Implement',
              order: 0,
              assignedEntityType: 'role',
              assignedEntityId: developerRole.slug,
              entryPromptTemplate: 'Create the requested repository file.',
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'end',
              failureTargetLaneId: null,
            },
          ],
        },
      });
      const createdTask = await invokeCommand<{ id: string }>(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Track worktree-only repo file',
          description: 'Verify repo file references resolve against the task worktree.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: 'lane-implement',
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });
      await switchProject(sessionId, 'Repo Files Worktree Project');
      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.id === createdTask.id));
      expect(task).toBeTruthy();

      await dispatchTaskLaneWithRetries(sessionId, task!.id);
      await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
      await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: developerRole.id }).catch(() => undefined);

      await openTaskCard(sessionId, 'Track worktree-only repo file');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');

      const deadline = Date.now() + 30_000;
      let taskWorktreePath = "";
      while (Date.now() < deadline) {
        await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
        await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: developerRole.id }).catch(() => undefined);
        const taskRepositories = await invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, 'list_task_repositories', { taskId: task!.id });
        taskWorktreePath = taskRepositories.find((entry) => typeof entry.taskWorktreePath === 'string' && entry.taskWorktreePath.length > 0)?.taskWorktreePath ?? "";
        if (!taskWorktreePath) {
          const taskDetail = await invokeCommand<any>(sessionId, 'get_task', { taskId: task!.id });
          taskWorktreePath = String(taskDetail.activeLaneAssignment?.runtimeCwd ?? '');
        }
        if (taskWorktreePath) {
          break;
        }
        await sleep(500);
      }
      expect(taskWorktreePath).toBeTruthy();

      const relativePath = 'docs/generated-plan.md';
      mkdirSync(join(taskWorktreePath, 'docs'), { recursive: true });
      writeFileSync(join(taskWorktreePath, relativePath), 'Generated inside the task worktree\n', 'utf8');

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await waitForText(sessionId, 'Tracked repo files');
      await selectByLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Worktree Repo');
      await waitForSelectedLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Worktree Repo');
      await setInputValue(sessionId, '[data-role="task-file-reference-path"]', relativePath);
      await clickSelector(sessionId, '[data-role="add-task-file-reference"]');

      await waitForText(sessionId, 'Repo Files Worktree Repo · docs/generated-plan.md');
      await waitForText(sessionId, 'Available');
      await waitForText(sessionId, 'Task worktree:');
      await waitForText(sessionId, 'Resolved path:');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
