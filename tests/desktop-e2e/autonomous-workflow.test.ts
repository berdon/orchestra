import { existsSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  getDomSnapshot,
  invokeCommand,
  selectValue,
  sleep,
  waitForSelectOption,
  waitForText,
} from "./driver";

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
    rmSync(targetFile, { force: true });

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; name: string }>(sessionId, "create_project", {
        input: {
          name: "Autonomous Workflow Project",
          description: "Deterministic autonomous desktop workflow test.",
        },
      });

      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Autonomous Workflow Repo",
          localPath: join(testHome!, "workspace", "autonomous-workflow-repo"),
          remoteUrl: null,
          defaultBranch: "main",
        },
      });

      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");
      await waitForSelectOption(sessionId, '[data-role="project-switcher"]', { value: project.id });
      await selectValue(sessionId, '[data-role="project-switcher"]', project.id);
      await sleep(1_000);

      const agent = await invokeCommand<{ id: string; slug: string; name: string }>(sessionId, "create_agent", {
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
            "When verification succeeds, immediately call complete_lane_as_success with notes 'autonomous desktop e2e complete'.",
            "If anything fails, immediately call request_user_intervention.",
          ].join(" "),
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          roleId: null,
          thinkingLevel: "off",
          policyIds: ["policy-supervisor"],
          directPermissions: [],
        },
      });

      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Autonomous Desktop Workflow",
          description: "Single deterministic agent lane that must complete autonomously.",
          lanes: [
            {
              id: "autonomous-lane",
              key: "autonomous-build",
              name: "Autonomous Build",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: agent.slug,
              entryPromptTemplate: `Create ${targetFile} with exact contents ${JSON.stringify(expectedContents)} and then complete the lane using Orchestra tools.`,
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
          title: "Autonomous desktop workflow task",
          description: `Create and validate ${targetFile}.`,
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

      await clickByText(sessionId, "button", "Sessions");
      await waitForText(sessionId, "Sessions");

      const dispatchedTask = await invokeCommand<any>(sessionId, "dispatch_task_lane", { taskId: createdTask.id });
      expect(dispatchedTask.activeLaneAssignment?.workerType).toBe("agent");

      await waitForCondition(
        () => invokeCommand<Array<{ title: string }>>(sessionId, "list_sessions"),
        (sessions) => sessions.some((entry) => entry.title === "Autonomous Builder Agent main session"),
        60_000,
      );
      await waitForText(sessionId, "Autonomous Builder Agent main session", 30_000);

      const completedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: createdTask.id }),
        (currentTask) => currentTask.status === "completed" && currentTask.activeLaneAssignment == null,
        180_000,
      );

      expect(completedTask.currentLaneId).toBeNull();
      expect(completedTask.laneRuns).toHaveLength(1);
      expect(completedTask.laneRuns[0]?.result).toBe("success");
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
