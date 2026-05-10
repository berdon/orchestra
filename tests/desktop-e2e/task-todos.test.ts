import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  getDomSnapshot,
  invokeCommand,
  sleep,
  waitForText,
} from "./driver";
import {
  addRepositoryViaSettings,
  createProjectViaSettings,
  createTaskViaTasks,
  openTaskCard,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 180_000) {
  const deadline = Date.now() + timeoutMs;
  let lastValue: T | undefined;

  while (Date.now() < deadline) {
    lastValue = await callback();
    if (predicate(lastValue)) {
      return lastValue;
    }
    await sleep(1_000);
  }

  throw new Error(`Condition not met before timeout. Last value: ${JSON.stringify(lastValue, null, 2)}`);
}

function initializeGitRepository(root: string, readmeContents: string) {
  rmSync(root, { recursive: true, force: true });
  mkdirSync(root, { recursive: true });
  writeFileSync(join(root, "README.md"), readmeContents, "utf8");
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "init"], { cwd: root, stdio: "ignore" });
}

async function configureRoleModel(sessionId: string, roleId: string, overrides?: { systemPrompt?: string }) {
  const role = await invokeCommand<any>(sessionId, "get_role", { roleId });
  return invokeCommand<any>(sessionId, "update_role", {
    roleId,
    input: {
      name: role.name,
      description: role.description ?? null,
      systemPrompt: overrides?.systemPrompt ?? role.systemPrompt ?? null,
      provider: "openai-codex",
      model: "gpt-5.3-codex-spark",
      thinkingLevel: role.thinkingLevel,
      capacity: role.capacity,
      compactionWindow: role.compactionWindow ?? null,
      policyIds: role.policyIds ?? [],
      directPermissions: role.directPermissions ?? [],
    },
  });
}

function buildRoleTodoPrompt(options: {
  todoDescription: string;
  laneId: string;
  completionSummary: string;
  completionNotes: string;
}) {
  return [
    "You are a deterministic Orchestra role worker.",
    "When a task is dispatched to you, read the canonical task ID from the prompt.",
    `Call add_task_todo with description ${JSON.stringify(options.todoDescription)} and laneId ${JSON.stringify(options.laneId)}. You may omit taskId so the active assignment task is used.`,
    "Then immediately call complete_lane_as_success with the canonical task ID from the prompt, summary 'Attempted completion before finishing todo.', and notes 'stock role todo precheck'.",
    `If Orchestra rejects that completion because unfinished todo items remain, call list_unfinished_task_todos for the canonical task ID and laneId ${JSON.stringify(options.laneId)}, mark every returned todo finished with mark_task_todo_finished, then call complete_lane_as_success with the canonical task ID, summary ${JSON.stringify(options.completionSummary)}, and notes ${JSON.stringify(options.completionNotes)}.`,
    "Do not ask questions and do not stop early.",
  ].join(" ");
}

describe("desktop task todos", () => {
  it.skipIf(!isDesktopE2E)("lets a real worker use task todo tools and blocks completion until the lane todo is finished", async () => {
    expect(testHome).toBeTruthy();

    const repositoryRoot = join(testHome!, "workspace", "task-todos-repo");
    initializeGitRepository(repositoryRoot, "task todos repo\n");

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Task Todos Project", "Desktop test for task todo tools and completion gating.");
      await addRepositoryViaSettings(sessionId, {
        name: "Task Todos Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Task Todos Project");

      const agent = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_agent", {
        input: {
          name: "Task Todo Agent",
          description: "Deterministically exercises task todo creation and gating.",
          systemPrompt: [
            "You are a deterministic Orchestra agent.",
            "When a task is dispatched to you, call add_task_todo with description 'Verify lane checklist completion' and laneId 'lane-todo-execution'. You may omit taskId so the active assignment task is used.",
            "Then immediately call complete_lane_as_success with the canonical task ID from the prompt, summary 'Attempted completion before finishing todos.', and notes 'attempt before todo completion'.",
            "If Orchestra rejects that completion because unfinished todo items remain, call list_unfinished_task_todos for the canonical task ID and current lane, mark every returned todo finished with mark_task_todo_finished, and then call complete_lane_as_success with the canonical task ID, summary 'Completed the todo-gated lane after finishing the checklist.', and notes 'task todo desktop e2e complete'.",
            "Do not ask questions and do not stop early.",
          ].join(" "),
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          directPermissions: ["tasks.read", "tasks.update", "tasks.transition"],
        },
      });
      expect(agent).toBeTruthy();

      const workflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Task Todo Workflow",
          description: "Single deterministic agent lane that must use task todos before completing.",
          lanes: [
            {
              id: "lane-todo-execution",
              key: "todo-execution",
              name: "Todo Execution",
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: agent.slug,
              entryPromptTemplate: "Use Orchestra task todo tools, prove the completion gate, and finish only after the todo is marked complete.",
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
      expect(workflow).toBeTruthy();

      await createTaskViaTasks(sessionId, {
        title: "Desktop task todo task",
        description: "Exercise task todo creation and completion gating.",
        repositoryName: "Task Todos Repo",
        workflowName: "Task Todo Workflow",
        publish: true,
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "Task Todos Project"));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === "Desktop task todo task"));
      expect(createdTask).toBeTruthy();

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Sessions");

      await openTaskCard(sessionId, "Desktop task todo task");

      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "completed" && task.activeLaneAssignment == null && Array.isArray(task.todos) && task.todos.length > 0 && task.todos.every((todo: { completed: boolean }) => todo.completed),
        240_000,
      );

      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.todos.length).toBeGreaterThanOrEqual(1);
      expect(completedTask.todos.every((todo: { description: string; completed: boolean }) => todo.description.includes("Verify lane checklist completion") && todo.completed)).toBe(true);
      expect(completedTask.laneRuns.some((laneRun: { result: string }) => laneRun.result === "success")).toBe(true);

      const workerSessionId = completedTask.laneRuns?.at(-1)?.sessionId;
      expect(workerSessionId).toBeTruthy();
      const workerSessionRecord = await invokeCommand<{ events?: Array<{ message?: string | null }> }>(sessionId, "get_session_record", {
        sessionId: workerSessionId,
      });
      expect(
        workerSessionRecord.events?.some((event) => (event.message ?? "").includes("unfinished todo item(s)")) ?? false,
      ).toBe(true);

      const dom = await getDomSnapshot(sessionId);
      expect(dom.text).toContain("Desktop task todo task");
    } catch (error) {
      const dom = await getDomSnapshot(sessionId).catch(() => null);
      const logs = await invokeCommand<any[]>(sessionId, "get_logs").catch(() => []);
      const sessions = await invokeCommand<any[]>(sessionId, "list_sessions").catch(() => []);
      console.error("task todos dom", dom?.text ?? "<unavailable>");
      console.error("task todos logs", JSON.stringify(logs.slice(0, 50), null, 2));
      console.error("task todos sessions", JSON.stringify(sessions, null, 2));
      throw error;
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 360_000);

  it.skipIf(!isDesktopE2E)("lets the seeded Development workflow default roles finish lane todos in stock role sessions", async () => {
    expect(testHome).toBeTruthy();

    const repositoryRoot = join(testHome!, "workspace", "task-todos-stock-role-repo");
    initializeGitRepository(repositoryRoot, "stock development workflow role todo repo\n");

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Task Todos Stock Role Project", "Desktop regression for seeded Development workflow default-role todo completion.");
      await addRepositoryViaSettings(sessionId, {
        name: "Task Todos Stock Role Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Task Todos Stock Role Project");

      const roles = await invokeCommand<Array<{ id: string; slug: string; name: string }>>(sessionId, "list_roles", {
        includeArchived: false,
      });
      const architectRole = roles.find((entry) => entry.slug === "architect" || entry.name === "Architect");
      const seniorDeveloperRole = roles.find((entry) => entry.slug === "senior-developer" || entry.name === "Senior Developer");
      const qaRole = roles.find((entry) => entry.slug === "qa" || entry.name === "QA");
      expect(architectRole).toBeTruthy();
      expect(seniorDeveloperRole).toBeTruthy();
      expect(qaRole).toBeTruthy();

      const developmentWorkflowSummary = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_workflows", {
        includeArchived: false,
      }).then((workflows) => workflows.find((entry) => entry.name === "Development"));
      expect(developmentWorkflowSummary).toBeTruthy();
      const developmentWorkflow = await invokeCommand<any>(sessionId, "get_workflow", {
        workflowId: developmentWorkflowSummary!.id,
      });
      const planLane = developmentWorkflow.lanes.find((lane: { key: string }) => lane.key === "plan");
      const implementLane = developmentWorkflow.lanes.find((lane: { key: string }) => lane.key === "implement");
      const verifyLane = developmentWorkflow.lanes.find((lane: { key: string }) => lane.key === "verify");
      expect(planLane).toBeTruthy();
      expect(implementLane).toBeTruthy();
      expect(verifyLane).toBeTruthy();

      const expectedRoleChecks = [
        {
          roleId: architectRole!.id,
          roleName: architectRole!.name,
          laneId: planLane.id,
          todoDescription: "Verify Architect seeded Development workflow role todo completion",
          completionSummary: "Completed the plan lane after finishing the todo.",
          completionNotes: "stock development architect role todo regression complete",
        },
        {
          roleId: seniorDeveloperRole!.id,
          roleName: seniorDeveloperRole!.name,
          laneId: implementLane.id,
          todoDescription: "Verify Senior Developer seeded Development workflow role todo completion",
          completionSummary: "Completed the implement lane after finishing the todo.",
          completionNotes: "stock development senior developer role todo regression complete",
        },
        {
          roleId: qaRole!.id,
          roleName: qaRole!.name,
          laneId: verifyLane.id,
          todoDescription: "Verify QA seeded Development workflow role todo completion",
          completionSummary: "Completed the verify lane after finishing the todo.",
          completionNotes: "stock development qa role todo regression complete",
        },
      ];

      const configuredRoles = [] as Array<{ name: string }>;
      for (const check of expectedRoleChecks) {
        const configuredRole = await configureRoleModel(sessionId, check.roleId, {
          systemPrompt: buildRoleTodoPrompt({
            todoDescription: check.todoDescription,
            laneId: check.laneId,
            completionSummary: check.completionSummary,
            completionNotes: check.completionNotes,
          }),
        });
        expect(configuredRole.directPermissions ?? []).toContain("tasks.update");
        configuredRoles.push({ name: configuredRole.name });
      }

      const taskTitle = "Desktop stock role task todo task";

      await createTaskViaTasks(sessionId, {
        title: taskTitle,
        description: "Stock Development workflow regression. Deterministically exercise the built-in Architect, Senior Developer, and QA role task-todo tools.",
        repositoryName: "Task Todos Stock Role Repo",
        workflowName: "Development",
        publish: true,
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "Task Todos Stock Role Project"));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === taskTitle));
      expect(createdTask).toBeTruthy();

      const roleVerifiedTask = await waitForCondition(
        async () => {
          let currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          if (!currentTask.activeLaneAssignment?.sessionId && currentTask.currentLaneId === planLane.id) {
            await invokeCommand(sessionId, "dispatch_task_lane", { taskId: createdTask!.id }).catch(() => undefined);
          }
          await invokeCommand(sessionId, "run_dispatcher_tick").catch(() => undefined);
          for (const check of expectedRoleChecks) {
            await invokeCommand(sessionId, "dispatch_role_queue", { roleId: check.roleId }).catch(() => undefined);
          }
          currentTask = await invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id });
          return currentTask;
        },
        (task) => expectedRoleChecks.every((check) => task.laneRuns.some((laneRun: { laneId: string; result: string }) => laneRun.laneId === check.laneId && laneRun.result === "success"))
          && expectedRoleChecks.every((check) => task.todos.some((todo: { laneId: string; description: string; completed: boolean }) => todo.laneId === check.laneId && todo.description === check.todoDescription && todo.completed)),
        360_000,
      );

      expect(roleVerifiedTask.todos.length).toBeGreaterThanOrEqual(expectedRoleChecks.length);
      for (const check of expectedRoleChecks) {
        expect(roleVerifiedTask.todos.some((todo: { laneId: string; description: string; completed: boolean }) => todo.laneId === check.laneId && todo.description === check.todoDescription && todo.completed)).toBe(true);
        const laneRun = roleVerifiedTask.laneRuns.find((entry: { laneId: string; result: string; sessionId?: string | null }) => entry.laneId === check.laneId && entry.result === "success");
        expect(laneRun?.sessionId).toBeTruthy();
        const workerSessionRecord = await invokeCommand<{ events?: Array<{ message?: string | null }> }>(sessionId, "get_session_record", {
          sessionId: laneRun!.sessionId,
        });
        expect(
          workerSessionRecord.events?.some((event) => (event.message ?? "").includes("unfinished todo item(s)")) ?? false,
        ).toBe(true);
      }

      const sessions = await invokeCommand<Array<{ title?: string; status?: string }>>(sessionId, "list_sessions");
      for (const configuredRole of configuredRoles) {
        expect(
          sessions.some((entry) => entry.title === `${configuredRole.name} · ${roleVerifiedTask.number} · ${taskTitle}` && entry.status === "closed"),
        ).toBe(true);
      }
    } catch (error) {
      const dom = await getDomSnapshot(sessionId).catch(() => null);
      const logs = await invokeCommand<any[]>(sessionId, "get_logs").catch(() => []);
      const sessions = await invokeCommand<any[]>(sessionId, "list_sessions").catch(() => []);
      console.error("stock role task todos dom", dom?.text ?? "<unavailable>");
      console.error("stock role task todos logs", JSON.stringify(logs.slice(0, 50), null, 2));
      console.error("stock role task todos sessions", JSON.stringify(sessions, null, 2));
      throw error;
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 420_000);
});
