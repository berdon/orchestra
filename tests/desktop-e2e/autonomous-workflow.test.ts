import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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

describe("desktop autonomous workflow", () => {
  it.skipIf(!isDesktopE2E)("proves a real agent can autonomously complete a deterministic task end to end", async () => {
    expect(testHome).toBeTruthy();

    const targetFile = join(testHome!, "workspace", "autonomous-workflow-output.txt");
    const expectedContents = "AUTONOMOUS_DESKTOP_E2E_OK\n";
    const repositoryRoot = join(testHome!, "workspace", "autonomous-workflow-repo");
    rmSync(targetFile, { force: true });
    rmSync(repositoryRoot, { recursive: true, force: true });
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, "README.md"), "autonomous workflow repo\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repositoryRoot, stdio: "ignore" });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Autonomous Workflow Project", "Deterministic autonomous desktop workflow test.");
      await addRepositoryViaSettings(sessionId, {
        name: "Autonomous Workflow Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(sessionId, "Autonomous Workflow Project");

      const createdAgent = await invokeCommand<{ id: string; slug: string; name: string }>(sessionId, 'create_agent', {
        input: {
        name: "Autonomous Builder Agent",
        description: "Deterministically creates the requested file and completes the lane.",
        systemPrompt: [
          "You are a deterministic Orchestra agent.",
          "Read the canonical task ID from the prompt.",
          `Create the exact file ${targetFile} with the exact contents ${JSON.stringify(expectedContents)}.`,
          "Verify the file exists with the exact contents.",
          "Do not ask questions.",
          "Do not wait for human input.",
          "When verification succeeds, immediately call complete_lane_as_success with summary 'Autonomous workflow verification complete.' and notes 'autonomous desktop e2e complete'.",
          "If anything fails, immediately call request_user_intervention.",
        ].join(" "),
        provider: "openai-codex",
        model: "gpt-5.3-codex-spark",
        thinkingLevel: "off",
        policyIds: ["policy-supervisor"],
        },
      });

      await invokeCommand(sessionId, 'create_workflow', {
        input: {
          name: "Autonomous Desktop Workflow",
          description: "Single deterministic agent lane that must complete autonomously.",
          lanes: [
            {
              name: "Autonomous Build",
              key: "autonomous-build",
              assignedEntityType: "agent",
              assignedEntityId: createdAgent.slug,
              entryPromptTemplate: `Create ${targetFile} with exact contents ${JSON.stringify(expectedContents)} and then complete the lane using Orchestra tools.`,
              successTransitionType: "end",
              failureTransitionType: "end",
            },
          ],
        },
      });

      const workflowSummary = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_workflows', { includeArchived: false });
      expect(workflowSummary.some((entry) => entry.name === 'Autonomous Desktop Workflow')).toBe(true);
      const agentSummaries = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_agents', { includeArchived: false });
      expect(agentSummaries.some((entry) => entry.name === createdAgent.name)).toBe(true);

      await createTaskViaTasks(sessionId, {
        title: "Autonomous desktop workflow task",
        description: `Create and validate ${targetFile}.`,
        repositoryName: "Autonomous Workflow Repo",
        workflowName: "Autonomous Desktop Workflow",
        publish: true,
      });
      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, 'list_projects')
        .then((projects) => projects.find((entry) => entry.name === 'Autonomous Workflow Project'));
      expect(project).toBeTruthy();
      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(sessionId, 'list_tasks', {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === 'Autonomous desktop workflow task'));
      expect(createdTask).toBeTruthy();

      const dispatchedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (task) => Boolean(task.activeLaneAssignment?.sessionId),
      );
      expect(dispatchedTask.activeLaneAssignment?.workerType).toBe("agent");
      const taskRepositories = await invokeCommand<Array<{ taskWorktreePath?: string | null }>>(sessionId, "list_task_repositories", { taskId: createdTask!.id });
      expect(taskRepositories.some((entry) => Boolean(entry.taskWorktreePath))).toBe(true);

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === "Autonomous Builder Agent main session"),
        60_000,
      );
      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Autonomous Builder Agent main session", 30_000);

      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask!.id }),
        (currentTask) => currentTask.status === "completed" && currentTask.activeLaneAssignment == null,
        180_000,
      );

      expect(completedTask.currentLaneId).toBeNull();
      expect((completedTask.laneRuns ?? []).length).toBeGreaterThanOrEqual(1);
      expect(['success', 'needs_user']).toContain(completedTask.laneRuns.at(-1)?.result);
      expect(existsSync(targetFile)).toBe(true);
      expect(readFileSync(targetFile, "utf8")).toBe(expectedContents);

      const sessions = await invokeCommand<Array<{ title: string; events?: Array<{ message: string; kind: string }> }>>(sessionId, "list_sessions");
      const workerSession = sessions.find((entry) => entry.title === "Autonomous Builder Agent main session");
      expect(workerSession).toBeTruthy();

      const dom = await getDomSnapshot(sessionId);
      expect(dom.text).toContain("Autonomous Builder Agent main session");
    } catch (error) {
      const dom = await getDomSnapshot(sessionId).catch(() => null);
      const logs = await invokeCommand<any[]>(sessionId, "get_logs").catch(() => []);
      const sessions = await invokeCommand<any[]>(sessionId, "list_sessions").catch(() => []);
      console.error("autonomous workflow dom", dom?.text ?? "<unavailable>");
      console.error("autonomous workflow logs", JSON.stringify(logs.slice(0, 50), null, 2));
      console.error("autonomous workflow sessions", JSON.stringify(sessions, null, 2));
      throw error;
    } finally {
      await deleteWebdriverSession(sessionId);
      rmSync(targetFile, { force: true });
    }
  }, 300_000);
});
