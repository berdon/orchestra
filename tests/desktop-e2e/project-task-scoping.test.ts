import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
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

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Settings");
      await waitForText(sessionId, "Project catalog");
      await sleep(500);
      await clickByText(sessionId, "button", "New project");
      await sleep(500);
      await setInputValue(sessionId, '[data-role="project-name"]', "Scoped Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Desktop task scoping project.");
      await clickSelector(sessionId, '.task-detail-panel .panel__header .primary-button');
      await waitForText(sessionId, "Scoped Project");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { label: "Scoped Project" });
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { label: "Orchestra" });

      await setInputValue(sessionId, '[data-role="repository-name"]', "Scoped Repo");
      await setInputValue(sessionId, '[data-role="repository-local-path"]', join(testHome!, "workspace", "scoped-repo"));
      await setInputValue(sessionId, '[data-role="repository-default-branch"]', "main");
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await clickByText(sessionId, "button", "Tasks");

      await selectValue(sessionId, '[data-role="project-switcher"]', "orchestra");
      await clickSelector(sessionId, '[data-role="new-task"]');
      await setInputValue(sessionId, '[data-role="task-title"]', "Default project task");
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await clickByText(sessionId, "button", "Back to tasks");

      let visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => texts.some((text) => text.includes("Default project task")) && !texts.some((text) => text.includes("Scoped project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(true);
      expect(visibleTaskCards.some((text) => text.includes("Scoped project task"))).toBe(false);

      await selectByLabel(sessionId, '[data-role="project-switcher"]', "Scoped Project");
      visibleTaskCards = await waitForTaskCards(
        sessionId,
        (texts) => !texts.some((text) => text.includes("Default project task")),
      );
      expect(visibleTaskCards.some((text) => text.includes("Default project task"))).toBe(false);

      await clickSelector(sessionId, '[data-role="new-task"]');
      await setInputValue(sessionId, '[data-role="task-title"]', "Scoped project task");
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await clickByText(sessionId, "button", "Back to tasks");

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
