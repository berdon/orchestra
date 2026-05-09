import { describe, expect, it } from "vitest";

import {
  createReadyWebdriverSession,
  deleteWebdriverSession,
  dispatchWindowEvent,
  ensureReactReady,
  executeScript,
  invokeCommand,
  sleep,
} from "./driver";

const isDesktopE2E = Boolean(process.env.ORCHESTRA_DESKTOP_E2E);

async function waitForCondition<T>(callback: () => Promise<T>, predicate: (value: T) => boolean, timeoutMs = 120_000) {
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

describe("desktop system notifications", () => {
  it.skipIf(!isDesktopE2E)("records system notifications for new user mail and task-attention transitions", async () => {
    const sessionId = await createReadyWebdriverSession();

    try {
      await ensureReactReady(sessionId);
      await executeScript(sessionId, `
        window.__orchestraTestNotifications = [];
        window.__orchestraNotificationTestDriver = {
          permission: "granted",
          async requestPermission() { return "granted"; },
          async notify(input) {
            const container = document.getElementById("orchestra-test-notification-overlay") || (() => {
              const element = document.createElement("div");
              element.id = "orchestra-test-notification-overlay";
              Object.assign(element.style, {
                position: "fixed",
                top: "16px",
                right: "16px",
                zIndex: "99999",
                display: "flex",
                flexDirection: "column",
                gap: "8px",
                maxWidth: "360px",
              });
              document.body.appendChild(element);
              return element;
            })();
            const card = document.createElement("div");
            Object.assign(card.style, {
              background: "rgba(20, 24, 33, 0.96)",
              color: "white",
              borderRadius: "12px",
              padding: "12px 14px",
              boxShadow: "0 12px 30px rgba(0,0,0,0.35)",
              border: "1px solid rgba(255,255,255,0.14)",
              fontFamily: "system-ui, sans-serif",
              whiteSpace: "pre-wrap",
            });
            card.textContent = input.title + "\\n" + input.body;
            container.appendChild(card);
          },
        };
      `);

      const project = await invokeCommand<{ id: string }>(sessionId, "create_project", {
        input: { name: "Notification Project", taskPrefix: "NTP" },
      });
      await dispatchWindowEvent(sessionId, "orchestra:projects-changed");

      const role = await invokeCommand<{ slug: string }>(sessionId, "create_role", {
        input: {
          name: "Notification Worker",
          description: "Handles approval-notification test work.",
          systemPrompt: "Implement the task and stop for approval.",
          capacity: 1,
        },
      });
      const workflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Notification Approval Flow",
          description: "Stops for user approval.",
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Implement the task and stop for approval.",
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: true,
              needsWorkTargetLaneId: null,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      });
      const task = await invokeCommand<{ id: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Desktop notification approval task",
          description: "Task used to verify approval-needed system notifications.",
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: workflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
        },
      });

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: task.id }),
        (loadedTask) => Boolean(loadedTask?.activeLaneAssignment),
      );

      await invokeCommand(sessionId, "send_mailbox_message", {
        input: {
          projectId: project.id,
          recipientType: "user",
          body: "Please review the desktop notification behavior.",
          priority: "interrupt",
        },
      });

      await waitForCondition(
        () => executeScript<any[]>(sessionId, "return window.__orchestraTestNotifications ?? [];"),
        (notifications) => notifications.length >= 1,
      );

      await invokeCommand(sessionId, "complete_lane_as_success", {
        taskId: task.id,
        summary: "Ready for approval after the worker completed the lane.",
        notes: "Please verify the lane output before approving.",
      });

      let notifications = await waitForCondition(
        () => executeScript<any[]>(sessionId, "return window.__orchestraTestNotifications ?? [];"),
        (entries) => entries.length >= 2,
      );

      expect(notifications[0]?.title).toBe("Orchestra — New message");
      expect(notifications[0]?.body).toContain("Notification Project");
      expect(notifications[0]?.body).toContain("Please review the desktop notification behavior.");
      expect(notifications[1]?.title).toBe("Orchestra — Approval needed");
      expect(notifications[1]?.body).toContain("Desktop notification approval task");
      expect(notifications[1]?.body).toContain("Please verify the lane output before approving.");

      const handoffWorkflow = await invokeCommand<{ id: string }>(sessionId, "create_workflow", {
        input: {
          name: "Notification User Handoff Flow",
          description: "Moves completed role work into a user-owned lane.",
          lanes: [
            {
              id: "lane-handoff-implement",
              key: "implement",
              name: "Implement",
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: role.slug,
              entryPromptTemplate: "Implement the task and hand it to the user.",
              useSeparateWorktree: false,
              requireUserApprovalOnSuccess: false,
              successTransitionType: "lane",
              successTargetLaneId: "lane-handoff-user-review",
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
            {
              id: "lane-handoff-user-review",
              key: "user-review",
              name: "User Review",
              order: 1,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Review the delivered work.",
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
      const handoffTask = await invokeCommand<{ id: string }>(sessionId, "create_task", {
        projectId: project.id,
        input: {
          title: "Desktop notification user handoff task",
          description: "Task used to verify user-owned lane handoff notifications.",
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: handoffWorkflow.id,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
        },
      });

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: handoffTask.id }),
        (loadedTask) => Boolean(loadedTask?.activeLaneAssignment),
      );

      await invokeCommand(sessionId, "complete_lane_as_success", {
        taskId: handoffTask.id,
        summary: "Implementation complete and handed off to the user review lane.",
        notes: null,
      });

      await waitForCondition(
        () => invokeCommand<any>(sessionId, "get_task", { taskId: handoffTask.id }),
        (loadedTask) => loadedTask?.currentLaneId === "lane-handoff-user-review" && loadedTask?.assigneeType === "user",
      );

      notifications = await waitForCondition(
        () => executeScript<any[]>(sessionId, "return window.__orchestraTestNotifications ?? [];"),
        (entries) => entries.length >= 3,
      );

      expect(notifications[2]?.title).toBe("Orchestra — Task assigned to you");
      expect(notifications[2]?.body).toContain("Desktop notification user handoff task");
      expect(notifications[2]?.body).toContain("continue the workflow");
    } finally {
      await deleteWebdriverSession(sessionId);
    }
  }, 180_000);
});
