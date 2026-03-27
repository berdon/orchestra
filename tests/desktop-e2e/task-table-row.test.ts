import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectValue,
  sleep,
  waitForSelectOption,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task table rows", () => {
  it.skipIf(!isDesktopE2E)("shows the lane column and allows clicking anywhere on a task table row to open details", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, 'create_project', {
        input: {
          name: 'Task Table Project',
          description: 'Task table row interaction test.',
        },
      });
      const workflow = await invokeCommand<{ id: string }>(sessionId, 'create_workflow', {
        input: {
          name: 'Task Table Flow',
          description: 'Simple table flow.',
          lanes: [
            {
              id: 'lane-build',
              key: 'build',
              name: 'Build',
              description: null,
              order: 0,
              assignedEntityType: 'user',
              assignedEntityId: null,
              entryPromptTemplate: 'Build it.',
              successTransitionType: 'end',
              successTargetLaneId: null,
              failureTransitionType: 'user_intervention',
              failureTargetLaneId: null,
            },
          ],
        },
      });
      await invokeCommand(sessionId, 'create_task', {
        projectId: project.id,
        input: {
          title: 'Clickable workflow row',
          description: 'Verify whole table row opens detail.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: 'unassigned',
          assigneeId: null,
          repositoryId: null,
          parentTaskId: null,
          archived: false,
        },
      });

      await dispatchWindowEvent(sessionId, 'orchestra:projects-changed');
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(500);

      await clickByText(sessionId, "button", "Tasks");
      await clickByText(sessionId, "button", "Table");
      await waitForText(sessionId, "Lane");
      await waitForText(sessionId, 'Clickable workflow row');

      const clicked = await executeScript<boolean>(sessionId, `
        const row = document.querySelector('[data-role="task-table-row"]');
        if (!(row instanceof HTMLElement)) return false;
        row.click();
        return true;
      `);
      expect(clicked).toBe(true);
      await waitForText(sessionId, "Task detail");
      await waitForText(sessionId, 'Clickable workflow row');
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
