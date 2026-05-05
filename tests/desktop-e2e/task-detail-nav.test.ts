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
  setActiveProject,
  setInputValue,
  setWindowRect,
  sleep,
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
    await sleep(250);
  }
  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue)}`);
}

async function injectSessionRecord(sessionId: string, record: Record<string, unknown>) {
  await executeScript(
    sessionId,
    `
      const apply = window.__orchestraTestApplySessionRecord;
      if (typeof apply !== 'function') {
        throw new Error('Missing __orchestraTestApplySessionRecord test hook');
      }
      apply(arguments[0]);
      return true;
    `,
    [record],
  );
}

describe("desktop task detail navigation", () => {
  it.skipIf(!isDesktopE2E)("shows the task overview description and returns to the task list from the Tasks nav", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await clickByText(sessionId, "button", "Tasks");
      await clickByText(sessionId, "button", "New task");
      await setInputValue(sessionId, '[data-role="task-title"]', 'Desktop task detail nav');
      await clickSelector(sessionId, '[data-role="save-task"]');

      await waitForText(sessionId, 'Desktop task detail nav');
      await waitForText(sessionId, 'Task description');
      await waitForText(sessionId, 'No description provided.');

      const backButtonVisible = await executeScript<boolean>(sessionId, `
        return Array.from(document.querySelectorAll('button')).some((button) => button.textContent?.trim() === 'Back to tasks');
      `);
      expect(backButtonVisible).toBe(false);

      await clickByText(sessionId, 'button', 'Tasks');
      await waitForText(sessionId, 'Desktop task detail nav');

      const detailHeadingVisible = await executeScript<boolean>(sessionId, `
        return Array.from(document.querySelectorAll('h2')).some((heading) => heading.textContent?.trim() === 'Desktop task detail nav');
      `);
      expect(detailHeadingVisible).toBe(false);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("opens the exact linked session from task detail even when another session is already selected", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_project", {
        input: {
          name: "Cross Link Dispatch Project",
          taskPrefix: "CLD",
          description: "Project used to verify task -> session links.",
        },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");

      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Cross Link Dispatch Repo",
          repositoryPath: join(testHome!, "workspace", "dispatch-repo", "repository"),
          defaultBranch: "main",
        },
      });
      const developerRole = await invokeCommand<{ slug: string }>(sessionId, "create_role", {
        input: {
          name: "Cross Link Developer",
          description: "Role used for session link navigation coverage.",
          systemPrompt: "Work the assigned task.",
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Cross Link Workflow",
          description: "Single role-owned lane for navigation coverage.",
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: developerRole.slug,
              entryPromptTemplate: "Implement the task.",
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });
      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Task session cross link",
          description: "Open the correct runtime session from task detail.",
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: workflow.id,
          currentLaneId: "lane-implement",
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });

      await setActiveProject(sessionId, project.id);
      await invokeCommand(sessionId, "dispatch_task_lane", { taskId: task.id });

      const activeTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: task.id }),
        (value) => Boolean(value?.activeLaneAssignment?.sessionId),
        45_000,
      );
      const workerSessionId = activeTask.activeLaneAssignment.sessionId as string;
      const workerSession = await invokeCommand<any>(sessionId, "get_session_record", { sessionId: workerSessionId });
      const decoySession = await invokeCommand<{ id: string; title: string }>(sessionId, "create_session", {
        title: "Decoy session",
        projectSlug: project.slug,
      });

      await injectSessionRecord(sessionId, {
        id: decoySession.id,
        title: decoySession.title,
        status: "active",
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        subscribed: false,
        events: [{ id: "event-decoy", kind: "assistant", message: "Wrong session", timestamp: new Date().toISOString() }],
        taskId: task.id,
        taskProjectId: project.id,
        taskNumber: activeTask.number,
        taskTitle: activeTask.title,
        activeTaskId: task.id,
        activeTaskProjectId: project.id,
        activeTaskNumber: activeTask.number,
        activeTaskTitle: activeTask.title,
        workerType: "role",
        workerName: "Decoy Worker",
      });

      await clickByText(sessionId, "button", "Tasks");
      await executeScript(
        sessionId,
        `
          const openTaskDetail = window.__orchestraTestOpenTaskDetail;
          if (typeof openTaskDetail !== 'function') {
            throw new Error('Missing __orchestraTestOpenTaskDetail test hook');
          }
          openTaskDetail(arguments[0]);
          return true;
        `,
        [task.id],
      );
      await waitForCondition(
        () => executeScript<{ taskId: string; search: string }>(sessionId, `
          const panel = document.querySelector('[data-role="task-detail-panel"]');
          return {
            taskId: panel?.getAttribute('data-task-id') || '',
            search: window.location.search,
          };
        `),
        (value) => value.taskId === task.id && value.search.includes(`selectedTaskId=${task.id}`),
      );

      await clickSelector(sessionId, '[data-role="task-open-session"]');
      const navigationState = await waitForCondition(
        () => executeScript<{
          activeSessionId: string;
          selectedSessionId: string;
          activeProjectId: string;
          search: string;
        }>(sessionId, `
          return {
            activeSessionId: document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '',
            selectedSessionId: document.querySelector('.session-list-link--active[data-role="session-link"]')?.getAttribute('data-session-id') || '',
            activeProjectId: window.localStorage.getItem('orchestra.mock.active-project-id') || '',
            search: window.location.search,
          };
        `),
        (value) => value.activeSessionId === workerSessionId
          && value.selectedSessionId === workerSessionId
          && value.activeProjectId === project.id
          && value.search.includes(`page=sessions`)
          && value.search.includes(`projectId=${project.id}`)
          && value.search.includes(`selectedSessionId=${workerSessionId}`),
        30_000,
      );

      expect(navigationState.activeSessionId).toBe(workerSessionId);
      await waitForText(sessionId, workerSession.title);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("opens the exact linked task from session detail and switches project scope for the target", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const targetProject = await invokeCommand<{ id: string }>(sessionId, "create_project", {
        input: {
          name: "Cross Link Target Project",
          taskPrefix: "CLT",
          description: "Project used to verify session -> task links.",
        },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");

      const targetTask = await invokeCommand<{ id: string; title: string; number: string }>(sessionId, "create_task", {
        projectId: targetProject.id,
        input: {
          title: "Session linked task target",
          description: "This task should open from a linked session.",
          type: "task",
          status: "ready",
          priority: "P2",
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });

      await clickByText(sessionId, "button", "Sessions");
      await waitForSelector(sessionId, '[data-role="session-filter-active"]');

      const timestamp = new Date().toISOString();
      const linkedSessionId = "session-cross-project-target";
      await injectSessionRecord(sessionId, {
        id: linkedSessionId,
        title: "Cross-project session link",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        subscribed: false,
        events: [{ id: "session-event-cross-project", kind: "assistant", message: "Open the linked task.", timestamp }],
        taskId: targetTask.id,
        taskProjectId: targetProject.id,
        taskNumber: targetTask.number,
        taskTitle: targetTask.title,
        activeTaskId: targetTask.id,
        activeTaskProjectId: targetProject.id,
        activeTaskNumber: targetTask.number,
        activeTaskTitle: targetTask.title,
        workerType: "role",
        workerName: "Developer",
      });

      await waitForSelector(sessionId, `[data-role="session-link"][data-session-id="${linkedSessionId}"]`);
      await clickSelector(sessionId, `[data-role="session-link"][data-session-id="${linkedSessionId}"]`);
      await clickSelector(sessionId, '[data-role="session-header-actions-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-header-actions-menu"]');
      await clickSelector(sessionId, '[data-role="session-header-action-open-task"]');

      const navigationState = await waitForCondition(
        () => executeScript<{
          activeProjectId: string;
          selectedTaskId: string;
          search: string;
        }>(sessionId, `
          return {
            activeProjectId: window.localStorage.getItem('orchestra.mock.active-project-id') || '',
            selectedTaskId: document.querySelector('[data-role="task-detail-panel"]')?.getAttribute('data-task-id') || '',
            search: window.location.search,
          };
        `),
        (value) => value.activeProjectId === targetProject.id
          && value.selectedTaskId === targetTask.id
          && value.search.includes(`page=tasks`)
          && value.search.includes(`projectId=${targetProject.id}`)
          && value.search.includes(`selectedTaskId=${targetTask.id}`),
        30_000,
      );

      expect(navigationState.selectedTaskId).toBe(targetTask.id);
      await waitForText(sessionId, targetTask.title);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("opens the exact linked task from the sessions mobile header menu", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const targetProject = await invokeCommand<{ id: string }>(sessionId, "create_project", {
        input: {
          name: "Mobile Session Link Target",
          taskPrefix: "MSL",
          description: "Project used to verify mobile session -> task links.",
        },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");

      const targetTask = await invokeCommand<{ id: string; title: string; number: string }>(sessionId, "create_task", {
        projectId: targetProject.id,
        input: {
          title: "Mobile session linked task target",
          description: "This task should open from the mobile session header menu.",
          type: "task",
          status: "ready",
          priority: "P2",
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });

      await clickByText(sessionId, "button", "Sessions");
      await waitForSelector(sessionId, '[data-role="session-filter-active"]');

      const timestamp = new Date().toISOString();
      const linkedSessionId = "session-mobile-cross-project-target";
      await injectSessionRecord(sessionId, {
        id: linkedSessionId,
        title: "Mobile cross-project session link",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        subscribed: false,
        events: [{ id: "session-event-mobile-cross-project", kind: "assistant", message: "Open the linked mobile task.", timestamp }],
        taskId: targetTask.id,
        taskProjectId: targetProject.id,
        taskNumber: targetTask.number,
        taskTitle: targetTask.title,
        activeTaskId: targetTask.id,
        activeTaskProjectId: targetProject.id,
        activeTaskNumber: targetTask.number,
        activeTaskTitle: targetTask.title,
        workerType: "role",
        workerName: "Developer",
      });
      await dispatchWindowEvent(sessionId, "orchestra:session-change", {
        sessionIds: [linkedSessionId],
        reason: "test.desktop_mobile_session_open_task",
      });

      await waitForSelector(sessionId, `[data-role="session-link"][data-session-id="${linkedSessionId}"]`);
      await clickSelector(sessionId, `[data-role="session-link"][data-session-id="${linkedSessionId}"]`);
      await setWindowRect(sessionId, { width: 390, height: 844, x: 0, y: 0 });
      await waitForCondition(
        () => executeScript<{ innerWidth: number; triggerVisible: boolean; headerHidden: boolean }>(sessionId, `
          const trigger = document.querySelector('[data-role="session-mobile-transcript-controls-trigger"]');
          const header = document.querySelector('[data-role="session-chat-panel"] > .panel__header');
          return {
            innerWidth: window.innerWidth,
            triggerVisible: Boolean(trigger && trigger.getClientRects().length > 0),
            headerHidden: Boolean(header) && header.getClientRects().length === 0,
          };
        `),
        (value) => value.innerWidth <= 500 && value.triggerVisible && value.headerHidden,
        30_000,
      );

      await clickSelector(sessionId, '[data-role="session-mobile-transcript-controls-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-mobile-transcript-controls-menu"]');
      await clickSelector(sessionId, '[data-role="session-mobile-open-task"]');

      const navigationState = await waitForCondition(
        () => executeScript<{
          activeProjectId: string;
          selectedTaskId: string;
          search: string;
        }>(sessionId, `
          return {
            activeProjectId: window.localStorage.getItem('orchestra.mock.active-project-id') || '',
            selectedTaskId: document.querySelector('[data-role="task-detail-panel"]')?.getAttribute('data-task-id') || '',
            search: window.location.search,
          };
        `),
        (value) => value.activeProjectId === targetProject.id
          && value.selectedTaskId === targetTask.id
          && value.search.includes(`page=tasks`)
          && value.search.includes(`projectId=${targetProject.id}`)
          && value.search.includes(`selectedTaskId=${targetTask.id}`),
        30_000,
      );

      expect(navigationState.selectedTaskId).toBe(targetTask.id);
      await waitForText(sessionId, targetTask.title);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);

  it.skipIf(!isDesktopE2E)("opens the exact linked task from the chat mobile header menu", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const targetProject = await invokeCommand<{ id: string }>(sessionId, "create_project", {
        input: {
          name: "Mobile Chat Link Target",
          taskPrefix: "MCL",
          description: "Project used to verify mobile chat -> task links.",
        },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");

      const targetTask = await invokeCommand<{ id: string; title: string; number: string }>(sessionId, "create_task", {
        projectId: targetProject.id,
        input: {
          title: "Mobile chat linked task target",
          description: "This task should open from the mobile chat header menu.",
          type: "task",
          status: "ready",
          priority: "P2",
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });

      await clickByText(sessionId, "button", "Chat");
      await waitForSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await clickSelector(sessionId, '[data-role="chat-agent-nav-supervisor"]');
      await waitForText(sessionId, 'Supervisor chat');

      const supervisorAgent = await waitForCondition(
        () => invokeCommand<Array<{ id: string; slug: string }>>(sessionId, "list_agents", {
          includeArchived: false,
          projectId: null,
        }),
        (agents) => agents.some((agent) => agent.slug === "supervisor"),
        45_000,
      );
      const supervisorAgentId = supervisorAgent.find((agent) => agent.slug === "supervisor")?.id;
      expect(supervisorAgentId).toBeTruthy();
      const linkedSessionId = "session-mobile-chat-open-task-target";
      const timestamp = new Date().toISOString();
      await injectSessionRecord(sessionId, {
        id: linkedSessionId,
        title: "Supervisor chat",
        status: "active",
        createdAt: timestamp,
        updatedAt: timestamp,
        subscribed: false,
        events: [{ id: "session-event-mobile-chat-open-task", kind: "assistant", message: "Open the linked mobile chat task.", timestamp }],
        taskId: targetTask.id,
        taskProjectId: targetProject.id,
        taskNumber: targetTask.number,
        taskTitle: targetTask.title,
        activeTaskId: targetTask.id,
        activeTaskProjectId: targetProject.id,
        activeTaskNumber: targetTask.number,
        activeTaskTitle: targetTask.title,
      });
      await executeScript(sessionId, `
        const hydrate = window.__orchestraTestHydrateChatAgentSession;
        if (typeof hydrate !== 'function') {
          throw new Error('Missing __orchestraTestHydrateChatAgentSession test hook');
        }
        hydrate(arguments[0]);
        return true;
      `, [{
        agentId: supervisorAgentId,
        sessionId: linkedSessionId,
        select: true,
      }]);
      await waitForCondition(
        () => executeScript<{ activeSessionId: string; hasHeaderAction: boolean }>(sessionId, `
          return {
            activeSessionId: document.querySelector('[data-role="session-chat-panel"]')?.getAttribute('data-session-id') || '',
            hasHeaderAction: Boolean(document.querySelector('[data-role="session-header-actions-trigger"]')),
          };
        `),
        (value) => value.activeSessionId === linkedSessionId && value.hasHeaderAction,
        30_000,
      );

      await setWindowRect(sessionId, { width: 390, height: 844, x: 0, y: 0 });
      await waitForCondition(
        () => executeScript<{ innerWidth: number; triggerVisible: boolean; headerHidden: boolean }>(sessionId, `
          const trigger = document.querySelector('[data-role="session-mobile-transcript-controls-trigger"]');
          const header = document.querySelector('[data-role="session-chat-panel"] > .panel__header');
          return {
            innerWidth: window.innerWidth,
            triggerVisible: Boolean(trigger && trigger.getClientRects().length > 0),
            headerHidden: Boolean(header) && header.getClientRects().length === 0,
          };
        `),
        (value) => value.innerWidth <= 500 && value.triggerVisible && value.headerHidden,
        30_000,
      );

      await clickSelector(sessionId, '[data-role="session-mobile-transcript-controls-trigger"]');
      await waitForSelector(sessionId, '[data-role="session-mobile-transcript-controls-menu"]');
      await waitForSelector(sessionId, '[data-role="session-mobile-open-task"]');
      await clickSelector(sessionId, '[data-role="session-mobile-open-task"]');

      const navigationState = await waitForCondition(
        () => executeScript<{
          activeProjectId: string;
          selectedTaskId: string;
          search: string;
        }>(sessionId, `
          return {
            activeProjectId: window.localStorage.getItem('orchestra.mock.active-project-id') || '',
            selectedTaskId: document.querySelector('[data-role="task-detail-panel"]')?.getAttribute('data-task-id') || '',
            search: window.location.search,
          };
        `),
        (value) => value.activeProjectId === targetProject.id
          && value.selectedTaskId === targetTask.id
          && value.search.includes(`page=tasks`)
          && value.search.includes(`projectId=${targetProject.id}`)
          && value.search.includes(`selectedTaskId=${targetTask.id}`),
        30_000,
      );

      expect(navigationState.selectedTaskId).toBe(targetTask.id);
      await waitForText(sessionId, targetTask.title);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
