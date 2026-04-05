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
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import {
  addRepositoryViaSettings,
  addTaskCommentViaUi,
  addTaskFileReferenceViaUi,
  createProjectViaSettings,
  createRoleViaSettings,
  createTaskViaTasks,
  createWorkflowViaSettings,
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
    await sleep(500);
  }

  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

describe("desktop task detail reorganization", () => {
  it.skipIf(!isDesktopE2E)("hides edit details by default, shows default repo file preview, and persists recent history limit", async () => {
    expect(testHome).toBeTruthy();

    const repoRoot = join(testHome!, "workspace", "task-detail-reorg-repo", "repository");
    mkdirSync(join(repoRoot, "docs"), { recursive: true });
    writeFileSync(join(repoRoot, "docs", "design.md"), "# Design\n\nTask detail preview file\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoRoot, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Task Detail Reorg Project", "Desktop summary/edit layout test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Task Detail Repo",
        path: repoRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Task Detail Reorg Project");
      await createWorkflowViaSettings(sessionId, {
        name: "Detail Reorg Flow",
        description: "Single user lane for layout testing.",
        lanes: [
          {
            name: "Review",
            key: "review",
            ownerType: "user",
            entryPromptTemplate: "Review the task.",
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: "Task detail redesign",
        description: "Move the default repo file preview and recent history above the tabs.",
        repositoryName: "Task Detail Repo",
        workflowName: "Detail Reorg Flow",
      });
      await addTaskFileReferenceViaUi(sessionId, "Task Detail Repo", "docs/design.md", true);
      await addTaskCommentViaUi(sessionId, "Reviewer", "First history item");
      await addTaskCommentViaUi(sessionId, "Reviewer", "Second history item");

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Task detail redesign");
      await clickByText(sessionId, '[data-role="task-card"]', "Task detail redesign");

      await waitForText(sessionId, "Tracked repository file changes and references");
      await waitForText(sessionId, "Default repo file");
      await waitForText(sessionId, "docs/design.md");
      await waitForText(sessionId, "Task detail preview file");
      await waitForText(sessionId, "Recent history");

      const editorHidden = await executeScript<boolean>(sessionId, `
        return !document.querySelector('[data-role="task-title"]');
      `);
      expect(editorHidden).toBe(true);

      await clickSelector(sessionId, '[data-role="edit-task"]');
      await waitForSelector(sessionId, '[data-role="task-title"]');
      await waitForSelector(sessionId, '[data-role="task-description"]');
      await waitForSelector(sessionId, '[data-role="task-repositories"]');
      await waitForSelector(sessionId, '[data-role="task-whip-max-attempts"]');

      const hasAssigneeType = await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="task-assignee-type"]'));
      `);
      expect(hasAssigneeType).toBe(false);

      const descriptionBeforeRepositories = await executeScript<boolean>(sessionId, `
        const description = document.querySelector('[data-role="task-description"]');
        const repositories = document.querySelector('[data-role="task-repositories"]');
        if (!description || !repositories) return false;
        return Boolean(description.compareDocumentPosition(repositories) & Node.DOCUMENT_POSITION_FOLLOWING);
      `);
      expect(descriptionBeforeRepositories).toBe(true);

      const titleFullWidth = await executeScript<boolean>(sessionId, `
        const title = document.querySelector('[data-role="task-title"]');
        return Boolean(title?.closest('label')?.classList.contains('task-editor-grid__full'));
      `);
      expect(titleFullWidth).toBe(true);

      await clickSelector(sessionId, '[data-role="close-edit-task"]');
      await waitForText(sessionId, "Recent history");
      await clickSelector(sessionId, '[data-role="task-history-limit"]');
      await executeScript(sessionId, `
        const select = document.querySelector('[data-role="task-history-limit"]');
        if (select instanceof HTMLSelectElement) {
          select.value = '10';
          select.dispatchEvent(new Event('change', { bubbles: true }));
        }
      `);
      await sleep(300);
      await clickByText(sessionId, "button", "Back to tasks");
      await clickByText(sessionId, '[data-role="task-card"]', "Task detail redesign");

      const persistedHistoryLimit = await executeScript<string>(sessionId, `
        const select = document.querySelector('[data-role="task-history-limit"]');
        return select instanceof HTMLSelectElement ? select.value : '';
      `);
      expect(persistedHistoryLimit).toBe("10");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("supports dispatch, approve, needs work, whip, and pause actions from the reorganized task detail header", async () => {
    expect(testHome).toBeTruthy();

    const repoRoot = join(testHome!, "workspace", "task-detail-actions-repo", "repository");
    mkdirSync(repoRoot, { recursive: true });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Task Detail Actions Project", "Desktop action button test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Task Detail Actions Repo",
        path: repoRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Task Detail Actions Project");
      await createRoleViaSettings(sessionId, {
        name: "Action Worker",
        capacity: "1",
        description: "Role for dispatch/whip tests.",
      });
      await createWorkflowViaSettings(sessionId, {
        name: "Task Detail Action Flow",
        description: "Single role lane for action testing.",
        lanes: [
          {
            name: "Work",
            key: "work",
            ownerType: "role",
            ownerReference: "action-worker",
            entryPromptTemplate: "Do the work.",
          },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: "Task detail action coverage",
        description: "Verify top-level action buttons.",
        repositoryName: "Task Detail Actions Repo",
        workflowName: "Task Detail Action Flow",
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Task Detail Actions Project'));
      expect(project).toBeTruthy();
      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Task detail action coverage'));
      expect(task).toBeTruthy();

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Task detail action coverage");
      await clickByText(sessionId, '[data-role="task-card"]', "Task detail action coverage");

      await waitForText(sessionId, "Dispatch");
      await clickSelector(sessionId, '[data-role="dispatch-task-lane"]');
      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await waitForText(sessionId, "Lane execution");
      await waitForText(sessionId, "Whips: 0 / 10");
      await waitForText(sessionId, "Pause");
      await waitForText(sessionId, "Whip");
      const hasApproveNeedsWork = await executeScript<boolean>(sessionId, `
        return Boolean(document.querySelector('[data-role="approve-task-lane"], [data-role="complete-task-success"], [data-role="send-task-back-for-work"], [data-role="complete-task-failure"]'));
      `);
      expect(hasApproveNeedsWork).toBe(false);

      await clickSelector(sessionId, '[data-role="whip-task-runtime"]');
      await waitForCondition(
        () => executeScript<string>(sessionId, `
          return document.body ? document.body.innerText : '';
        `),
        (text) => text.toLowerCase().includes("whips: 1 / 10"),
      );

      await clickSelector(sessionId, '[data-role="pause-task-runtime"]');
      await sleep(1_000);
      await waitForText(sessionId, "Task detail action coverage");
      await clickSelector(sessionId, '[data-role="reset-task-runtime"]');
      await waitForCondition(
        () => invokeCommand<any>(sessionId, 'get_task', { taskId: task!.id }),
        (updatedTask) => updatedTask.status === 'ready' && updatedTask.activeLaneAssignment == null,
      );
      await waitForText(sessionId, 'No active runtime assignment for this task.');
      await waitForText(sessionId, 'Dispatch');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
