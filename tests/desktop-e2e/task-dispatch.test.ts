import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

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
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  createRoleViaSettings,
  createTaskViaTasks,
  createWorkflowViaSettings,
  dispatchTaskViaUi,
  openTaskCard,
  switchProject,
} from "./ui-flows";
import { orchestraProjectSessionsRoot } from "./test-paths";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task dispatch", () => {
  it.skipIf(!isDesktopE2E)("dispatches a real task lane and creates a real session record", async () => {
    expect(testHome).toBeTruthy();

    const sessionDir = orchestraProjectSessionsRoot(testHome!, "dispatch-project");
    const beforeSessionFiles = existsSync(sessionDir) ? readdirSync(sessionDir).length : 0;

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repoHome = join(testHome!, "workspace", "dispatch-repo");
      const repositoryRoot = join(repoHome, "repository");

      await createProjectViaSettings(sessionId, "Dispatch Project", "Real desktop dispatch test project.");
      await addRepositoryViaSettings(sessionId, {
        name: "Dispatch Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Dispatch Project");
      await createRoleViaSettings(sessionId, {
        name: "Developer",
        capacity: "1",
        description: "Dispatch test developer role.",
      });
      await createWorkflowViaSettings(sessionId, {
        name: "Dispatch Flow",
        description: "Single role-owned lane for dispatch testing.",
        lanes: [
          {
            name: "Implement",
            key: "implement",
            ownerType: "role",
            ownerReference: "developer",
            entryPromptTemplate: "Implement the requested task.",
          },
        ],
      });
      const workflow = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false })
        .then((workflows) => workflows.find((entry) => entry.name === 'Dispatch Flow'))
        .then((summary) => {
          expect(summary).toBeTruthy();
          return invokeCommand<any>(sessionId, 'get_workflow', { workflowId: summary!.id });
        });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Dispatch Project'));
      expect(project).toBeTruthy();
      const repository = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_repositories', { projectId: project!.id })
        .then((repositories) => repositories.find((entry) => entry.name === 'Dispatch Repo'));
      expect(repository).toBeTruthy();
      await invokeCommand(sessionId, 'create_task', {
        projectId: project!.id,
        input: {
          title: 'Dispatch session task',
          description: 'Drive a real role dispatch and session creation.',
          type: 'task',
          status: 'ready',
          priority: 'P2',
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0]?.id ?? null,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: 'unassigned',
          assigneeId: null,
        },
      });

      await executeScript(sessionId, `window.dispatchEvent(new CustomEvent('orchestra:projects-changed')); window.location.reload(); return true;`);
      await sleep(1_000);
      await ensureReactReady(sessionId);
      await switchProject(sessionId, 'Dispatch Project');
      const task = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Dispatch session task'));
      expect(task).toBeTruthy();

      const createdTask = await invokeCommand<any>(sessionId, 'get_task', { taskId: task!.id });
      expect(createdTask.repositoryName ?? createdTask.repositoryId).toBeTruthy();

      const beforeSessions = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_sessions');
      await openTaskCard(sessionId, 'Dispatch session task');
      const hasDispatchButton = await executeScript<boolean>(
        sessionId,
        `return Boolean(document.querySelector('[data-role="dispatch-task-lane"], [data-role="publish-task"]'));`,
      );
      if (hasDispatchButton) {
        await dispatchTaskViaUi(sessionId);
      }

      let updatedTask: any = null;
      let afterSessions: Array<{ id: string; title: string }> = beforeSessions;
      let recentLogs: any[] = [];
      const dispatchDeadline = Date.now() + 25_000;
      while (Date.now() < dispatchDeadline) {
        updatedTask = await invokeCommand(sessionId, 'get_task', { taskId: task!.id });
        afterSessions = await invokeCommand(sessionId, 'list_sessions');
        recentLogs = await invokeCommand<any[]>(sessionId, 'get_logs');
        const spawnedRuntime = recentLogs.some((entry) => entry.target === 'sessions.runtime.spawn');
        if (updatedTask.activeLaneAssignment || afterSessions.length > beforeSessions.length || spawnedRuntime) {
          break;
        }
        await sleep(500);
      }

      expect(afterSessions.length > beforeSessions.length || recentLogs.some((entry) => entry.target === 'sessions.runtime.spawn')).toBe(true);

      const afterSessionFiles = existsSync(sessionDir) ? readdirSync(sessionDir).length : 0;
      expect(afterSessionFiles).toBeGreaterThan(beforeSessionFiles);

      const newestSession = afterSessions.find((entry) => !beforeSessions.some((before) => before.id === entry.id)) ?? afterSessions[0];
      expect(newestSession?.title?.length).toBeGreaterThan(0);

      await clickByText(sessionId, 'button', 'Sessions');
      await waitForText(sessionId, newestSession.title);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 120_000);
});
