import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  invokeCommand,
  selectValue,
  sleep,
  waitForSelectOption,
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
    await sleep(500);
  }

  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

describe("desktop workflow lifecycle", () => {
  it.skipIf(!isDesktopE2E)("follows a multi-role task from creation to completion with visible runtime sessions", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Workflow Lifecycle Project",
          description: "Desktop end-to-end workflow lifecycle test.",
        },
      });

      const repositoryRoot = join(testHome!, "workspace", "workflow-lifecycle-repo", "repository");
      await invokeCommand(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Workflow Lifecycle Repo Seed",
          localPath: repositoryRoot,
          remoteUrl: null,
          defaultBranch: "main",
        },
      }).catch(() => undefined);
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Workflow Lifecycle Repo",
          localPath: repositoryRoot,
          remoteUrl: null,
          defaultBranch: "main",
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(1_000);

      const architect = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Architect",
          description: "Plans the work.",
          systemPrompt: null,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });
      const developer = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Developer",
          description: "Implements the work.",
          systemPrompt: null,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });
      const qa = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "QA",
          description: "Validates the work.",
          systemPrompt: null,
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          capacity: 1,
          policyIds: [],
          directPermissions: [],
        },
      });

      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Workflow Lifecycle",
          description: "Three real role lanes ending in completion.",
          lanes: [
            {
              id: null,
              key: "plan",
              name: "Plan",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: architect.slug,
              entryPromptTemplate: "Plan the implementation.",
              successTransitionType: "lane",
              successTargetLaneId: "implement-lane",
              failureTransitionType: "user_intervention",
              failureTargetLaneId: null,
            },
            {
              id: "implement-lane",
              key: "implement",
              name: "Implement",
              description: null,
              order: 1,
              assignedEntityType: "role",
              assignedEntityId: developer.slug,
              entryPromptTemplate: "Implement the plan.",
              successTransitionType: "lane",
              successTargetLaneId: "validate-lane",
              failureTransitionType: "user_intervention",
              failureTargetLaneId: null,
            },
            {
              id: "validate-lane",
              key: "validate",
              name: "Validate",
              description: null,
              order: 2,
              assignedEntityType: "role",
              assignedEntityId: qa.slug,
              entryPromptTemplate: "Validate the implementation.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "user_intervention",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const createdTask = await invokeCommand<{ id: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Desktop workflow lifecycle task",
          description: "Exercise task dispatch, session creation, transitions, and completion.",
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

      const task = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id });
      expect(task.repositoryId).toBe(repository.id);
      const expectedPlanSessionTitle = `Architect · ${task.number} · ${task.title}`;
      const expectedImplementSessionTitle = `Developer · ${task.number} · ${task.title}`;
      const expectedValidateSessionTitle = `QA · ${task.number} · ${task.title}`;

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Sessions");

      const dispatchedPlanTask = await invokeCommand<any>(sessionId, "dispatch_task_lane", { taskId: createdTask.id });
      expect(dispatchedPlanTask.activeLaneAssignment?.workerType).toBe("role");
      expect(dispatchedPlanTask.activeLaneAssignment?.workerId).toBe(architect.id);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === expectedPlanSessionTitle),
        30_000,
      );
      await waitForText(sessionId, expectedPlanSessionTitle, 15_000);

      const dispatchedImplementTask = await invokeCommand<any>(sessionId, "complete_lane_as_success", {
        taskId: createdTask.id,
        notes: "Architecture lane complete in desktop e2e.",
      });
      expect(dispatchedImplementTask.activeLaneAssignment?.workerType).toBe("role");
      expect(dispatchedImplementTask.activeLaneAssignment?.workerId).toBe(developer.id);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === expectedImplementSessionTitle),
        30_000,
      );
      await waitForText(sessionId, expectedImplementSessionTitle, 15_000);

      const dispatchedValidateTask = await invokeCommand<any>(sessionId, "complete_lane_as_success", {
        taskId: createdTask.id,
        notes: "Implementation lane complete in desktop e2e.",
      });
      expect(dispatchedValidateTask.activeLaneAssignment?.workerType).toBe("role");
      expect(dispatchedValidateTask.activeLaneAssignment?.workerId).toBe(qa.id);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === expectedValidateSessionTitle),
        30_000,
      );
      await waitForText(sessionId, expectedValidateSessionTitle, 15_000);

      await invokeCommand<any>(sessionId, "complete_lane_as_success", {
        taskId: createdTask.id,
        notes: "Validation lane complete in desktop e2e.",
      });

      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (currentTask) => currentTask.status === "completed" && currentTask.activeLaneAssignment == null,
        30_000,
      );

      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.laneRuns).toHaveLength(3);
      expect(completedTask.laneRuns.map((run: { result: string }) => run.result)).toEqual(["success", "success", "success"]);

      const finalSessions = await invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions");
      expect(finalSessions.some((entry) => entry.title === expectedPlanSessionTitle)).toBe(true);
      expect(finalSessions.some((entry) => entry.title === expectedImplementSessionTitle)).toBe(true);
      expect(finalSessions.some((entry) => entry.title === expectedValidateSessionTitle)).toBe(true);
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
