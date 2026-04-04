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
  selectByLabel,
  waitForSelectedLabel,
  waitForText,
} from "./driver";

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
  throw new Error(`Condition not met before timeout: ${JSON.stringify(lastValue)}`);
}

describe("desktop auto dispatch on blocker completion", () => {
  it.skipIf(!isDesktopE2E)("auto-dispatches newly unblocked tasks when the project setting is enabled", async () => {
    expect(testHome).toBeTruthy();

    const repoPath = join(testHome!, "workspace", "auto-dispatch-blockers", "repository");
    mkdirSync(repoPath, { recursive: true });
    writeFileSync(join(repoPath, "README.md"), "auto dispatch blockers repo\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repoPath, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoPath, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string; slug: string }>(sessionId, "create_project", {
        input: {
          name: "Auto Dispatch Project",
          description: "Auto dispatch on blocker completion desktop test.",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Auto Dispatch Repo",
          repositoryPath: repoPath,
          defaultBranch: "main",
        },
      });

      const developerRole = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Developer",
          description: "Desktop auto dispatch role.",
          systemPrompt: "Implement the task.",
          capacity: 1,
        },
      });

      const blockerWorkflow = await invokeCommand<any>(sessionId, "create_workflow", {
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
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

      const dependentWorkflow = await invokeCommand<any>(sessionId, "create_workflow", {
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
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });

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

      const dependentTask = await invokeCommand<any>(sessionId, "create_task", {
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
      });

      await invokeCommand(sessionId, "add_task_dependency", {
        blockerTaskId: blockerTask.id,
        blockedTaskId: dependentTask.id,
      });

      await invokeCommand(sessionId, "set_project_default_repository", { projectId: project.id, repositoryId: repository.id });
      writeFileSync(
        join(testHome!, ".orchestra", "projects", project.slug, "settings.json"),
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
      await selectByLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await waitForSelectedLabel(sessionId, '[data-role="project-switcher"]', project.name);
      await clickByText(sessionId, "button", "Tasks");
      await waitForText(sessionId, "Blocker task");

      await invokeCommand(sessionId, "complete_lane_as_success", {
        taskId: blockerTask.id,
        notes: "Finished blocker in desktop test.",
      });

      const autoDispatched = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: dependentTask.id }),
        (task) => task.status === "in_progress" && Boolean(task.activeLaneAssignment?.sessionId),
        60_000,
      );

      expect(autoDispatched.assigneeType).toBe("role");
      expect(autoDispatched.activeLaneAssignment?.workerType).toBe("role");
      expect(autoDispatched.activeLaneAssignment?.status).toBe("active");
      expect(typeof autoDispatched.activeLaneAssignment?.runtimeCwd).toBe("string");

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: blockerTask.id }),
        (task) => task.status === "completed",
      );
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 240_000);
});
