import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  selectByLabel,
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

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, "button", "New project");
      await setInputValue(sessionId, '[data-role="project-name"]', "Scoped Project");
      await setInputValue(sessionId, '[data-role="project-description"]', "Desktop task scoping project.");
      await clickByText(sessionId, "button", "Create project");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { label: "Scoped Project" });

      await setInputValue(sessionId, '[data-role="repository-name"]', "Scoped Repo");
      await setInputValue(sessionId, '[data-role="repository-local-path"]', join(testHome!, "workspace", "scoped-repo"));
      await setInputValue(sessionId, '[data-role="repository-default-branch"]', "main");
      await clickSelector(sessionId, '[data-role="add-repository"]');
      await clickByText(sessionId, "button", "Tasks");

      await selectValue(sessionId, '[data-role="project-switcher"]', "orchestra");
      await clickSelector(sessionId, '[data-role="new-task"]');
      await setInputValue(sessionId, '[data-role="task-title"]', "Default project task");
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
