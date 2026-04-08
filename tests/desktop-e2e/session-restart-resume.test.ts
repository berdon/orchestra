import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
  createTaskViaTasks,
  createWorkflowViaSettings,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);
const testHome = process.env.ORCHESTRA_TEST_HOME;
const WAITING_TOKEN = "WAITING_FOR_ORCHESTRA_RESTART";
const RESUMED_TOKEN = "RESUMED_AFTER_ORCHESTRA_RESTART";

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

describe("desktop session restart resume", () => {
  it.skipIf(!isDesktopE2E)("resumes active task session work after Orchestra restarts", async () => {
    expect(testHome).toBeTruthy();

    const repositoryRoot = join(testHome!, "workspace", "session-restart-resume-repo");
    const resumeOutputPath = join(testHome!, "workspace", "session-restart-resume-output.txt");
    const expectedOutput = `${RESUMED_TOKEN}\n`;
    rmSync(repositoryRoot, { recursive: true, force: true });
    rmSync(resumeOutputPath, { force: true });
    mkdirSync(repositoryRoot, { recursive: true });
    writeFileSync(join(repositoryRoot, "README.md"), "session restart resume repo\n", "utf8");
    execFileSync("git", ["init", "-b", "main"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["add", "."], { cwd: repositoryRoot, stdio: "ignore" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repositoryRoot, stdio: "ignore" });

    let firstSessionId: string | null = null;
    let secondSessionId: string | null = null;

    try {
      firstSessionId = await createReadyWebdriverSession();
      await ensureReactReady(firstSessionId);

      await createProjectViaSettings(firstSessionId, "Restart Resume Project", "Verify active task sessions resume after Orchestra restarts.");
      await addRepositoryViaSettings(firstSessionId, {
        name: "Restart Resume Repo",
        path: repositoryRoot,
        defaultBranch: "main",
        makeDefault: true,
      });
      await switchProject(firstSessionId, "Restart Resume Project");

      const project = await invokeCommand<Array<{ id: string; name: string }>>(firstSessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "Restart Resume Project"));
      expect(project).toBeTruthy();
      const agent = await invokeCommand<{ slug: string }>(firstSessionId, "create_agent", {
        input: {
          name: "Restart Resume Agent",
          description: "Waits for an Orchestra restart, then resumes and completes deterministically.",
          systemPrompt: [
            "You are a deterministic Orchestra agent for a restart-resume test.",
            `Before any restart-resume message arrives, reply with exactly ${WAITING_TOKEN}, do not create ${resumeOutputPath}, and do not complete the lane yet.`,
            `When you later receive a follow-up message that says Orchestra restarted and tells you to resume the active task, immediately create the requested file, verify it, reply with exactly ${RESUMED_TOKEN}, and then call complete_lane_as_success with notes 'restart resume complete'.`,
            `When resuming, write the exact file ${resumeOutputPath} with the exact contents ${JSON.stringify(expectedOutput)}.`,
            "Do not ask questions. Do not wait for human input once the restart-resume message arrives.",
          ].join(" "),
          provider: "openai-codex",
          model: "gpt-5.3-codex-spark",
          thinkingLevel: "off",
          policyIds: ["policy-supervisor"],
        },
      });

      await createWorkflowViaSettings(firstSessionId, {
        name: "Restart Resume Workflow",
        description: "Single deterministic agent lane that only completes after app restart.",
        lanes: [
          {
            name: "Resume After Restart",
            key: "resume-after-restart",
            ownerType: "agent",
            ownerReference: agent.slug,
            entryPromptTemplate: `Wait until Orchestra restarts, then create ${resumeOutputPath} with exact contents ${JSON.stringify(expectedOutput)} and complete the lane.`,
          },
        ],
      });

      await createTaskViaTasks(firstSessionId, {
        title: "Restart resume task",
        description: `Only complete after Orchestra restarts and you create ${resumeOutputPath}.`,
        repositoryName: "Restart Resume Repo",
        workflowName: "Restart Resume Workflow",
        publish: true,
      });

      const createdTask = await invokeCommand<Array<{ id: string; title: string }>>(firstSessionId, "list_tasks", {
        projectId: project!.id,
        includeArchived: false,
      }).then((tasks) => tasks.find((entry) => entry.title === "Restart resume task"));
      expect(createdTask).toBeTruthy();

      const taskBeforeDispatch = await invokeCommand<any>(firstSessionId, "get_task", { taskId: createdTask!.id });
      if (!taskBeforeDispatch.activeLaneAssignment?.sessionId) {
        await invokeCommand(firstSessionId, "dispatch_task_lane", { taskId: createdTask!.id });
      }

      const dispatchedTask = await waitForCondition(
        () => invokeCommand<any>(firstSessionId!, "get_task", { taskId: createdTask!.id }),
        (task) => Boolean(task.activeLaneAssignment?.sessionId),
        120_000,
      );
      const workerSessionId = dispatchedTask.activeLaneAssignment.sessionId as string;
      expect(workerSessionId).toBeTruthy();

      const initialSessionRecord = await waitForCondition(
        () => invokeCommand<any>(firstSessionId!, "get_session_record", { sessionId: workerSessionId }),
        (record) => Array.isArray(record.events) && record.events.some((event: { message?: string }) => event.message?.includes(WAITING_TOKEN)),
        180_000,
      );
      expect(initialSessionRecord.events.some((event: { message?: string }) => event.message?.includes(WAITING_TOKEN))).toBe(true);
      expect(existsSync(resumeOutputPath)).toBe(false);

      await deleteWebdriverSession(firstSessionId);
      firstSessionId = null;

      secondSessionId = await createReadyWebdriverSession();
      await ensureReactReady(secondSessionId);
      await switchProject(secondSessionId, "Restart Resume Project");

      const resumedTask = await waitForCondition(
        () => invokeCommand<any>(secondSessionId!, "get_task", { taskId: createdTask!.id }),
        (task) => task.status === "completed" && task.activeLaneAssignment == null,
        240_000,
      );
      expect(resumedTask.status).toBe("completed");
      expect(existsSync(resumeOutputPath)).toBe(true);
      expect(readFileSync(resumeOutputPath, "utf8")).toBe(expectedOutput);

      const resumedSessionRecord = await waitForCondition(
        () => invokeCommand<any>(secondSessionId!, "get_session_record", { sessionId: workerSessionId }),
        (record) => Array.isArray(record.events) && record.events.some((event: { message?: string }) => event.message?.includes(RESUMED_TOKEN)),
        120_000,
      );
      expect(resumedSessionRecord.events.some((event: { message?: string }) => event.message?.includes(RESUMED_TOKEN))).toBe(true);
    } finally {
      if (firstSessionId) {
        await deleteWebdriverSession(firstSessionId).catch(() => undefined);
      }
      if (secondSessionId) {
        await deleteWebdriverSession(secondSessionId).catch(() => undefined);
      }
      rmSync(resumeOutputPath, { force: true });
    }
  }, 420_000);
});
