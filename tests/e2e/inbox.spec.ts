import { expect, test } from "@playwright/test";

test("Inbox shows user messages, attention tasks, and supports read/archive filters", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.mailbox",
      JSON.stringify([
        {
          deliveryId: "delivery-user-1",
          messageId: "message-user-1",
          projectId: "orchestra",
          taskId: null,
          taskNumber: null,
          taskTitle: null,
          senderType: "agent",
          senderId: "data",
          senderLabel: "Data",
          recipientType: "user",
          recipientId: "desktop-user",
          recipientLabel: "User",
          assignmentId: null,
          body: "Please review the latest automation output.",
          priority: "interrupt",
          readAt: null,
          readSessionId: null,
          archivedAt: null,
          lastNotifiedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
        {
          deliveryId: "delivery-user-2",
          messageId: "message-user-2",
          projectId: "orchestra",
          taskId: null,
          taskNumber: null,
          taskTitle: null,
          senderType: "agent",
          senderId: "reviewer",
          senderLabel: "Reviewer",
          recipientType: "user",
          recipientId: "desktop-user",
          recipientLabel: "User",
          assignmentId: null,
          body: "Already handled yesterday.",
          priority: "normal",
          readAt: new Date().toISOString(),
          readSessionId: "desktop-user",
          archivedAt: null,
          lastNotifiedAt: new Date().toISOString(),
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ]),
    );
  });

  await page.goto("/");
  await expect(page.getByText("Environment")).toHaveCount(0);
  await expect(page.getByText("Backend")).toHaveCount(0);
  await page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    const target = tasks.find((task: { title: string }) => task.title === "Implement task foundation shell");
    if (target) {
      target.status = "in_review";
      target.updatedAt = new Date().toISOString();
      window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify(tasks));
      window.dispatchEvent(new CustomEvent("orchestra:task-change", { detail: { taskIds: [target.id], reason: "test.seed.inbox-review" } }));
    }
  });

  await page.getByRole("button", { name: "Inbox" }).click();
  await expect(page.locator('[data-role="inbox-unread-count"]')).toContainText("1 unread");
  await expect(page.locator('[data-role="inbox-compose-panel"]')).toHaveCount(0);
  await page.locator('[data-role="open-inbox-compose"]').click();
  await expect(page.locator('[data-role="inbox-compose-panel"]')).toBeVisible();
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Please review the latest automation output.");
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Already handled yesterday.");
  await expect(page.locator('[data-role="inbox-attention-tasks"]')).toContainText("Open task");
  await expect(page.locator('[data-role="inbox-attention-tasks"]')).toContainText("ORC-");

  await page.locator('[data-role="inbox-filter-unread"]').click();
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Please review the latest automation output.");
  await expect(page.locator('[data-role="user-inbox-messages"]')).not.toContainText("Already handled yesterday.");

  await page.locator('[data-role="mark-inbox-read-delivery-user-1"]').click();
  await expect(page.locator('[data-role="inbox-unread-count"]')).toContainText("0 unread");

  await page.locator('[data-role="inbox-filter-read"]').click();
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Please review the latest automation output.");
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Already handled yesterday.");

  await page.locator('[data-role="inbox-filter-all"]').click();
  await page.locator('[data-role="archive-inbox-message-delivery-user-1"]').click();
  await expect(page.locator('[data-role="user-inbox-messages"]')).not.toContainText("Please review the latest automation output.");
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Already handled yesterday.");

  await page.locator('[data-role="inbox-filter-archived"]').click();
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Please review the latest automation output.");
  await expect(page.locator('[data-role="user-inbox-messages"]')).toContainText("Archived");

  const storedMailbox = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.mailbox") ?? "[]"));
  const archivedMessage = storedMailbox.find((message: { deliveryId: string }) => message.deliveryId === "delivery-user-1");
  expect(archivedMessage?.archivedAt).toBeTruthy();
});

test("task runtime can send mail to the active assignment mailbox through the UI", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-agent-mail",
          slug: "agent-mail-flow",
          name: "Agent Mail Flow",
          description: "Single agent-owned lane.",
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lanes: [
            {
              id: "lane-agent-mail",
              key: "agent-mail",
              name: "Agent Mail",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: "data",
              entryPromptTemplate: "Do the work and check your mail.",
              requireUserApprovalOnSuccess: false,
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Runtime mailbox task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent-mail");
  await page.locator('[data-role="publish-task"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("agent");

  await page.locator('[data-role="task-runtime-mail-body"]').fill("Please pause and respond with a summary after checking mail.");
  await page.locator('[data-role="task-runtime-mail-interrupt"]').check();
  await page.locator('[data-role="task-runtime-send-mail"]').click();

  await expect(page.locator('[data-role="task-mail-history"]')).toContainText("Please pause and respond with a summary after checking mail.");
  await expect(page.locator('[data-role="task-mail-history"]')).toContainText("Unread");

  const storedMailbox = await page.evaluate(() => JSON.parse(window.localStorage.getItem("orchestra.mock.mailbox") ?? "[]"));
  expect(storedMailbox).toHaveLength(1);
  expect(storedMailbox[0]?.recipientType).toBe("assignment");
  expect(storedMailbox[0]?.priority).toBe("interrupt");
  expect(storedMailbox[0]?.taskTitle).toBe("Runtime mailbox task");
});
