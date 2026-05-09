import { execFileSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  invokeCommand,
  waitForText,
} from "./driver";

import { switchProject } from "./ui-flows";
import { orchestraProjectRoot } from "./test-paths";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForCondition<T>(
  load: () => Promise<T>,
  predicate: (value: T) => boolean,
  timeoutMs = 30_000,
) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;
  while (Date.now() < deadline) {
    lastValue = await load();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(
    `Condition not met before timeout: ${JSON.stringify(lastValue)}`,
  );
}

describe("desktop auto dispatch on blocker completion", () => {
  it.skipIf(!isDesktopE2E)(
    "keeps an already dispatched task running until it next transitions after a new dependency blocks it",
    async () => {
      expect(testHome).toBeTruthy();

      const repoPath = join(
        testHome!,
        "workspace",
        "dependency-blocks-active-task",
        "repository",
      );
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        join(repoPath, "README.md"),
        "dependency blocks active task repo\n",
        "utf8",
      );
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["config", "user.email", "desktop-e2e@example.invalid"],
        { cwd: repoPath, stdio: "ignore" },
      );
      execFileSync("git", ["config", "user.name", "Desktop E2E"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: repoPath,
        stdio: "ignore",
      });

      const sessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(sessionId);

        const project = await invokeCommand<{ id: string; name: string }>(
          sessionId,
          "create_project",
          {
            input: {
              name: "Dependency Blocks Active Task",
              taskPrefix: "DBA",
              description:
                "Ensure blocked tasks keep their active session until transition time after a dependency is added.",
            },
          },
        );
        const repository = await invokeCommand<{ id: string }>(
          sessionId,
          "create_repository",
          {
            projectId: project.id,
            input: {
              name: "Dependency Blocks Repo",
              repositoryPath: repoPath,
              defaultBranch: "main",
            },
          },
        );
        const developerRole = await invokeCommand<{ id: string; slug: string }>(
          sessionId,
          "create_role",
          {
            input: {
              name: "Dependency Block Role",
              description: "Role used to dispatch the blocked task.",
              systemPrompt: "Work the task.",
              capacity: 1,
            },
          },
        );
        const roleWorkflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Dependency Block Workflow",
              description:
                "Role-owned workflow for dependency blocking coverage.",
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
                  needsWorkTargetLaneId: null,
                  successTransitionType: "end",
                  successTargetLaneId: null,
                  failureTransitionType: "end",
                  failureTargetLaneId: null,
                },
              ],
            },
          },
        );
        const blockerWorkflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Dependency Blocker Workflow",
              description: "User-owned blocker workflow.",
              lanes: [
                {
                  id: "lane-review",
                  key: "review",
                  name: "Review",
                  order: 0,
                  assignedEntityType: "user",
                  assignedEntityId: null,
                  entryPromptTemplate: "Review blocker.",
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
          },
        );

        const activeTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "Task that should stop when blocked",
            description: "Dispatch first, then block it.",
            type: "task",
            status: "ready",
            priority: "P1",
            workflowId: roleWorkflow.id,
            currentLaneId: "lane-implement",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });
        const blockerTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "New blocker",
            description: "This should block the already dispatched task.",
            type: "task",
            status: "in_review",
            priority: "P1",
            workflowId: blockerWorkflow.id,
            currentLaneId: "lane-review",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "user",
            assigneeId: null,
          },
        });

        const dispatchedTask = await waitForCondition(
          async () => {
            const currentTask = await invokeCommand<any>(
              sessionId,
              "get_task",
              { taskId: activeTask.id },
            );
            if (!currentTask.activeLaneAssignment?.sessionId) {
              await invokeCommand(sessionId, "dispatch_task_lane", {
                taskId: activeTask.id,
              }).catch(() => undefined);
              await invokeCommand(sessionId, "run_dispatcher_tick").catch(
                () => undefined,
              );
              await invokeCommand(sessionId, "dispatch_role_queue", {
                roleId: developerRole.id,
              }).catch(() => undefined);
              await invokeCommand<Array<{ title?: string; status?: string }>>(
                sessionId,
                "list_sessions",
                {},
              )
                .then((sessions) => {
                  if (!sessions.every((entry) => !String(entry.title ?? "").includes("Supervisor main session") || ["idle", "paused", "closed"].includes(String(entry.status ?? "")))) {
                    throw new Error("supervisor still busy");
                  }
                })
                .catch(() => undefined);
              return invokeCommand<any>(sessionId, "get_task", {
                taskId: activeTask.id,
              });
            }
            return currentTask;
          },
          (task) =>
            Boolean(task.activeLaneAssignment?.sessionId) &&
            ["queued", "active"].includes(task.activeLaneAssignment?.status),
          90_000,
        );
        expect(dispatchedTask.activeLaneAssignment?.sessionId).toBeTruthy();

        await invokeCommand(sessionId, "add_task_dependency", {
          blockerTaskId: blockerTask.id,
          blockedTaskId: activeTask.id,
        });

        const blockedTask = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: activeTask.id,
            }),
          (task) =>
            task.status === "blocked" &&
            task.dependencyBlocked === true &&
            !task.activeLaneAssignment,
          30_000,
        );
        expect(blockedTask.readyForDispatch).toBe(false);
        expect(blockedTask.currentLaneId).toBe("lane-implement");

        await expect(
          invokeCommand(sessionId, "dispatch_task_lane", {
            taskId: activeTask.id,
          }),
        ).rejects.toThrow(
          /blocked and cannot be dispatched|blocked by unresolved dependencies|unfinished subtasks|cannot be dispatched until it becomes runnable/,
        );

        await expect(
          invokeCommand(sessionId, "complete_lane_as_success", {
            taskId: activeTask.id,
            summary: "Attempted to finish while the task was still blocked.",
            notes: "Tried to finish while blocked in desktop test.",
          }),
        ).rejects.toThrow(/blocked|no active lane assignment/);
      } finally {
        await deleteWebdriverSession(sessionId);
      }
    },
    240_000,
  );

  it.skipIf(!isDesktopE2E)(
    "keeps a dependent blocked through blocker lane advancement and auto-dispatches it only after true completion",
    async () => {
      expect(testHome).toBeTruthy();

      const repoPath = join(
        testHome!,
        "workspace",
        "auto-dispatch-blocker-to-test",
        "repository",
      );
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        join(repoPath, "README.md"),
        "auto dispatch blocker to test repo\n",
        "utf8",
      );
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["config", "user.email", "desktop-e2e@example.invalid"],
        { cwd: repoPath, stdio: "ignore" },
      );
      execFileSync("git", ["config", "user.name", "Desktop E2E"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: repoPath,
        stdio: "ignore",
      });

      const sessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(sessionId);

        const project = await invokeCommand<{
          id: string;
          name: string;
          slug: string;
        }>(sessionId, "create_project", {
          input: {
            name: "Auto Dispatch Blocker To Test Project",
            taskPrefix: "ADT",
            description:
              "Only final blocker completion should auto-dispatch dependent work.",
          },
        });
        const repository = await invokeCommand<{ id: string }>(
          sessionId,
          "create_repository",
          {
            projectId: project.id,
            input: {
              name: "Auto Dispatch Blocker To Test Repo",
              repositoryPath: repoPath,
              defaultBranch: "main",
            },
          },
        );
        await invokeCommand(sessionId, "set_project_default_repository", {
          projectId: project.id,
          repositoryId: repository.id,
        });

        const developerRole = await invokeCommand<{ id: string; slug: string }>(
          sessionId,
          "create_role",
          {
            input: {
              name: "Test Lane Dependent Developer",
              description: "Role dispatched only after blocker completion.",
              systemPrompt: "Implement the dependent task.",
              capacity: 1,
            },
          },
        );

        const blockerWorkflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Blocker Implement To Test Workflow",
              description:
                "User-owned implement lane advances to user Test lane before completion.",
              lanes: [
                {
                  id: "lane-blocker-implement",
                  key: "implement",
                  name: "Implement",
                  order: 0,
                  assignedEntityType: "user",
                  assignedEntityId: null,
                  entryPromptTemplate: "Implement blocker work.",
                  useSeparateWorktree: false,
                  requireUserApprovalOnSuccess: false,
                  needsWorkTargetLaneId: null,
                  successTransitionType: "lane",
                  successTargetLaneId: "lane-blocker-test",
                  failureTransitionType: "end",
                  failureTargetLaneId: null,
                },
                {
                  id: "lane-blocker-test",
                  key: "test",
                  name: "Test",
                  order: 1,
                  assignedEntityType: "user",
                  assignedEntityId: null,
                  entryPromptTemplate: "Test blocker work.",
                  useSeparateWorktree: false,
                  requireUserApprovalOnSuccess: false,
                  needsWorkTargetLaneId: null,
                  successTransitionType: "end",
                  successTargetLaneId: null,
                  failureTransitionType: "lane",
                  failureTargetLaneId: "lane-blocker-implement",
                },
              ],
            },
          },
        );
        const dependentWorkflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Dependent Auto Dispatch After Test Workflow",
              description: "Role-owned dependent workflow.",
              lanes: [
                {
                  id: "lane-dependent-after-test-implement",
                  key: "implement",
                  name: "Implement",
                  order: 0,
                  assignedEntityType: "role",
                  assignedEntityId: developerRole.slug,
                  entryPromptTemplate: "Implement the dependent task.",
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
          },
        );

        const blockerTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "Blocker that advances to Test",
            description:
              "Leaving Implement must not unblock dependent work before final completion.",
            type: "task",
            status: "in_review",
            priority: "P1",
            workflowId: blockerWorkflow.id,
            currentLaneId: "lane-blocker-implement",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "user",
            assigneeId: null,
          },
        });
        const dependentTask = await invokeCommand<any>(
          sessionId,
          "create_task",
          {
            projectId: project.id,
            input: {
              title: "Dependent blocked until completion",
              description:
                "Should auto-dispatch only after the blocker fully completes.",
              type: "task",
              status: "ready",
              priority: "P2",
              workflowId: dependentWorkflow.id,
              currentLaneId: "lane-dependent-after-test-implement",
              repositoryId: repository.id,
              repositoryIds: [repository.id],
              assigneeType: "unassigned",
              assigneeId: null,
            },
          },
        );

        const automation = await invokeCommand<{
          autoDispatchOnBlockerCompletion: boolean;
        }>(sessionId, "get_task_automation_settings", {
          projectSlug: project.slug,
        });
        expect(automation.autoDispatchOnBlockerCompletion).toBe(true);

        await invokeCommand(sessionId, "add_task_dependency", {
          blockerTaskId: blockerTask.id,
          blockedTaskId: dependentTask.id,
        });

        const blockedDependent = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: dependentTask.id,
            }),
          (task) =>
            task.status === "blocked" && task.dependencyBlocked === true,
          30_000,
        );
        expect(blockedDependent.readyForDispatch).toBe(false);

        await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
        await switchProject(sessionId, project.name);
        await clickByText(sessionId, "button", "Tasks");
        await waitForText(sessionId, "Blocker that advances to Test");

        await invokeCommand(sessionId, "complete_lane_as_success", {
          taskId: blockerTask.id,
          summary: "Implementation complete and ready for the Test lane.",
          notes: "Implementation ready for Test in desktop test.",
        });

        await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: blockerTask.id,
            }),
          (task) =>
            task.status === "in_review" &&
            task.currentLaneId === "lane-blocker-test",
          30_000,
        );
        const stillBlocked = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: dependentTask.id,
            }),
          (task) =>
            task.status === "blocked" &&
            task.dependencyBlocked === true &&
            !task.activeLaneAssignment,
          30_000,
        );
        expect(stillBlocked.readyForDispatch).toBe(false);

        await invokeCommand(sessionId, "complete_lane_as_success", {
          taskId: blockerTask.id,
          summary: "Test lane complete and blocker fully finished.",
          notes: "Finished blocker in desktop test.",
        });

        await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: blockerTask.id,
            }),
          (task) => task.status === "completed",
          30_000,
        );
        const unblockedDependent = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: dependentTask.id,
            }),
          (task) =>
            task.status === "ready" &&
            task.dependencyBlocked === false &&
            !task.activeLaneAssignment &&
            task.readyForDispatch === true,
          60_000,
        );

        expect(unblockedDependent.assigneeType).toBe("role");
        expect(unblockedDependent.currentLaneId).toBe(
          "lane-dependent-after-test-implement",
        );
      } finally {
        await deleteWebdriverSession(sessionId);
      }
    },
    240_000,
  );

  it.skipIf(!isDesktopE2E)(
    "auto-dispatches newly unblocked tasks when the project setting is enabled",
    async () => {
      expect(testHome).toBeTruthy();

      const repoPath = join(
        testHome!,
        "workspace",
        "auto-dispatch-blockers",
        "repository",
      );
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        join(repoPath, "README.md"),
        "auto dispatch blockers repo\n",
        "utf8",
      );
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["config", "user.email", "desktop-e2e@example.invalid"],
        { cwd: repoPath, stdio: "ignore" },
      );
      execFileSync("git", ["config", "user.name", "Desktop E2E"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: repoPath,
        stdio: "ignore",
      });

      const sessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(sessionId);

        const project = await invokeCommand<{
          id: string;
          name: string;
          slug: string;
        }>(sessionId, "create_project", {
          input: {
            name: "Auto Dispatch Project",
            taskPrefix: "ADP",
            description: "Auto dispatch on blocker completion desktop test.",
          },
        });
        const repository = await invokeCommand<{ id: string }>(
          sessionId,
          "create_repository",
          {
            projectId: project.id,
            input: {
              name: "Auto Dispatch Repo",
              repositoryPath: repoPath,
              defaultBranch: "main",
            },
          },
        );

        const developerRole = await invokeCommand<{ id: string; slug: string }>(
          sessionId,
          "create_role",
          {
            input: {
              name: "Developer",
              description: "Desktop auto dispatch role.",
              systemPrompt: "Implement the task.",
              capacity: 1,
            },
          },
        );

        const blockerWorkflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Blocker Review Workflow",
              description: "User-owned blocker workflow.",
              lanes: [
                {
                  id: "lane-blocker-review",
                  key: "review",
                  name: "Review",
                  order: 0,
                  assignedEntityType: "user",
                  assignedEntityId: null,
                  entryPromptTemplate: "Review the blocker.",
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
          },
        );

        const dependentWorkflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Dependent Role Workflow",
              description: "Role-owned dependent workflow.",
              lanes: [
                {
                  id: "lane-dependent-implement",
                  key: "implement",
                  name: "Implement",
                  order: 0,
                  assignedEntityType: "role",
                  assignedEntityId: developerRole.slug,
                  entryPromptTemplate: "Implement the dependent task.",
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
          },
        );

        const blockerTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "Blocker task",
            description: "Sole blocker for dependent work.",
            type: "task",
            status: "in_review",
            priority: "P1",
            workflowId: blockerWorkflow.id,
            currentLaneId: "lane-blocker-review",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "user",
            assigneeId: null,
          },
        });

        const dependentTask = await invokeCommand<any>(
          sessionId,
          "create_task",
          {
            projectId: project.id,
            input: {
              title: "Dependent task",
              description: "Should auto-dispatch once unblocked.",
              type: "task",
              status: "ready",
              priority: "P2",
              workflowId: dependentWorkflow.id,
              currentLaneId: "lane-dependent-implement",
              repositoryId: repository.id,
              repositoryIds: [repository.id],
              assigneeType: "unassigned",
              assigneeId: null,
            },
          },
        );

        await invokeCommand(sessionId, "add_task_dependency", {
          blockerTaskId: blockerTask.id,
          blockedTaskId: dependentTask.id,
        });

        const blockedDependent = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: dependentTask.id,
            }),
          (task) =>
            task.status === "blocked" && task.dependencyBlocked === true,
          30_000,
        );
        expect(blockedDependent.readyForDispatch).toBe(false);

        await invokeCommand(sessionId, "set_project_default_repository", {
          projectId: project.id,
          repositoryId: repository.id,
        });
        writeFileSync(
          join(
            orchestraProjectRoot(testHome!, project.slug),
            "settings.json",
          ),
          JSON.stringify(
            {
              general: {
                autoDispatchOnBlockerCompletion: true,
                updatedAt: new Date().toISOString(),
              },
            },
            null,
            2,
          ),
          "utf8",
        );

        await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
        await switchProject(sessionId, project.name);
        await clickByText(sessionId, "button", "Tasks");
        await waitForText(sessionId, "Blocker task");

        await invokeCommand(sessionId, "complete_lane_as_success", {
          taskId: blockerTask.id,
          summary: "Test lane complete and blocker fully finished.",
          notes: "Finished blocker in desktop test.",
        });

        const autoDispatched = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: dependentTask.id,
            }),
          (task) =>
            task.status === "in_progress" && Boolean(task.activeLaneAssignment),
          60_000,
        );

        expect(autoDispatched.assigneeType).toBe("role");
        expect(autoDispatched.activeLaneAssignment?.workerType).toBe("role");
        expect(["queued", "active"]).toContain(
          autoDispatched.activeLaneAssignment?.status,
        );

        await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: blockerTask.id,
            }),
          (task) => task.status === "completed",
        );
      } finally {
        await deleteWebdriverSession(sessionId);
      }
    },
    240_000,
  );

  it.skipIf(!isDesktopE2E)(
    "blocks parent tasks on unfinished subtasks and auto-dispatches them when the final child finishes",
    async () => {
      expect(testHome).toBeTruthy();

      const repoPath = join(
        testHome!,
        "workspace",
        "auto-dispatch-subtasks",
        "repository",
      );
      mkdirSync(repoPath, { recursive: true });
      writeFileSync(
        join(repoPath, "README.md"),
        "auto dispatch subtasks repo\n",
        "utf8",
      );
      execFileSync("git", ["init", "-b", "main"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync(
        "git",
        ["config", "user.email", "desktop-e2e@example.invalid"],
        { cwd: repoPath, stdio: "ignore" },
      );
      execFileSync("git", ["config", "user.name", "Desktop E2E"], {
        cwd: repoPath,
        stdio: "ignore",
      });
      execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
      execFileSync("git", ["commit", "-m", "init"], {
        cwd: repoPath,
        stdio: "ignore",
      });

      const sessionId = await createReadyWebdriverSession();
      try {
        await ensureReactReady(sessionId);

        const project = await invokeCommand<{
          id: string;
          name: string;
          slug: string;
        }>(sessionId, "create_project", {
          input: {
            name: "Parent Auto Dispatch Project",
            taskPrefix: "PAD",
            description: "Parent/subtask blocking desktop test.",
          },
        });
        const repository = await invokeCommand<{ id: string }>(
          sessionId,
          "create_repository",
          {
            projectId: project.id,
            input: {
              name: "Parent Auto Dispatch Repo",
              repositoryPath: repoPath,
              defaultBranch: "main",
            },
          },
        );
        const developerRole = await invokeCommand<{ id: string; slug: string }>(
          sessionId,
          "create_role",
          {
            input: {
              name: "Parent Developer",
              description: "Desktop parent auto dispatch role.",
              systemPrompt: "Implement the task.",
              capacity: 1,
            },
          },
        );
        const workflow = await invokeCommand<any>(
          sessionId,
          "create_workflow",
          {
            input: {
              name: "Parent Role Workflow",
              description: "Parent workflow for subtask blocking.",
              lanes: [
                {
                  id: "lane-parent-implement",
                  key: "implement",
                  name: "Implement",
                  order: 0,
                  assignedEntityType: "role",
                  assignedEntityId: developerRole.slug,
                  entryPromptTemplate: "Implement the parent task.",
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
          },
        );

        const parentTask = await invokeCommand<any>(sessionId, "create_task", {
          projectId: project.id,
          input: {
            title: "Parent task",
            description: "Should stay blocked while child work remains open.",
            type: "task",
            status: "ready",
            priority: "P1",
            workflowId: workflow.id,
            currentLaneId: "lane-parent-implement",
            repositoryId: repository.id,
            repositoryIds: [repository.id],
            assigneeType: "unassigned",
            assigneeId: null,
          },
        });
        const childTask = await invokeCommand<any>(
          sessionId,
          "create_subtask",
          {
            parentTaskId: parentTask.id,
            input: {
              title: "Child task",
              description: "Blocks the parent until it is finished.",
              type: "task",
              status: "ready",
              priority: "P2",
              workflowId: null,
              currentLaneId: null,
              repositoryId: repository.id,
              repositoryIds: [repository.id],
              assigneeType: "user",
              assigneeId: null,
            },
          },
        );

        const automation = await invokeCommand<{
          autoDispatchOnBlockerCompletion: boolean;
        }>(sessionId, "get_task_automation_settings", {
          projectSlug: project.slug,
        });
        expect(automation.autoDispatchOnBlockerCompletion).toBe(true);

        await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
        await switchProject(sessionId, project.name);
        await clickByText(sessionId, "button", "Tasks");
        await waitForText(sessionId, "Parent task");

        const blockedParent = await invokeCommand<any>(sessionId, "get_task", {
          taskId: parentTask.id,
        });
        expect(blockedParent.status).toBe("blocked");
        expect(blockedParent.dependencyBlocked).toBe(true);
        expect(blockedParent.readyForDispatch).toBe(false);
        expect(blockedParent.blockedChildCount).toBe(1);

        await expect(
          invokeCommand(sessionId, "dispatch_task_lane", {
            taskId: parentTask.id,
          }),
        ).rejects.toThrow(
          /blocked and cannot be dispatched|unfinished subtasks|cannot be dispatched until it becomes runnable/,
        );

        await invokeCommand(sessionId, "update_task", {
          taskId: childTask.id,
          input: {
            title: childTask.title,
            description: childTask.description,
            type: childTask.type,
            status: "completed",
            priority: childTask.priority,
            workflowId: childTask.workflowId,
            currentLaneId: childTask.currentLaneId,
            repositoryId: childTask.repositoryId,
            repositoryIds: childTask.repositoryIds,
            assigneeType: childTask.assigneeType,
            assigneeId: childTask.assigneeId,
            parentTaskId: childTask.parentTaskId,
            archived: false,
          },
        });

        const autoDispatchedParent = await waitForCondition(
          () =>
            invokeCommand<any>(sessionId, "get_task", {
              taskId: parentTask.id,
            }),
          (task) =>
            task.status === "in_progress" &&
            Boolean(task.activeLaneAssignment?.sessionId),
          60_000,
        );

        expect(autoDispatchedParent.dependencyBlocked).toBe(false);
        expect(autoDispatchedParent.blockedChildCount).toBe(0);
        expect(autoDispatchedParent.assigneeType).toBe("role");
        expect(autoDispatchedParent.activeLaneAssignment?.workerType).toBe(
          "role",
        );
      } finally {
        await deleteWebdriverSession(sessionId);
      }
    },
    240_000,
  );
});
