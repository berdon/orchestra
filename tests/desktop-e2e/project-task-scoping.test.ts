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
  selectValue,
  setInputValue,
  sleep,
  waitForSelectOption,
  waitForText,
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

async function readProjectSwitcherState(sessionId: string) {
  return executeScript<{ value: string; options: Array<{ value: string; label: string }> }>(
    sessionId,
    `
      const select = document.querySelector('[data-role="project-switcher"]');
      if (!(select instanceof HTMLSelectElement)) {
        return { value: '', options: [] };
      }
      return {
        value: select.value,
        options: Array.from(select.options).map((option) => ({ value: option.value, label: option.label })),
      };
    `,
  );
}

async function readTaskViewState(sessionId: string) {
  return executeScript<Record<string, unknown>>(
    sessionId,
    `
      return {
        hasNewTaskButton: Boolean(document.querySelector('[data-role="new-task"]')),
        hasTaskTitleInput: Boolean(document.querySelector('[data-role="task-title"]')),
        taskCards: Array.from(document.querySelectorAll('[data-role="task-card"]')).map((entry) => (entry.textContent || '').trim()).filter(Boolean),
      };
    `,
  );
}

async function waitForTaskCards(
  sessionId: string,
  predicate: (texts: string[]) => boolean,
  timeoutMs = 30_000,
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

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, 'Tasks');

      const scopedProject = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Scoped Project",
          description: "Desktop task scoping project.",
        },
      });
      await executeScript(sessionId, `window.dispatchEvent(new CustomEvent('orchestra:projects-changed')); return true;`);
      await sleep(1_000);
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { label: scopedProject.name });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', scopedProject.name);
      await invokeCommand(sessionId, "create_repository", {
        projectId: scopedProject.id,
        input: {
          name: "Scoped Repo",
          repositoryPath: join(testHome!, "workspace", "scoped-repo"),
          defaultBranch: "main",
        },
      });
      await clickByText(sessionId, "button", "Tasks");

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Orchestra");
      await sleep(500);
      const orchestraSwitcherState = await readProjectSwitcherState(sessionId);
      expect(orchestraSwitcherState.options.some((option) => option.label === "Scoped Project")).toBe(true);
      expect(orchestraSwitcherState.value).not.toBe("");

      await clickSelector(sessionId, '[data-role="new-task"]');
      await sleep(500);
      const orchestraCreateView = await readTaskViewState(sessionId);
      expect(orchestraCreateView.hasTaskTitleInput).toBe(true);
      await setInputValue(sessionId, '[data-role="task-title"]', "Default project task");
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await sleep(1_000);

      const orchestraTasks = await invokeCommand<Array<{ title: string; projectId: string }>>(sessionId, "list_tasks", { includeArchived: false, projectId: orchestraSwitcherState.value });
      expect(orchestraTasks.some((task) => task.title === "Default project task")).toBe(true);

      let visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => texts.some((text) => text.includes("Default project task")) && !texts.some((text) => text.includes("Scoped project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(true);
      expect(visibleTaskCards.some((text) => text.includes("Scoped project task"))).toBe(false);

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Scoped Project");
      await sleep(500);
      const scopedSwitcherState = await readProjectSwitcherState(sessionId);
      expect(scopedSwitcherState.options.some((option) => option.label === "Scoped Project")).toBe(true);
      visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => !texts.some((text) => text.includes("Default project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(false);

      await clickSelector(sessionId, '[data-role="new-task"]');
      await sleep(500);
      const scopedCreateView = await readTaskViewState(sessionId);
      expect(scopedCreateView.hasTaskTitleInput).toBe(true);
      await setInputValue(sessionId, '[data-role="task-title"]', "Scoped project task");
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await sleep(1_000);

      const scopedTasks = await invokeCommand<Array<{ title: string; projectId: string }>>(sessionId, "list_tasks", { includeArchived: false, projectId: scopedProject.id });
      expect(scopedTasks.some((task) => task.title === "Scoped project task")).toBe(true);

      visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => texts.some((text) => text.includes("Scoped project task")) && !texts.some((text) => text.includes("Default project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Scoped project task"))).toBe(true);
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(false);

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Orchestra");
      visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => texts.some((text) => text.includes("Default project task")) && !texts.some((text) => text.includes("Scoped project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(true);
      expect(visibleTaskCards.some((text) => text.includes("Scoped project task"))).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
