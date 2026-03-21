import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectValue,
  setInputValue,
  sleep,
  waitForSelectOption,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function readTaskCardTexts(sessionId: string) {
  return executeScript<string[]>(
    sessionId,
    `
      return Array.from(document.querySelectorAll('[data-role="task-card"]'))
        .map((entry) => (entry.textContent || '').trim())
        .filter(Boolean);
    `,
  );
}

async function waitForTaskCards(
  sessionId: string,
  predicate: (texts: string[]) => boolean,
  timeoutMs = 15_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastTexts: string[] = [];

  while (Date.now() < deadline) {
    lastTexts = await readTaskCardTexts(sessionId);
    if (predicate(lastTexts)) {
      return lastTexts;
    }
    await sleep(250);
  }

  throw new Error(`Task cards did not reach expected state: ${JSON.stringify(lastTexts)}`);
}

describe("desktop project task scoping", () => {
  it.skipIf(!isDesktopE2E)("shows and creates tasks in the selected project instead of defaulting to the first project", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const defaultProject = (await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects"))
        .find((project) => project.name === "Orchestra");
      expect(defaultProject).toBeTruthy();
      const defaultProjectId = defaultProject!.id;

      const scopedProject = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Scoped Project",
          description: "Desktop task scoping project.",
        },
      });
      await invokeCommand(sessionId, "create_repository", {
        projectId: scopedProject.id,
        input: {
          name: "Scoped Repo",
          localPath: join(testHome!, "workspace", "scoped-repo"),
          remoteUrl: null,
          defaultBranch: "main",
        },
      });

      await invokeCommand(sessionId, "create_task", {
        projectId: defaultProjectId,
        input: {
          title: "Default project task",
          description: "Should only appear in Orchestra.",
          type: "task",
          status: "draft",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          parentTaskId: null,
          archived: false,
        },
      });
      await invokeCommand(sessionId, "create_task", {
        projectId: scopedProject.id,
        input: {
          title: "Scoped seeded task",
          description: "Should only appear in the selected scoped project.",
          type: "task",
          status: "draft",
          priority: "P2",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          parentTaskId: null,
          archived: false,
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: scopedProject.id });

      await clickByText(sessionId, "button", "Tasks");
      await selectValue(sessionId, '[data-role="project-switcher"]', scopedProject.id);

      let visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => texts.some((text) => text.includes("Scoped seeded task")) && !texts.some((text) => text.includes("Default project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Scoped seeded task"))).toBe(true);
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(false);

      await clickSelector(sessionId, '[data-role="new-task"]');
      await setInputValue(sessionId, '[data-role="task-title"]', "Scoped UI task");
      await clickSelector(sessionId, '[data-role="save-task"]');

      const createDeadline = Date.now() + 15_000;
      let scopedTasks: Array<{ title: string }> = [];
      while (Date.now() < createDeadline) {
        scopedTasks = await invokeCommand<Array<{ title: string }>>(sessionId, "list_tasks", {
          projectId: scopedProject.id,
          includeArchived: false,
        });
        if (scopedTasks.some((task) => task.title === "Scoped UI task")) {
          break;
        }
        await sleep(250);
      }
      const defaultProjectTasks = await invokeCommand<Array<{ title: string }>>(sessionId, "list_tasks", {
        projectId: defaultProjectId,
        includeArchived: false,
      });
      expect(scopedTasks.some((task) => task.title === "Scoped UI task")).toBe(true);
      expect(defaultProjectTasks.some((task) => task.title === "Scoped UI task")).toBe(false);

      await clickByText(sessionId, "button", "Back to tasks");
      await waitForTaskCards(sessionId, (texts) => texts.some((text) => text.includes("Scoped UI task")));

      await selectValue(sessionId, '[data-role="project-switcher"]', defaultProjectId);
      visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => texts.some((text) => text.includes("Default project task"))
          && !texts.some((text) => text.includes("Scoped seeded task"))
          && !texts.some((text) => text.includes("Scoped UI task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(true);
      expect(visibleTaskCards.some((text) => text.includes("Scoped seeded task"))).toBe(false);
      expect(visibleTaskCards.some((text) => text.includes("Scoped UI task"))).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
