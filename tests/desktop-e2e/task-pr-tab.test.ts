import { execFileSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
} from "./driver";
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  createRoleViaSettings,
  createWorkflowViaSettings,
  openTaskCard,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(250);
  }
  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue)}`);
}

describe("desktop task PR tab", () => {
  it.skipIf(!isDesktopE2E)("keeps the PR tab reviewable when the remote-tracking default branch has no merge base", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "task-pr-tab-repo");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "file.txt"), "base\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "base"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["checkout", "--orphan", "rewritten-main"], { cwd: repoPath, stdio: "ignore" });
    writeFileSync(join(repoPath, "rewritten.txt"), "rewritten\n", "utf8");
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "rewritten"], { cwd: repoPath, stdio: "ignore" });
    const rewrittenCommit = execFileSync("git", ["rev-parse", "HEAD"], { cwd: repoPath, encoding: "utf8" }).trim();
    execFileSync("git", ["update-ref", "refs/remotes/origin/main", rewrittenCommit], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["checkout", "main"], { cwd: repoPath, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "PR Tab Project", "Desktop PR tab regression coverage.");
      await addRepositoryViaSettings(sessionId, {
        name: "PR Tab Repo",
        path: repoPath,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "PR Tab Project");
      await createRoleViaSettings(sessionId, {
        name: "PR Tab Developer",
        capacity: "1",
        description: "Role for PR tab coverage.",
      });
      await createWorkflowViaSettings(sessionId, {
        name: "PR Tab Workflow",
        description: "Single role lane for PR tab coverage.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: "pr-tab-developer",
            entryPromptTemplate: "Review the task changes.",
          },
        ],
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "PR Tab Project") ?? null);
      expect(project).toBeTruthy();
      const repository = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_repositories", { projectId: project!.id })
        .then((repositories) => repositories.find((entry) => entry.name === "PR Tab Repo") ?? null);
      expect(repository).toBeTruthy();
      const role = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_roles", { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === "PR Tab Developer") ?? null);
      expect(role).toBeTruthy();
      const workflow = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_workflows", { includeArchived: false })
        .then((workflows) => workflows.find((entry) => entry.name === "PR Tab Workflow") ?? null)
        .then((summary) => {
          expect(summary).toBeTruthy();
          return invokeCommand<any>(sessionId, "get_workflow", { workflowId: summary!.id });
        });

      const task = await invokeCommand<{ id: string }>(sessionId, "create_task", {
        projectId: project!.id,
        input: {
          title: "PR tab merge-base fallback",
          description: "Ensure the PR tab survives unrelated origin/main refs.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0]?.id ?? null,
          repositoryId: repository!.id,
          repositoryIds: [repository!.id],
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });

      await invokeCommand(sessionId, "dispatch_task_lane", { taskId: task.id }).catch(() => undefined);
      await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
      await invokeCommand(sessionId, "dispatch_role_queue", { roleId: role!.id }).catch(() => undefined);

      await switchProject(sessionId, "PR Tab Project");
      await openTaskCard(sessionId, "PR tab merge-base fallback");
      await clickByText(sessionId, '[role="tab"]', 'Runtime');

      const taskWorktreePath = await waitForCondition(
        async () => {
          await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
          await invokeCommand(sessionId, "dispatch_role_queue", { roleId: role!.id }).catch(() => undefined);
          const taskRepositories = await invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, "list_task_repositories", { taskId: task.id });
          return taskRepositories.find((entry) => typeof entry.taskWorktreePath === "string" && entry.taskWorktreePath.length > 0)?.taskWorktreePath ?? "";
        },
        (value) => Boolean(value),
        45_000,
      );
      expect(taskWorktreePath).toBeTruthy();

      appendFileSync(join(taskWorktreePath, "file.txt"), "worktree change\n", "utf8");

      await clickByText(sessionId, '[role="tab"]', 'PR');
      await waitForCondition(
        () => executeScript<{ fileOptions: string[]; selectedFile: string; selectionMetaText: string; hasError: boolean; hasWorktreeOnly: boolean; repositoryText: string }>(sessionId, `
          const panel = document.querySelector('[data-role="task-detail-tabpanel-pr"]');
          const repositoryCard = panel?.querySelector('[data-role="task-pr-repository-card"]');
          const input = panel?.querySelector('[data-role="task-pr-file-input"]');
          const selectionMeta = panel?.querySelector('[data-role="task-pr-file-selection-meta"]');
          const listId = input?.getAttribute('list');
          const optionRoot = listId ? document.getElementById(listId) : null;
          return {
            fileOptions: Array.from(optionRoot?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value') || ''),
            selectedFile: input instanceof HTMLInputElement ? input.value : '',
            selectionMetaText: (selectionMeta?.textContent || '').replace(/\s+/g, ' ').trim(),
            hasError: Boolean(panel?.querySelector('.error-copy')),
            hasWorktreeOnly: Array.from(repositoryCard?.querySelectorAll('.status-badge') ?? []).some((badge) => (badge.textContent || '').trim() === 'worktree-only'),
            repositoryText: (repositoryCard?.textContent || '').replace(/\s+/g, ' ').trim(),
          };
        `),
        (value) => value.fileOptions.some((text) => text.includes("file.txt")) && value.selectedFile.includes("file.txt") && !value.hasError,
      );

      const prState = await executeScript<{ fileOptions: string[]; selectedFile: string; selectionMetaText: string; hasError: boolean; hasWorktreeOnly: boolean; repositoryText: string }>(sessionId, `
        const panel = document.querySelector('[data-role="task-detail-tabpanel-pr"]');
        const repositoryCard = panel?.querySelector('[data-role="task-pr-repository-card"]');
        const input = panel?.querySelector('[data-role="task-pr-file-input"]');
        const selectionMeta = panel?.querySelector('[data-role="task-pr-file-selection-meta"]');
        const listId = input?.getAttribute('list');
        const optionRoot = listId ? document.getElementById(listId) : null;
        return {
          fileOptions: Array.from(optionRoot?.querySelectorAll('option') ?? []).map((option) => option.getAttribute('value') || ''),
          selectedFile: input instanceof HTMLInputElement ? input.value : '',
          selectionMetaText: (selectionMeta?.textContent || '').replace(/\s+/g, ' ').trim(),
          hasError: Boolean(panel?.querySelector('.error-copy')),
          hasWorktreeOnly: Array.from(repositoryCard?.querySelectorAll('.status-badge') ?? []).some((badge) => (badge.textContent || '').trim() === 'worktree-only'),
          repositoryText: (repositoryCard?.textContent || '').replace(/\s+/g, ' ').trim(),
        };
      `);

      expect(prState.hasError).toBe(false);
      expect(prState.hasWorktreeOnly).toBe(false);
      expect(prState.fileOptions.some((text) => text.includes("file.txt"))).toBe(true);
      expect(prState.selectedFile).toContain("file.txt");
      expect(prState.selectionMetaText).toContain("PR Tab Repo");
      expect(prState.selectionMetaText).toContain("uncommitted");
      expect(prState.repositoryText).toContain("PR Tab Repo");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
