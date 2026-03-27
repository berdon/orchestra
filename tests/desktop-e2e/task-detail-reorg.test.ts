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
  executeScript,
  invokeCommand,
  selectValue,
  setInputValue,
  sleep,
  waitForSelectOption,
  waitForSelector,
  waitForText,
} from "./driver";

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

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Task Detail Reorg Project",
          description: "Desktop summary/edit layout test.",
        },
      });

      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Task Detail Repo",
          repositoryPath: repoRoot,
          defaultBranch: "main",
        },
      });

      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Detail Reorg Flow",
          description: "Single user lane for layout testing.",
          lanes: [
            {
              id: "lane-review",
              key: "review",
              name: "Review",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Review the task.",
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
          title: "Task detail redesign",
          description: "Move the default repo file preview and recent history above the tabs.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository.id,
          parentTaskId: null,
          archived: false,
        },
      });

      const fileReference = await invokeCommand<{ id: string }>(sessionId, "add_task_file_reference", {
        taskId: task.id,
        input: {
          repositoryId: repository.id,
          relativePath: "docs/design.md",
        },
      });
      await invokeCommand(sessionId, "set_default_task_file_reference", { referenceId: fileReference.id });
      await invokeCommand(sessionId, "comment_on_task", {
        taskId: task.id,
        input: {
          author: "Reviewer",
          message: "First history item",
          interruptAgent: false,
        },
      });
      await invokeCommand(sessionId, "comment_on_task", {
        taskId: task.id,
        input: {
          author: "Reviewer",
          message: "Second history item",
          interruptAgent: false,
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(1_000);

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[data-role="task-card"]', task.title);

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
      await clickByText(sessionId, '[data-role="task-card"]', task.title);

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

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Task Detail Actions Project",
          description: "Desktop action button test.",
        },
      });

      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Task Detail Actions Repo",
          repositoryPath: repoRoot,
          defaultBranch: "main",
        },
      });

      const role = await invokeCommand<{ slug: string }>(sessionId, "create_role", {
        input: {
          name: "Action Worker",
          description: "Role for dispatch/whip tests.",
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
          name: "Task Detail Action Flow",
          description: "Single role lane for action testing.",
          lanes: [
            {
              id: "lane-work",
              key: "work",
              name: "Work",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Do the work.",
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
          title: "Task detail action coverage",
          description: "Verify top-level action buttons.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository.id,
          parentTaskId: null,
          archived: false,
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(1_000);

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, task.title);
      await clickByText(sessionId, '[data-role="task-card"]', task.title);

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
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
