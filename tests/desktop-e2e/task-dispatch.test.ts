import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  selectByLabel,
  selectValue,
  setFieldByLabel,
  setInputValue,
  waitForSelectedLabel,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task dispatch", () => {
  it.skipIf(!isDesktopE2E)("dispatches a workflow lane and shows the spawned session through the UI", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);
      await selectByLabel(sessionId, '[data-role="project-switcher"]', 'Orchestra');
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', 'Orchestra');
      await waitForText(sessionId, 'Project');

      await clickByText(sessionId, 'button', 'Settings');
      await clickByText(sessionId, '[role="tab"]', 'Roles');
      await clickSelector(sessionId, '[data-role="new-role"]');
      await setInputValue(sessionId, '[data-role="role-name"]', 'Dispatch Developer');
      await setFieldByLabel(sessionId, 'Capacity', '1');
      await clickSelector(sessionId, '[data-role="save-role"]');
      await waitForText(sessionId, 'Dispatch Developer');

      await clickByText(sessionId, '[role="tab"]', 'Workflows');
      await clickByText(sessionId, 'button', 'New workflow');
      await setFieldByLabel(sessionId, 'Workflow name', 'UI Dispatch Flow');
      await setFieldByLabel(sessionId, 'Lane name', 'Implement');
      await setFieldByLabel(sessionId, 'Lane key', 'implement');
      await selectValue(sessionId, '[data-role="lane-owner-type"]', 'role');
      await selectValue(sessionId, '[data-role="lane-owner-reference"]', 'dispatch-developer');
      await clickSelector(sessionId, '[data-role="save-workflow"]');
      await waitForText(sessionId, 'UI Dispatch Flow');

      await clickByText(sessionId, 'button', 'Tasks');
      await clickSelector(sessionId, '[data-role="new-task"]');
      await waitForText(sessionId, 'new task');
      await setInputValue(sessionId, '[data-role="task-title"]', 'Dispatch session task');
      await setInputValue(sessionId, '[data-role="task-description"]', 'Validate real UI lane dispatch.');
      await selectValue(sessionId, '[data-role="task-status"]', 'ready');
      await selectByLabel(sessionId, '[data-role="task-workflow"]', 'UI Dispatch Flow');
      await clickSelector(sessionId, '[data-role="save-task"]');
      await waitForText(sessionId, 'Dispatch session task');
      await clickSelector(sessionId, '[data-role="dispatch-task-lane"]');
      await waitForText(sessionId, 'role ·');
      await waitForText(sessionId, 'Dispatch Developer');

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, 'Implement · Dispatch session task');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
