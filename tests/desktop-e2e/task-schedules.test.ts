import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  ensureReactReady,
  getDomSnapshot,
  invokeCommand,
  sleep,
  waitForText,
} from "./driver";
import {
  createProjectViaSettings,
  createScheduledTaskViaTasks,
  createWorkflowViaSettings,
  switchProject,
} from "./ui-flows";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

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

function utcDateTimeLocalValue(offsetMinutes: number) {
  const date = new Date(Date.now() + offsetMinutes * 60_000);
  const year = date.getUTCFullYear();
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  const day = String(date.getUTCDate()).padStart(2, "0");
  const hours = String(date.getUTCHours()).padStart(2, "0");
  const minutes = String(date.getUTCMinutes()).padStart(2, "0");
  return `${year}-${month}-${day}T${hours}:${minutes}`;
}

describe("desktop scheduled tasks", () => {
  it.skipIf(!isDesktopE2E)("materializes time-based schedules and enforces skip-overlap event schedules", async () => {
    const sessionId = await createReadyWebdriverSession();
    try {
      await ensureReactReady(sessionId);

      await createProjectViaSettings(sessionId, "Scheduled Tasks Project", "Desktop coverage for scheduled and recurring task automation.");
      await switchProject(sessionId, "Scheduled Tasks Project");
      await createWorkflowViaSettings(sessionId, {
        name: "Scheduled Workflow",
        description: "Single user lane for scheduled automation coverage.",
        lanes: [
          {
            name: "Plan",
            key: "plan",
            ownerType: "user",
            entryPromptTemplate: "Handle scheduled work.",
            successTransitionType: "end",
          },
        ],
      });
      const workflow = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_workflows", { includeArchived: false })
        .then((workflows) => workflows.find((entry) => entry.name === "Scheduled Workflow"));
      expect(workflow).toBeTruthy();

      await createScheduledTaskViaTasks(sessionId, {
        title: "Time kickoff",
        description: "Create a task from a past-due one-shot schedule.",
        workflowName: "Scheduled Workflow",
        trigger: { type: "time", kind: "once", at: utcDateTimeLocalValue(-2), timezone: "UTC" },
      });

      const project = await invokeCommand<Array<{ id: string; name: string }>>(sessionId, "list_projects")
        .then((projects) => projects.find((entry) => entry.name === "Scheduled Tasks Project"));
      expect(project).toBeTruthy();

      await invokeCommand(sessionId, "run_dispatcher_tick");
      const timeTask = await waitForCondition(
        () => invokeCommand<any[]>(sessionId, "list_tasks", { projectId: project!.id, includeArchived: false }),
        (tasks) => tasks.some((task) => task.title === "Time kickoff"),
      );
      expect(timeTask.some((task) => task.title === "Time kickoff")).toBe(true);

      await createScheduledTaskViaTasks(sessionId, {
        title: "Event follow-up",
        description: "Generated whenever a task is created, unless another generated instance is still open.",
        workflowName: "Scheduled Workflow",
        overlapPolicy: "skip",
        trigger: { type: "event", eventKey: "task.created" },
      });

      await invokeCommand(sessionId, "create_task", {
        projectId: project!.id,
        input: {
          title: "Trigger source one",
          description: "First event-trigger source task.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow!.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          whipMaxAttempts: 10,
          archived: false,
        },
      });
      await invokeCommand(sessionId, "run_dispatcher_tick");
      await waitForCondition(
        () => invokeCommand<any[]>(sessionId, "list_tasks", { projectId: project!.id, includeArchived: false }),
        (tasks) => tasks.filter((task) => task.title === "Event follow-up").length === 1,
      );

      await invokeCommand(sessionId, "create_task", {
        projectId: project!.id,
        input: {
          title: "Trigger source two",
          description: "Second event-trigger source task.",
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: workflow!.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          whipMaxAttempts: 10,
          archived: false,
        },
      });
      await invokeCommand(sessionId, "run_dispatcher_tick");
      const afterSkip = await waitForCondition(
        () => invokeCommand<any[]>(sessionId, "list_tasks", { projectId: project!.id, includeArchived: false }),
        (tasks) => tasks.filter((task) => task.title === "Event follow-up").length === 1,
      );
      expect(afterSkip.filter((task) => task.title === "Event follow-up")).toHaveLength(1);

      const schedules = await invokeCommand<any[]>(sessionId, "list_task_schedules", { projectId: project!.id });
      expect(schedules.some((schedule) => schedule.title === "Time kickoff")).toBe(true);
      expect(schedules.some((schedule) => schedule.title === "Event follow-up")).toBe(true);
    } catch (error) {
      const dom = await getDomSnapshot(sessionId).catch(() => null);
      const logs = await invokeCommand<any[]>(sessionId, "get_logs").catch(() => []);
      console.error("task schedules dom", dom?.text ?? "<unavailable>");
      console.error("task schedules logs", JSON.stringify(logs.slice(-80), null, 2));
      throw error;
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 360_000);
});
