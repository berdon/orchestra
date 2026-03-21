import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  invokeCommand,
  invokeCommandNoWait,
  selectValue,
  sleep,
  waitForSelectOption,
  waitForText,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

describe("desktop task dispatch", () => {
  it.skipIf(!isDesktopE2E)("dispatches a real task lane and creates a real session record", async () => {
    expect(testHome).toBeTruthy();

    const sessionDir = join(testHome!, ".orchestra", "projects", "orchestra", "sessions");
    const beforeSessionFiles = existsSync(sessionDir) ? readdirSync(sessionDir).length : 0;

    const sessionId = await createWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Dispatch Project",
          description: "Real desktop dispatch test project.",
        },
      });

      const repository = await invokeCommand<{ id: string; localPath: string | null }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Dispatch Repo",
          localPath: join(testHome!, "workspace", "dispatch-repo"),
          remoteUrl: null,
          defaultBranch: "main",
        },
      });
      await dispatchWindowEvent(sessionId, 'orchestra:projects-changed');
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });

      const role = await invokeCommand<{ id: string; slug: string; name: string }>(sessionId, "create_role", {
        input: {
          name: "Developer",
          description: "Dispatch test developer role.",
          systemPrompt: null,
          provider: null,
          model: null,
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });

      const workflow = await invokeCommand<{ id: string; name: string; lanes: Array<{ id: string }> }>(sessionId, "create_workflow", {
        input: {
          name: "Dispatch Flow",
          description: "Single role-owned lane for dispatch testing.",
          lanes: [
            {
              id: null,
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Implement the requested task.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "user_intervention",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const task = await invokeCommand<{ id: string; title: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Dispatch session task",
          description: "Drive a real role dispatch and session creation.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: repository.id,
          parentTaskId: null,
          archived: false,
        },
      });

      const taskSummaries = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project.id,
        includeArchived: false,
      });
      expect(taskSummaries.some((entry) => entry.id === task.id)).toBe(true);

      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(1_000);

      const beforeSessions = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_sessions');
      await invokeCommandNoWait(sessionId, 'dispatch_task_lane', { taskId: task.id });
      console.log('dispatch triggered');

      let updatedTask: any = null;
      let afterSessions: Array<{ id: string; title: string }> = beforeSessions;
      let recentLogs: any[] = [];
      const dispatchDeadline = Date.now() + 25_000;
      while (Date.now() < dispatchDeadline) {
        updatedTask = await invokeCommand(sessionId, 'get_task', { taskId: task.id });
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
