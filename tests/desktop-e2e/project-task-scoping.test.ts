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
  setInputValue,
  sleep,
  waitForSelectOption,
  waitForText,
} from "./driver";
import { addRepositoryViaSettings, createProjectViaSettings, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

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

describe("desktop project task scoping", () => {
  it.skipIf(!isDesktopE2E)("shows and creates tasks in the selected project instead of defaulting to the first project", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, 'Tasks');

      await createProjectViaSettings(sessionId, "Scoped Project", "Desktop task scoping project.");
      await addRepositoryViaSettings(sessionId, {
        name: "Scoped Repo",
        path: join(testHome!, "workspace", "scoped-repo"),
        defaultBranch: "main",
      });
      const projects = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects');
      const orchestraProject = projects.find((entry) => entry.name === 'Orchestra');
      const scopedProject = projects.find((entry) => entry.name === 'Scoped Project');
      expect(orchestraProject).toBeTruthy();
      expect(scopedProject).toBeTruthy();
      await switchProject(sessionId, "Scoped Project");
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
      await clickSelector(sessionId, '[data-role="save-task"]');
      await sleep(1_000);

      let orchestraTasks = await invokeCommand<Array<{ title: string }>>(sessionId, 'list_tasks', {
        projectId: orchestraProject!.id,
        includeArchived: false,
      });
      let scopedTasks = await invokeCommand<Array<{ title: string }>>(sessionId, 'list_tasks', {
        projectId: scopedProject!.id,
        includeArchived: false,
      });
      expect(orchestraTasks.some((task) => task.title === 'Default project task')).toBe(true);
      expect(scopedTasks.some((task) => task.title === 'Default project task')).toBe(false);

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Scoped Project");
      await sleep(500);
      const scopedSwitcherState = await readProjectSwitcherState(sessionId);
      expect(scopedSwitcherState.options.some((option) => option.label === "Scoped Project")).toBe(true);
      expect(scopedSwitcherState.value).not.toBe("");
      scopedTasks = await invokeCommand<Array<{ title: string }>>(sessionId, 'list_tasks', {
        projectId: scopedProject!.id,
        includeArchived: false,
      });
      expect(scopedTasks.some((task) => task.title === 'Default project task')).toBe(false);

      await clickSelector(sessionId, '[data-role="new-task"]');
      await sleep(500);
      const scopedCreateView = await readTaskViewState(sessionId);
      expect(scopedCreateView.hasTaskTitleInput).toBe(true);
      await setInputValue(sessionId, '[data-role="task-title"]', "Scoped project task");
      await clickSelector(sessionId, '[data-role="save-task"]');
      await sleep(1_000);

      scopedTasks = await invokeCommand<Array<{ title: string }>>(sessionId, 'list_tasks', {
        projectId: scopedProject!.id,
        includeArchived: false,
      });
      orchestraTasks = await invokeCommand<Array<{ title: string }>>(sessionId, 'list_tasks', {
        projectId: orchestraProject!.id,
        includeArchived: false,
      });
      expect(scopedTasks.some((task) => task.title === 'Scoped project task')).toBe(true);
      expect(orchestraTasks.some((task) => task.title === 'Scoped project task')).toBe(false);

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Orchestra");
      orchestraTasks = await invokeCommand<Array<{ title: string }>>(sessionId, 'list_tasks', {
        projectId: orchestraProject!.id,
        includeArchived: false,
      });
      expect(orchestraTasks.some((task) => task.title === 'Default project task')).toBe(true);
      expect(orchestraTasks.some((task) => task.title === 'Scoped project task')).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
