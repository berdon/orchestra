import { expect, test, type Locator, type Page } from "@playwright/test";

function buildTaskBase(timestamp: string) {
  return {
    projectId: "orchestra",
    description: null,
    type: "task",
    status: "ready",
    priority: "P2",
    workflowId: null,
    currentLaneId: null,
    assigneeType: "role",
    assigneeId: null,
    repositoryId: null,
    repositoryIds: [],
    parentTaskId: null,
    archived: false,
    tags: [],
    unreadCommentCount: 0,
    laneRunCount: 0,
    childCount: 0,
    completedChildCount: 0,
    inProgressChildCount: 0,
    blockedChildCount: 0,
    blockedByCount: 0,
    blockingCount: 0,
    attachmentCount: 0,
    dependencyBlocked: false,
    readyForDispatch: true,
    parent: null,
    lineage: [],
    children: [],
    blockedBy: [],
    blocking: [],
    attachments: [],
    taskRepositories: [],
    fileReferences: [],
    todos: [],
    laneRuns: [],
    laneSummaries: [],
    activeLaneAssignment: null,
    createdAt: timestamp,
    updatedAt: timestamp,
  };
}

async function seedTaskCommentDeletionData(page: Page, task: Record<string, unknown>, timestamp: string) {
  await page.addInitScript(({ task, timestamp }) => {
    window.localStorage.clear();
    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify([task]));
    window.localStorage.setItem("orchestra.mock.task-schedules", "[]");
    window.localStorage.setItem("orchestra.mock.workflows", "[]");
    window.localStorage.setItem(
      "orchestra.mock.projects",
      JSON.stringify([
        {
          id: "orchestra",
          slug: "orchestra",
          name: "Orchestra",
          description: null,
          taskPrefix: "ORC",
          defaultRepositoryId: null,
          repositories: [],
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  }, { task, timestamp });
}

async function openTask(page: Page, title: string) {
  await page.goto("/");

  const tasksButton = page.getByRole("button", { name: "Tasks" });
  if (!(await tasksButton.isVisible().catch(() => false))) {
    await page.getByRole("button", { name: "Open navigation" }).click();
  }

  await tasksButton.click();
  await expect(page.locator('[data-role="task-card"]', { hasText: title })).toBeVisible();
  await page.locator('[data-role="task-card"]', { hasText: title }).click();
  await expect(page.locator('[data-role="task-comments"]')).toBeVisible({ timeout: 10000 });
}

async function openCommentOverflowMenu(page: Page, commentId: string): Promise<Locator> {
  await page.locator(`[data-role="task-comment-overflow-trigger"][data-comment-id="${commentId}"]`).click();
  const menu = page.locator(`[data-role="task-comment-overflow-menu"][data-comment-id="${commentId}"]`);
  await expect(menu).toBeVisible();
  return menu;
}

test.describe("Task comment deletion", () => {
  test("renders overflow actions beside Reply for top-level and nested comments", async ({ page }) => {
    const timestamp = new Date().toISOString();
    await seedTaskCommentDeletionData(page, {
      ...buildTaskBase(timestamp),
      id: "task-comment-overflow-test",
      number: "ORC-CD0",
      title: "Comment overflow test task",
      commentCount: 2,
      comments: [
        {
          id: "comment-parent",
          taskId: "task-comment-overflow-test",
          author: "User",
          originType: "user",
          message: "Parent comment",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: null,
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
        {
          id: "comment-child",
          taskId: "task-comment-overflow-test",
          author: "User",
          originType: "user",
          message: "Nested reply",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: "comment-parent",
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
      ],
    }, timestamp);

    await openTask(page, "Comment overflow test task");

    const topLevelReply = page.locator('[data-role="reply-task-comment"][data-comment-id="comment-parent"]');
    const topLevelOverflow = page.locator('[data-role="task-comment-overflow-trigger"][data-comment-id="comment-parent"]');
    const nestedReply = page.locator('[data-role="reply-task-comment"][data-comment-id="comment-child"]');
    const nestedOverflow = page.locator('[data-role="task-comment-overflow-trigger"][data-comment-id="comment-child"]');

    for (const locator of [topLevelReply, topLevelOverflow, nestedReply, nestedOverflow]) {
      await expect(locator).toBeVisible();
    }

    const topLevelReplyBox = await topLevelReply.boundingBox();
    const topLevelOverflowBox = await topLevelOverflow.boundingBox();
    const nestedReplyBox = await nestedReply.boundingBox();
    const nestedOverflowBox = await nestedOverflow.boundingBox();

    expect(topLevelReplyBox).not.toBeNull();
    expect(topLevelOverflowBox).not.toBeNull();
    expect(nestedReplyBox).not.toBeNull();
    expect(nestedOverflowBox).not.toBeNull();
    expect(topLevelOverflowBox!.x).toBeGreaterThan(topLevelReplyBox!.x);
    expect(nestedOverflowBox!.x).toBeGreaterThan(nestedReplyBox!.x);

    await expect((await openCommentOverflowMenu(page, "comment-parent")).locator('[data-role="comment-delete"]')).toHaveText("Delete");
    await expect((await openCommentOverflowMenu(page, "comment-child")).locator('[data-role="comment-delete"]')).toHaveText("Delete");
  });

  test("keeps comment overflow menus within the mobile viewport", async ({ page }) => {
    await page.setViewportSize({ width: 375, height: 812 });

    const timestamp = new Date().toISOString();
    await seedTaskCommentDeletionData(page, {
      ...buildTaskBase(timestamp),
      id: "task-comment-mobile-overflow-test",
      number: "ORC-CDM1",
      title: "Mobile comment overflow test task",
      commentCount: 2,
      comments: [
        {
          id: "comment-parent-mobile",
          taskId: "task-comment-mobile-overflow-test",
          author: "User",
          originType: "user",
          message: "Parent comment",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: null,
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
        {
          id: "comment-child-mobile",
          taskId: "task-comment-mobile-overflow-test",
          author: "User",
          originType: "user",
          message: "Nested reply",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: "comment-parent-mobile",
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
      ],
    }, timestamp);

    await openTask(page, "Mobile comment overflow test task");

    for (const commentId of ["comment-parent-mobile", "comment-child-mobile"]) {
      const menu = await openCommentOverflowMenu(page, commentId);
      const box = await menu.boundingBox();
      expect(box).not.toBeNull();
      expect(box!.x).toBeGreaterThanOrEqual(0);
      expect(box!.x + box!.width).toBeLessThanOrEqual(375);
    }
  });

  test("shows delete impact modal and cascade-deletes comment with replies", async ({ page }) => {
    const timestamp = new Date().toISOString();
    await seedTaskCommentDeletionData(page, {
      ...buildTaskBase(timestamp),
      id: "task-comment-delete-test",
      number: "ORC-CD1",
      title: "Comment deletion test task",
      commentCount: 3,
      comments: [
        {
          id: "comment-parent",
          taskId: "task-comment-delete-test",
          author: "User",
          originType: "user",
          message: "Parent comment",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: null,
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
        {
          id: "comment-child-1",
          taskId: "task-comment-delete-test",
          author: "User",
          originType: "user",
          message: "Reply 1",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: "comment-parent",
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
        {
          id: "comment-child-2",
          taskId: "task-comment-delete-test",
          author: "User",
          originType: "user",
          message: "Reply 2",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: "comment-parent",
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
      ],
    }, timestamp);

    await openTask(page, "Comment deletion test task");

    await expect(page.locator('[data-role="task-comment-item"]', { hasText: "Parent comment" })).toBeVisible();
    const deleteMenu = await openCommentOverflowMenu(page, "comment-parent");
    await deleteMenu.locator('[data-role="comment-delete"]').click();

    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toBeVisible();
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toContainText("Delete this comment");
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toContainText("Impact");
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toContainText("2 replies");

    await page.click('[data-role="confirm-delete-comment"]');

    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment-item"]', { hasText: "Parent comment" })).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment-reply"]', { hasText: "Reply 1" })).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment-reply"]', { hasText: "Reply 2" })).not.toBeVisible();
  });

  test("cancels comment deletion when cancel is clicked", async ({ page }) => {
    const timestamp = new Date().toISOString();
    await seedTaskCommentDeletionData(page, {
      ...buildTaskBase(timestamp),
      id: "task-comment-cancel-test",
      number: "ORC-CC1",
      title: "Cancel test",
      commentCount: 1,
      comments: [
        {
          id: "comment-cancel",
          taskId: "task-comment-cancel-test",
          author: "User",
          originType: "user",
          message: "Comment to cancel deletion of",
          interruptAgent: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          parentCommentId: null,
          originId: null,
          repositoryId: null,
          relativePath: null,
          lineStart: null,
          lineEnd: null,
          columnStart: null,
          columnEnd: null,
          selectedText: null,
          anchorCommitHash: null,
          anchorHasUncommittedChanges: null,
        },
      ],
    }, timestamp);

    await openTask(page, "Cancel test");

    await expect(page.locator('[data-role="task-comment-item"]', { hasText: "Comment to cancel deletion of" })).toBeVisible();
    const deleteMenu = await openCommentOverflowMenu(page, "comment-cancel");
    await deleteMenu.locator('[data-role="comment-delete"]').click();

    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toBeVisible();
    await page.locator('[data-role="task-comment-delete-confirm"]').locator("button:has-text(\"Cancel\")").click();

    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment-item"]', { hasText: "Comment to cancel deletion of" })).toBeVisible();
  });
});
