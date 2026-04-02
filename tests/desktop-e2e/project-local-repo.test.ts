import { existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  setInputValue,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop local repository project flow", () => {
  it.skipIf(!isDesktopE2E)("creates a managed local repository and later attaches a remote through the real desktop UI", async () => {
    expect(testHome).toBeTruthy();

    const managedRepoPath = join(
      testHome!,
      ".orchestra",
      "projects",
      "local-repo-project",
      "repositories",
      "brand-new-repo",
      "repository",
    );
    const remoteUrl = "git@example.com:demo/brand-new-repo.git";

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, "Project catalog");
      await clickByText(sessionId, "button", "New project");
      await setInputValue(sessionId, '[data-role="project-name"]', "Local Repo Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Project with a brand-new managed local repository.");
      await clickByText(sessionId, "button", "Create project");
      await waitForText(sessionId, "Local Repo Project");

      await clickSelector(sessionId, '[data-role="repository-mode-local-new"]');
      await waitForText(sessionId, "managed repository directory becomes the main repository directory");
      await setInputValue(sessionId, '[data-role="repository-name"]', "Brand New Repo");
      await setInputValue(sessionId, '[data-role="repository-default-branch"]', "main");
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await waitForText(sessionId, "Brand New Repo");
      await waitForText(sessionId, "Local only");

      const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects");
      const project = projects.find((entry) => entry.name === "Local Repo Project");
      expect(project).toBeTruthy();

      const projectDetail = await invokeCommand<{
        defaultRepositoryId: string | null;
        repositories: Array<{
          id: string;
          name: string;
          repositoryPath: string | null;
          sourcePath: string | null;
          sourceKind: string | null;
          mode: string | null;
        }>;
      }>(sessionId, "get_project", { projectId: project!.id });

      const repository = projectDetail.repositories.find((entry) => entry.name === "Brand New Repo");
      expect(repository).toBeTruthy();
      expect(projectDetail.defaultRepositoryId).toBe(repository!.id);
      expect(repository!.repositoryPath).toBe(managedRepoPath);
      expect(repository!.sourcePath).toBeNull();
      expect(repository!.sourceKind).toBeNull();
      expect(repository!.mode).toBe("local_new");
      expect(existsSync(managedRepoPath)).toBe(true);
      expect(existsSync(join(managedRepoPath, ".git"))).toBe(true);

      await clickSelector(sessionId, `[data-role="toggle-repository-remote-${repository!.id}"]`);
      await setInputValue(sessionId, '[data-role="repository-remote-url"]', remoteUrl);
      await clickSelector(sessionId, `[data-role="attach-repository-remote-${repository!.id}"]`);
      await waitForText(sessionId, remoteUrl);
      await waitForText(sessionId, "Remote attached");

      const updatedProject = await invokeCommand<typeof projectDetail>(sessionId, "get_project", { projectId: project!.id });
      const updatedRepository = updatedProject.repositories.find((entry) => entry.id === repository!.id);
      expect(updatedRepository?.sourcePath).toBe(remoteUrl);
      expect(updatedRepository?.sourceKind).toBe("remote");
      expect(updatedRepository?.mode).toBe("local_new");
      expect(execFileSync("git", ["remote", "get-url", "origin"], { cwd: managedRepoPath, encoding: "utf8" }).trim()).toBe(remoteUrl);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
