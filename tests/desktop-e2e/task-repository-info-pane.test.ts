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
  setInputValue,
  waitForSelectedLabel,
  waitForText,
} from "./driver";
import { addRepositoryViaSettings, createProjectViaSettings } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task repository info pane", () => {
  it.skipIf(!isDesktopE2E)("shows associated repository information in the task project files pane", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "task-repository-info-repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "task repository info fixture\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Task Repository Info Project", "Desktop repository info pane test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Task Repository Info Repo",
        path: repoPath,
        defaultBranch: "main",
        makeDefault: false,
      });

      const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const project = projects.find((entry) => entry.name === 'Task Repository Info Project');
      expect(project).toBeTruthy();
      const repositories = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_repositories', { projectId: project!.id });
      const repository = repositories.find((entry) => entry.name === 'Task Repository Info Repo');
      expect(repository).toBeTruthy();
      await invokeCommand(sessionId, 'set_project_default_repository', { projectId: project!.id, repositoryId: repository!.id });
      await waitForText(sessionId, "Default");

      const projectsAfterDefault = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const selectedProject = projectsAfterDefault.find((entry) => entry.name === 'Task Repository Info Project');
      expect(selectedProject).toBeTruthy();

      await selectByLabel(sessionId, '[data-role="project-switcher"]', 'Task Repository Info Project');
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', 'Task Repository Info Project');

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'New task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'Inspect repository info');
      await setInputValue(sessionId, '[data-role="task-description"]', 'Show repository metadata in the task pane.');
      await selectByLabel(sessionId, '[data-role="task-repositories"]', 'Task Repository Info Repo');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Inspect repository info');

      await clickByText(sessionId, '[role="tab"]', 'Repo files');
      await waitForText(sessionId, 'Task Repository Info Repo');
      await waitForText(sessionId, 'Repository slug: task-repository-info-repo');
      await waitForText(sessionId, 'Managed path:');
      await waitForText(sessionId, 'Source path:');
      await waitForText(sessionId, 'Task worktree: Not materialized yet');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
