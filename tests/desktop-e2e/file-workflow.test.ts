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
      const repositories = await invokeCommand<Array<{ id: string; name: string; projectId: string }>>(sessionId, 'list_repositories', { projectId: project!.id });
      const repository = repositories.find((entry) => entry.name === 'File Workflow Repo');
      expect(repository).toBeTruthy();
      await invokeCommand(sessionId, 'set_project_default_repository', { projectId: project!.id, repositoryId: repository!.id });

      await selectByLabel(sessionId, '[data-role="project-switcher"]', 'File Workflow Project');
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', 'File Workflow Project');
      await sleep(1_500);

      const agent = await invokeCommand<{ id: string; slug: string; name: string }>(sessionId, 'create_agent', {
        input: {
          name: 'File Builder',
          description: 'Creates the requested file and closes the task automatically.',
          systemPrompt: [
            'You are a deterministic Orchestra agent.',
            'Read the task description and any referenced project files carefully.',
            `Create the exact file ${targetFile} with exactly ${JSON.stringify(targetContents)}.`,
            'Verify the file contents exactly match the request.',
            'Do not ask questions.',
            'When the work is complete, call complete_lane_as_success with a concise lane summary and optional notes.',
            'If anything fails, call request_user_intervention.',
          ].join(' '),
          provider: 'openai-codex',
          model: 'gpt-5.3-codex-spark',
          thinkingLevel: 'off',
          policyIds: ['policy-supervisor'],
        },
      });

      await invokeCommand(sessionId, 'create_workflow', {
        input: {
          name: 'File Creation Flow',
          description: 'Single deterministic agent lane for file creation.',
          lanes: [
            {
              name: 'Create File',
              key: 'create-file',
              assignedEntityType: 'agent',
              assignedEntityId: agent.slug,
              entryPromptTemplate: 'Read the task description and referenced project files, perform the required file creation for real, and mark success when complete.',
              successTransitionType: 'end',
              failureTransitionType: 'end',
            },
          ],
        },
      });

      await clickByText(sessionId, '[role="tab"]', 'Workflows');
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
      await waitForText(sessionId, 'Resolved path:');

      await waitForDispatchButton(sessionId);
      const dispatchSelector = await executeScript<string>(sessionId, `
        return document.querySelector('[data-role="dispatch-task-lane"]') ? '[data-role="dispatch-task-lane"]' : '[data-role="publish-task"]';
      `);
      await clickSelector(sessionId, dispatchSelector);
      const taskRepositories = await invokeCommand<Array<{ taskWorktreePath?: string | null; managedRepositoryPath?: string | null }>>(sessionId, 'list_task_repositories', { taskId: savedTask!.id });
      expect(taskRepositories.some((entry) => typeof entry.managedRepositoryPath === 'string' && entry.managedRepositoryPath.length > 0)).toBe(true);

      const deadline = Date.now() + 180_000;
      while (Date.now() < deadline && !existsSync(targetFile)) {
        await sleep(1_000);
      }

      expect(existsSync(targetFile)).toBe(true);
      expect(readFileSync(targetFile, 'utf8').trimEnd()).toBe(targetContents.trimEnd());

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'File Builder main session');
    } finally {
      await deleteWebdriverSession(sessionId);
      rmSync(targetFile, { force: true });
    }
  }, 240_000);
});
