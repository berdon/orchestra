import { describe, expect, it } from "vitest";
import { join } from "node:path";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  sleep,
  waitForText,
} from "./driver";
import {
  addRepositoryViaSettings,
  completeTaskSuccessViaUi,
  createProjectViaSettings,
  createRoleViaSettings,
  createTaskViaTasks,
  createWorkflowViaSettings,
  dispatchTaskViaUi,
  openTaskCard,
  switchProject,
} from "./ui-flows";

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

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "workflow-lifecycle-repo", "repository");

      await createProjectViaSettings(sessionId, "Workflow Lifecycle Project", "Desktop end-to-end workflow lifecycle test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Workflow Lifecycle Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Workflow Lifecycle Project");
      await createRoleViaSettings(sessionId, { name: "Architect", capacity: "1", description: "Plans the work." });
      await createRoleViaSettings(sessionId, { name: "Developer", capacity: "1", description: "Implements the work." });
      await createRoleViaSettings(sessionId, { name: "QA", capacity: "1", description: "Validates the work." });
      await createWorkflowViaSettings(sessionId, {
        name: "Workflow Lifecycle",
        description: "Three real role lanes ending in completion.",
        lanes: [
          { name: "Plan", key: "plan", ownerType: "role", ownerReference: "architect", entryPromptTemplate: "Plan the implementation." },
          { name: "Implement", key: "implement", ownerType: "role", ownerReference: "developer", entryPromptTemplate: "Implement the plan." },
          { name: "Validate", key: "validate", ownerType: "role", ownerReference: "qa", entryPromptTemplate: "Validate the implementation." },
        ],
      });
      await createTaskViaTasks(sessionId, {
        title: "Desktop workflow lifecycle task",
        description: "Exercise task dispatch, session creation, transitions, and completion.",
        repositoryName: "Workflow Lifecycle Repo",
        workflowName: "Workflow Lifecycle",
        publish: true,
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Workflow Lifecycle Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Desktop workflow lifecycle task'));
      expect(createdTask).toBeTruthy();

      const task = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
      expect(task.repositoryId).toBeTruthy();
      const expectedPlanSessionTitle = `Architect · ${task.number} · ${task.title}`;
      const expectedImplementSessionTitle = `Developer · ${task.number} · ${task.title}`;
      const expectedValidateSessionTitle = `QA · ${task.number} · ${task.title}`;

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Sessions");

      await openTaskCard(sessionId, 'Desktop workflow lifecycle task');
      await dispatchTaskViaUi(sessionId);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === expectedPlanSessionTitle),
        30_000,
      );
      await waitForText(sessionId, expectedPlanSessionTitle, 15_000);

      await clickByText(sessionId, '[role="tab"]', 'Runtime');
      await completeTaskSuccessViaUi(sessionId);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === expectedImplementSessionTitle),
        30_000,
      );
      await waitForText(sessionId, expectedImplementSessionTitle, 15_000);

      await completeTaskSuccessViaUi(sessionId);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === expectedValidateSessionTitle),
        30_000,
      );
      await waitForText(sessionId, expectedValidateSessionTitle, 15_000);

      await completeTaskSuccessViaUi(sessionId);

      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
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
