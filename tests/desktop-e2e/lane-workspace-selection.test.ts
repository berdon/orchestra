import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  invokeCommand,
  sleep,
} from "./driver";
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  createRoleViaSettings,
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

async function dispatchTaskLaneWhenReady(sessionId: string, taskId: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = '';
  while (Date.now() < deadline) {
    try {
      await invokeCommand(sessionId, 'dispatch_task_lane', { taskId });
      return;
    } catch (error) {
      lastError = error instanceof Error ? error.message : String(error);
      if (!lastError.includes('already processing a message')) {
        throw error;
      }
    }
    await waitForCondition(
      () => invokeCommand<Array<{ title?: string; status?: string }>>(sessionId, 'list_sessions'),
      (sessions) => sessions.every((entry) => !String(entry.title ?? '').includes('Supervisor main session') || String(entry.status ?? '') === 'idle'),
      15_000,
    ).catch(() => undefined);
    await sleep(500);
  }
  throw new Error(`Timed out dispatching task lane ${taskId}: ${lastError}`);
}

describe("desktop lane workspace selection", () => {
  it.skipIf(!isDesktopE2E)("uses shared task workspaces by default and role runtime workspaces when requested", async () => {
    expect(testHome).toBeTruthy();

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const repositoryRoot = join(testHome!, "workspace", "lane-workspace-repo", "repository");
      const projectRoot = join(testHome!, ".orchestra", "projects", "lane-workspace-project");

      await createProjectViaSettings(sessionId, "Lane Workspace Project", "Verify shared and separate lane workspaces.");
      await addRepositoryViaSettings(sessionId, {
        name: "Lane Workspace Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Lane Workspace Project");
      await createRoleViaSettings(sessionId, {
        name: "Developer",
        capacity: "2",
        description: "Runs workflow lane workspace tests.",
      });

      const developerRole = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_roles', { includeArchived: false })
        .then((roles) => roles.find((entry) => entry.name === 'Developer'));
      expect(developerRole).toBeTruthy();

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "Lane Workspace Project"));
      expect(project).toBeTruthy();

      const repository = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_repositories", { projectId: project!.id })
        .then((repositories) => repositories.find((entry) => entry.name === "Lane Workspace Repo"));
      expect(repository).toBeTruthy();

      const sharedWorkflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Shared Lane Flow",
          description: "Uses the shared task workspace.",
          lanes: [
            {
              id: "lane-shared-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Inspect the task workspace.",
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
      const separateWorkflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Separate Lane Flow",
          description: "Uses a separate role runtime workspace.",
          lanes: [
            {
              id: "lane-separate-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Inspect the dedicated role workspace.",
              useSeparateWorktree: true,
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

      const sharedTask = await invokeCommand<any>(sessionId, "create_task", {
        projectId: project!.id,
        input: {
          title: "Shared lane workspace task",
          description: "Should use the task's shared workspace.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: sharedWorkflow.id,
          repositoryId: repository!.id,
          repositoryIds: [repository!.id],
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });
      const separateTask = await invokeCommand<any>(sessionId, "create_task", {
        projectId: project!.id,
        input: {
          title: "Separate lane workspace task",
          description: "Should use a dedicated role runtime workspace.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: separateWorkflow.id,
          repositoryId: repository!.id,
          repositoryIds: [repository!.id],
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });

      const sharedTaskDetail = await waitForCondition(
        async () => {
          await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
          await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: developerRole!.id }).catch(() => undefined);
          return invokeCommand<any>(sessionId, "get_task", { taskId: sharedTask.id });
        },
        (task) => Boolean(task.activeLaneAssignment?.runtimeCwd),
      );
      const sharedRepositories = await waitForCondition(
        () => invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, "list_task_repositories", { taskId: sharedTask.id }),
        (repositories) => repositories.some((entry) => typeof entry.taskWorktreePath === "string" && entry.taskWorktreePath.length > 0),
      );

      const expectedSharedWorkspace = join(projectRoot, "task-workspaces", "tasks", sharedTask.id);
      expect(sharedTaskDetail.activeLaneAssignment?.runtimeCwd).toBe(expectedSharedWorkspace);
      expect(sharedRepositories[0]?.taskWorktreePath).toContain(join(expectedSharedWorkspace, "repos"));

      const separateTaskDetail = await waitForCondition(
        async () => {
          await invokeCommand(sessionId, 'run_dispatcher_tick').catch(() => undefined);
          await invokeCommand(sessionId, 'dispatch_role_queue', { roleId: developerRole!.id }).catch(() => undefined);
          return invokeCommand<any>(sessionId, "get_task", { taskId: separateTask.id });
        },
        (task) => Boolean(task.activeLaneAssignment?.runtimeCwd),
      );
      const separateRepositories = await waitForCondition(
        () => invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, "list_task_repositories", { taskId: separateTask.id }),
        (repositories) => repositories.some((entry) => typeof entry.taskWorktreePath === "string" && entry.taskWorktreePath.length > 0),
      );

      const separateRuntimeCwd = separateTaskDetail.activeLaneAssignment?.runtimeCwd as string;
      expect(separateRuntimeCwd).toContain(join(projectRoot, "role-runtimes"));
      expect(separateRuntimeCwd).toContain(join("tasks", separateTask.id));
      expect(separateRepositories[0]?.taskWorktreePath).toContain(join(separateRuntimeCwd, "repos"));
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
