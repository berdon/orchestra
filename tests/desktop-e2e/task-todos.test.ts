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

describe("desktop task todos", () => {
  it.skipIf(!isDesktopE2E)("lets a real worker use task todo tools and blocks completion until the lane todo is finished", async () => {
    expect(testHome).toBeTruthy();

    const repositoryRoot = join(testHome!, "workspace", "task-todos-repo");
    rmSync(repositoryRoot, { recursive: true, force: true });
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, "README.md"), "task todos repo\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repositoryRoot, stdio: "ignore" });

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
            "When a task is dispatched to you, call add_task_todo with description 'Verify lane checklist completion' and let taskId and laneId default from the active assignment.",
            "Then immediately call complete_lane_as_success with the canonical task ID from the prompt and notes 'attempt before todo completion'.",
            "If Orchestra rejects that completion because unfinished todo items remain, call list_unfinished_task_todos for the canonical task ID and current lane, mark every returned todo finished with mark_task_todo_finished, and then call complete_lane_as_success with the canonical task ID and notes 'task todo desktop e2e complete'.",
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

      const sessions = await invokeCommand<Array<{ title: string; events?: Array<{ message?: string | null }> }>>(sessionId, "list_sessions");
      expect(sessions.some((entry) => entry.title === "Task Todo Agent main session")).toBe(true);
      expect(
        sessions.some((entry) => entry.events?.some((event) => (event.message ?? "").includes("unfinished todo item(s)")) ?? false),
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
});
