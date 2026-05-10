import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  selectByLabel,
  waitForSelectedLabel,
  waitForSelector,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task board lane scrolling", () => {
  it.skipIf(!isDesktopE2E)("keeps workflow lanes within a max height and scrolls long lane task lists", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Scrollable Task Board",
          taskPrefix: "STB",
          description: "Desktop scroll test project.",
        },
      });
      expect(project).toBeTruthy();

      const workflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Scrollable Workflow",
          description: "Stacks enough tasks to require lane scrolling.",
          lanes: [
            {
              id: "lane-scroll-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Handle the task.",
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              needsWorkTargetLaneId: null,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      for (let index = 0; index < 18; index += 1) {
        await invokeCommand(sessionId, "create_task", {
          projectId: project!.id,
          input: {
            title: `Scrollable workflow task ${index + 1}`,
            description: "Created for task board scroll coverage.",
            type: "task",
            status: "ready",
            priority: index % 2 === 0 ? "P1" : "P2",
            workflowId: workflow.id,
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });
      }

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await dispatchWindowEvent(sessionId, "orchestra:task-change", { taskIds: [], reason: "task.created" });
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);

      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Scrollable Workflow");
      await waitForSelector(sessionId, '[data-role="workflow-lane-task-list"]');

      const metrics = await executeScript<{
        laneCount: number;
        taskCount: number;
        clientHeight: number;
        scrollHeight: number;
        overflowY: string;
        sectionHeight: number;
        viewportHeight: number;
      }>(
        sessionId,
        `
          const laneList = document.querySelector('[data-role="workflow-lane-task-list"]');
          const section = document.querySelector('[data-role="workflow-task-section"]');
          return {
            laneCount: document.querySelectorAll('[data-role="workflow-lane-task-list"]').length,
            taskCount: laneList ? laneList.querySelectorAll('[data-role="task-card"]').length : 0,
            clientHeight: laneList instanceof HTMLElement ? laneList.clientHeight : 0,
            scrollHeight: laneList instanceof HTMLElement ? laneList.scrollHeight : 0,
            overflowY: laneList instanceof HTMLElement ? getComputedStyle(laneList).overflowY : '',
            sectionHeight: section instanceof HTMLElement ? section.getBoundingClientRect().height : 0,
            viewportHeight: window.innerHeight,
          };
        `,
      );

      expect(metrics.laneCount).toBeGreaterThan(0);
      expect(metrics.taskCount).toBe(18);
      expect(metrics.overflowY).toBe("auto");
      expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
      expect(metrics.sectionHeight).toBeLessThan(metrics.viewportHeight);

      const scrolled = await executeScript<number>(
        sessionId,
        `
          const laneList = document.querySelector('[data-role="workflow-lane-task-list"]');
          if (!(laneList instanceof HTMLElement)) {
            return 0;
          }
          laneList.scrollTop = 220;
          laneList.dispatchEvent(new Event('scroll', { bubbles: true }));
          return laneList.scrollTop;
        `,
      );

      expect(scrolled).toBeGreaterThan(0);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
