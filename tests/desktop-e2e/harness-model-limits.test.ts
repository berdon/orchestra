import { mkdirSync, writeFileSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import {
  clickByText,
  clickSelector,
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  executeScript,
  getSelectOptions,
  invokeCommand,
  selectByLabel,
  setInputValue,
  sleep,
  waitForSelector,
  waitForText,
} from "./driver";
import { startZaiUsageHarness } from "./zai-usage-harness";

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

function setupRepository(root: string) {
  mkdirSync(root, { recursive: true });
  execFileSync("git", ["init", "-b", "main"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.name", "Desktop E2E"], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["config", "user.email", "desktop-e2e@example.invalid"], { cwd: root, stdio: "ignore" });
  writeFileSync(join(root, "README.md"), "# Harness limits desktop test\n", "utf8");
  execFileSync("git", ["add", "."], { cwd: root, stdio: "ignore" });
  execFileSync("git", ["commit", "-m", "Initial commit"], { cwd: root, stdio: "ignore" });
}

describe("desktop harness model limits", () => {
  it.skipIf(!isDesktopE2E)("configures Harness → Models limits and pauses matching sessions/lanes from mocked Z.ai quota responses", async () => {
    expect(testHome).toBeTruthy();
    const zaiHarness = await startZaiUsageHarness({ rolling5hPercent: 30, weeklyPercent: 20 });
    const repositoryRoot = join(testHome!, "workspace", "harness-model-limits-repo", "repository");
    setupRepository(repositoryRoot);

    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      const project = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_project", {
        input: {
          name: "Harness Limits Project",
          description: "Desktop E2E model-limit coverage.",
          taskPrefix: "HLM",
        },
      });
      const repository = await invokeCommand<{ id: string }>(sessionId, "create_repository", {
        projectId: project.id,
        input: {
          name: "Harness Limits Repo",
          repositoryPath: repositoryRoot,
          defaultBranch: "main",
        },
      });
      await invokeCommand(sessionId, "set_project_default_repository", {
        projectId: project.id,
        repositoryId: repository.id,
      });

      const role = await invokeCommand<{ id: string; slug: string }>(sessionId, "create_role", {
        input: {
          name: "Z.ai Worker",
          description: "Uses the mocked Z.ai model.",
          systemPrompt: "Implement the requested task.",
          capacity: 1,
          provider: "zai",
          model: "glm-4.6",
        },
      });

      const workflow = await invokeCommand<any>(sessionId, "create_workflow", {
        input: {
          name: "Harness Limits Flow",
          description: "Single role lane for model-limit pause checks.",
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Implement the task.",
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

      await invokeCommand(sessionId, "set_pi_provider_api_key", {
        providerId: "zai",
        apiKey: "zai-test-token",
      });
      await invokeCommand(sessionId, "save_pi_models_json", {
        content: JSON.stringify({
          providers: {
            zai: {
              baseUrl: zaiHarness.providerBaseUrl,
              api: "openai-completions",
              apiKey: "ZAI_TEST_TOKEN",
              models: [
                {
                  id: "glm-4.6",
                  name: "GLM 4.6",
                  reasoning: true,
                  input: ["text"],
                },
              ],
            },
          },
        }, null, 2),
      });
      await executeScript(sessionId, `window.dispatchEvent(new CustomEvent('orchestra:pi-setup-change')); return true;`);

      await clickByText(sessionId, "button", "Settings");
      await clickByText(sessionId, '[role="tab"]', "Harness");
      await waitForText(sessionId, "Harness settings");
      await waitForCondition(
        () => executeScript<string | null>(sessionId, `
          const badge = document.querySelector('[data-role="pi-setup-status"]');
          return badge ? (badge.textContent || '').trim() : null;
        `),
        (status) => Boolean(status) && status !== "Refreshing…",
      );
      await clickSelector(sessionId, '[data-role="harness-detail-tab-models"]');
      await waitForText(sessionId, "Structured model policies");
      await waitForText(sessionId, "No model limit rows yet. Add a row to choose a provider/model and set limits.");
      expect(await executeScript<number>(sessionId, `
        return document.querySelectorAll('[data-role^="harness-model-policy-row-"]').length;
      `)).toBe(0);

      await clickSelector(sessionId, '[data-role="add-harness-model-policy-row"]');
      await waitForSelector(sessionId, '[data-role="harness-model-provider-0"]');
      await selectByLabel(sessionId, '[data-role="harness-model-provider-0"]', "zai");

      const modelOptions = await waitForCondition(
        () => getSelectOptions(sessionId, '[data-role="harness-model-select-0"]'),
        (options) => options.some((option) => option.label.includes("GLM 4.6")),
      );
      const glmModelOption = modelOptions.find((option) => option.label.includes("GLM 4.6"));
      expect(glmModelOption).toBeTruthy();
      await executeScript(sessionId, `
        const select = document.querySelector(arguments[0]);
        const value = arguments[1];
        if (!(select instanceof HTMLSelectElement) || typeof value !== 'string') {
          return false;
        }
        const descriptor = Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, 'value');
        descriptor?.set?.call(select, value);
        select.dispatchEvent(new Event('input', { bubbles: true }));
        select.dispatchEvent(new Event('change', { bubbles: true }));
        return true;
      `, ['[data-role="harness-model-select-0"]', glmModelOption?.value ?? ""]);

      await setInputValue(sessionId, '[data-role="harness-model-rolling-5h-0"]', "90");
      await setInputValue(sessionId, '[data-role="harness-model-weekly-0"]', "80");
      await sleep(250);
      await clickSelector(sessionId, '[data-role="save-harness-model-policy-0"]');

      const savedSnapshot = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_harness_model_limits_snapshot"),
        (snapshot) => Array.isArray(snapshot?.policies) && snapshot.policies.some((policy: any) => policy.modelRef?.provider === "zai" && policy.modelRef?.modelId === "glm-4.6"),
      );
      expect(savedSnapshot.policies).toHaveLength(1);

      const standaloneSession = await invokeCommand<{ id: string }>(sessionId, "create_session", {
        title: "Z.ai standalone session",
        projectSlug: project.slug,
      });
      await invokeCommand(sessionId, "set_session_model", {
        sessionId: standaloneSession.id,
        provider: "zai",
        modelId: "glm-4.6",
      });

      const activeTask = await invokeCommand<{ id: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Below-threshold task",
          description: "Should run without being paused when quota is below the cap.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0].id,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });
      await invokeCommand(sessionId, "dispatch_task_lane", { taskId: activeTask.id });
      await invokeCommand(sessionId, "run_dispatcher_tick");
      await invokeCommand(sessionId, "dispatch_role_queue", { roleId: role.id }).catch(() => undefined);

      const runningTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: activeTask.id }),
        (task) => task?.activeLaneAssignment?.status === "active" && Boolean(task.activeLaneAssignment?.sessionId),
        40_000,
      );
      expect(runningTask.activeLaneAssignment.status).toBe("active");

      zaiHarness.setQuota({ rolling5hPercent: 95, weeklyPercent: 20 });
      await invokeCommand(sessionId, "run_dispatcher_tick");

      const pausedTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: activeTask.id }),
        (task) => task?.activeLaneAssignment?.status === "paused_by_user",
        30_000,
      );
      expect(pausedTask.status).toBe("in_review");
      expect(pausedTask.activeLaneAssignment.completionNotes).toContain("rolling_5h_percent");

      await expect(invokeCommand(sessionId, "send_session_message", {
        sessionId: standaloneSession.id,
        message: "This should be blocked once the model is capped.",
        runId: `model-limit-block-${Date.now()}`,
      })).rejects.toThrow("current model is capped");

      zaiHarness.setQuota({ rolling5hPercent: 20, weeklyPercent: 85 });
      const weeklyTask = await invokeCommand<{ id: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Weekly-threshold task",
          description: "Should pause before queued role work starts when weekly quota is capped.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow.id,
          currentLaneId: workflow.lanes[0].id,
          repositoryId: repository.id,
          repositoryIds: [repository.id],
          assigneeType: "unassigned",
          assigneeId: null,
        },
      });
      await invokeCommand(sessionId, "dispatch_task_lane", { taskId: weeklyTask.id });
      await invokeCommand(sessionId, "run_dispatcher_tick");

      const pausedWeeklyTask = await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: weeklyTask.id }),
        (task) => task?.activeLaneAssignment?.status === "paused_by_user",
        30_000,
      );
      expect(pausedWeeklyTask.activeLaneAssignment.completionNotes).toContain("weekly_percent");
      expect(pausedWeeklyTask.status).toBe("in_review");
    } finally {
      await deleteWebdriverSession(sessionId);
      await zaiHarness.stop();
    }
  }, 240_000);
});
