import { expect, test, type Page } from "@playwright/test";

async function installNotificationStub(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.clear();

    class MockNotification {
      static permission = "granted";
      static requestPermission = async () => "granted" as const;
      onclick: (() => void) | null = null;

      constructor(_title: string, _options?: NotificationOptions) {}
    }

    Object.defineProperty(window, "Notification", {
      configurable: true,
      writable: true,
      value: MockNotification,
    });
  });
}

test("sends a system notification when the user receives a new inbox message", async ({ page }) => {
  await installNotificationStub(page);
  await page.goto("/");

  await page.evaluate(() => {
    const now = new Date().toISOString();
    const mailbox = JSON.parse(window.localStorage.getItem("orchestra.mock.mailbox") ?? "[]");
    mailbox.unshift({
      deliveryId: "delivery-system-notify",
      messageId: "message-system-notify",
      projectId: "orchestra",
      taskId: "task-1",
      taskNumber: "ORC-1",
      taskTitle: "Implement task foundation shell",
      senderType: "agent",
      senderId: "reviewer",
      senderLabel: "Reviewer",
      recipientType: "user",
      recipientId: "desktop-user",
      recipientLabel: "User",
      assignmentId: null,
      body: "Please review the latest runtime output before approving the lane.",
      priority: "interrupt",
      readAt: null,
      readSessionId: null,
      archivedAt: null,
      lastNotifiedAt: null,
      createdAt: now,
      updatedAt: now,
    });
    window.localStorage.setItem("orchestra.mock.mailbox", JSON.stringify(mailbox));
    window.dispatchEvent(new CustomEvent("orchestra:inbox-change", {
      detail: { deliveryIds: ["delivery-system-notify"], reason: "mailbox.sent" },
    }));
  });

  await expect.poll(async () => page.evaluate(() => window.__orchestraTestNotifications?.length ?? 0)).toBe(1);
  const notifications = await page.evaluate(() => window.__orchestraTestNotifications ?? []);
  expect(notifications[0]?.title).toBe("Orchestra — New message");
  expect(notifications[0]?.body).toContain("Reviewer");
  expect(notifications[0]?.body).toContain("ORC-1");
  expect(notifications[0]?.body).toContain("Please review the latest runtime output");
});

test("sends a system notification when a task starts awaiting user approval", async ({ page }) => {
  await installNotificationStub(page);
  await page.goto("/");

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Implement task foundation shell");
    if (!target) {
      throw new Error("Expected default mock task to exist");
    }

    const updatedAt = new Date().toISOString();
    target.status = "in_review";
    target.assigneeType = "user";
    target.assigneeId = null;
    target.activeLaneAssignment = {
      id: `assignment-${target.id}`,
      taskId: target.id,
      workflowId: target.workflowId ?? "workflow-default",
      laneId: target.currentLaneId ?? "lane-default",
      workerType: "agent",
      workerId: "data",
      status: "awaiting_user_approval",
      sessionId: "session-awaiting-approval",
      runtimeCwd: null,
      roleQueueEntryId: null,
      roleInstanceId: null,
      prompt: null,
      pendingOutcome: "success",
      completionNotes: "Please verify the lane output before approving.",
      whipCount: 0,
      lastWhipAt: null,
      startedAt: updatedAt,
      completedAt: null,
      createdAt: updatedAt,
      updatedAt,
    };
    target.updatedAt = updatedAt;
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: { taskIds: [target.id], reason: "task.transition.awaiting_user_approval" },
    }));
  });

  await expect.poll(async () => page.evaluate(() => window.__orchestraTestNotifications?.length ?? 0)).toBe(1);
  const notifications = await page.evaluate(() => window.__orchestraTestNotifications ?? []);
  expect(notifications[0]?.title).toBe("Orchestra — Approval needed");
  expect(notifications[0]?.body).toContain("Implement task foundation shell");
  expect(notifications[0]?.body).toContain("Please verify the lane output before approving.");
});
