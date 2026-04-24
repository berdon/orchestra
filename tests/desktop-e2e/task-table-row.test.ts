import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
  waitForText,
} from "./driver";
import { createProjectViaSettings, createWorkflowViaSettings, switchProject } from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

describe("desktop task table rows", () => {
  it.skipIf(!isDesktopE2E)("shows the lane column and allows clicking anywhere on a task table row to open details", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, 'Task Table Project', 'Task table row interaction test.');
      await switchProject(sessionId, 'Task Table Project');
      await createWorkflowViaSettings(sessionId, {
        name: 'Task Table Flow',
        description: 'Simple table flow.',
        lanes: [
          {
            name: 'Build',
            key: 'build',
            ownerType: 'agent',
            ownerReference: 'supervisor',
            entryPromptTemplate: 'Build it.',
          },
        ],
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Task Table Project'));
      expect(project).toBeTruthy();
      const workflow = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false })
        .then((workflows) => workflows.find((entry) => entry.name === 'Task Table Flow'))
        .then((summary) => {
          expect(summary).toBeTruthy();
          return invokeCommand<any>(sessionId, 'get_workflow', { workflowId: summary!.id });
        });
      await invokeCommand(sessionId, 'create_task', {
        projectId: project!.id,
        input: {
          title: 'Clickable workflow row',
          description: 'Verify whole table row opens detail.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0]?.id ?? null,
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });
      await executeScript(sessionId, `
        window.dispatchEvent(new CustomEvent('orchestra:projects-changed'));
        window.location.reload();
        return true;
      `);
      await sleep(1_000);
      await ensureReactReady(sessionId);
      await switchProject(sessionId, 'Task Table Project');

      await clickByText(sessionId, "button", "Tasks");
      await executeScript(sessionId, `
        const button = document.querySelector('[data-role="task-view-table"]');
        if (!(button instanceof HTMLElement)) {
          throw new Error('Table view toggle was not available');
        }
        button.click();
        return true;
      `);
      await waitForText(sessionId, 'Clickable workflow row');
      await waitForText(sessionId, 'Supervisor');

      for (let attempt = 0; attempt < 40; attempt += 1) {
        const clicked = await executeScript<boolean>(sessionId, `
          const row = Array.from(document.querySelectorAll('[data-role="task-table-row"]')).find((entry) =>
            (entry.textContent || '').includes(arguments[0]),
          );
          if (!(row instanceof HTMLElement)) {
            return false;
          }
          row.click();
          return true;
        `, ['Clickable workflow row']);
        if (clicked) {
          break;
        }
        await sleep(250);
      }
      let taskHeaderVisible = false;
      for (let attempt = 0; attempt < 40; attempt += 1) {
        taskHeaderVisible = await executeScript<boolean>(sessionId, `
          return Boolean(document.querySelector('[data-role="task-detail-panel"]'))
            && window.location.search.includes('selectedTaskId=');
        `);
        if (taskHeaderVisible) {
          break;
        }
        await sleep(250);
      }
      expect(taskHeaderVisible).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
