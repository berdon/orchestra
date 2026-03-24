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

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Repo Files Worktree Project",
          description: "Desktop task repo file worktree resolution test.",
        },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, "Project catalog");
      await waitForText(sessionId, project.name);
      await waitForSelector(sessionId, '[data-role="repository-name"]');

      await setFieldByLabel(sessionId, "Repository name", "Repo Files Worktree Repo");
      await setFieldByLabel(sessionId, "Repository Path", repoPath);
      await setFieldByLabel(sessionId, "Default branch", "main");
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, "Repo Files Worktree Repo");
      await clickByText(sessionId, "button", "Make default");
      await waitForText(sessionId, "Default");

      const repository = await invokeCommand<Array<{ id: string; name: string; slug: string }>>(sessionId, "list_repositories", { projectId: project.id })
        .then((repositories) => repositories.find((entry) => entry.name === "Repo Files Worktree Repo"));
      expect(repository).toBeTruthy();

      const role = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Repo Files Developer",
          description: "Role for task worktree repo file testing.",
          systemPrompt: null,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });
      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Repo Files Worktree Flow",
          description: "Single role lane for worktree file tests.",
          lanes: [
            {
              id: null,
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Create the requested repository file.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "user_intervention",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Track worktree-only repo file",
          description: "Verify repo file references resolve against the task worktree.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository!.id,
          parentTaskId: null,
          archived: false,
        },
      });
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [task.id], reason: "task.created" });

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[data-role="task-card"]', task.title);
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await clickSelector(sessionId, '[data-role="dispatch-task-lane"]');

      const deadline = Date.now() + 30_000;
      let taskWorktreePath = "";
      while (Date.now() < deadline) {
        const taskRepositories = await invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, 'list_task_repositories', { taskId: task.id });
        taskWorktreePath = taskRepositories.find((entry) => typeof entry.taskWorktreePath === 'string' && entry.taskWorktreePath.length > 0)?.taskWorktreePath ?? "";
        if (taskWorktreePath) {
          break;
        }
        await sleep(500);
      }
      expect(taskWorktreePath).toBeTruthy();

      const relativePath = 'docs/generated-plan.md';
      const worktreeFilePath = join(taskWorktreePath, relativePath);
      mkdirSync(join(taskWorktreePath, 'docs'), { recursive: true });
      writeFileSync(worktreeFilePath, 'Generated inside the task worktree\n', 'utf8');

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await waitForText(sessionId, 'Tracked repository file changes and references');
      await selectByLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Worktree Repo');
      await waitForSelectedLabel(sessionId, '[data-role="task-file-reference-repository"]', 'Repo Files Worktree Repo');
      await setInputValue(sessionId, '[data-role="task-file-reference-path"]', relativePath);
      await clickSelector(sessionId, '[data-role="add-task-file-reference"]');

      await waitForText(sessionId, 'Repo Files Worktree Repo · docs/generated-plan.md');
      await waitForText(sessionId, 'Available');
      await waitForText(sessionId, worktreeFilePath);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
