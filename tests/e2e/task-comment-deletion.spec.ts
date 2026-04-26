import { expect, test } from "@playwright/test";

/**
 * Playwright tests for task comment deletion with impact inspection and cascade delete.
 * Tests the full flow: get delete impact → confirmation modal → cascade delete.
 */

test.describe("Task comment deletion", () => {
  test("shows delete impact modal and cascade-deletes comment with replies", async ({
    page,
  }) => {
    const timestamp = new Date().toISOString();

    await page.addInitScript(() => {
      window.localStorage.clear();
      window.localStorage.setItem(
        "orchestra.mock.tasks",
        JSON.stringify([
          {
            id: "task-comment-delete-test",
            number: "ORC-CD1",
            title: "Comment deletion test task",
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
            commentCount: 3,
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
            todos: [],
            laneRuns: [],
            activeLaneAssignment: null,
          },
        ]),
      );
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
    });

    await page.goto("/tasks");
    await expect(page.locator('[data-role="task-card"]', { hasText: "Comment deletion test task" })).toBeVisible();
    await page.click('[data-role="task-card"]', { hasText: "Comment deletion test task" });

    // Wait for detail to load
    await expect(page.locator('[data-role="task-detail"]')).toBeVisible({ timeout: 10000 });

    // Find and click delete comment button for the parent comment
    const parentComment = page.locator('[data-role="task-comment"]', { hasText: "Parent comment" });
    await expect(parentComment).toBeVisible();

    // Click the delete action on the comment
    const deleteButton = parentComment.locator('[data-role="comment-delete"]');
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Confirmation modal should appear
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toBeVisible();

    // Impact messaging should be visible
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toContainText("Delete this comment");
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toContainText("Impact");
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toContainText("2 replies");

    // Click confirm delete
    await page.click('[data-role="confirm-delete-comment"]');

    // Modal should close
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).not.toBeVisible();

    // Parent comment and replies should be gone
    await expect(page.locator('[data-role="task-comment"]', { hasText: "Parent comment" })).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment"]', { hasText: "Reply 1" })).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment"]', { hasText: "Reply 2" })).not.toBeVisible();
  });

  test("cancels comment deletion when cancel is clicked", async ({ page }) => {
    const timestamp = new Date().toISOString();

    await page.addInitScript(() => {
      window.localStorage.clear();
      window.localStorage.setItem(
        "orchestra.mock.tasks",
        JSON.stringify([
          {
            id: "task-comment-cancel-test",
            number: "ORC-CC1",
            title: "Cancel test",
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
            commentCount: 1,
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
            todos: [],
            laneRuns: [],
            activeLaneAssignment: null,
          },
        ]),
      );
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
    });

    await page.goto("/tasks");
    await expect(page.locator('[data-role="task-card"]', { hasText: "Cancel test" })).toBeVisible();
    await page.click('[data-role="task-card"]', { hasText: "Cancel test" });
    await expect(page.locator('[data-role="task-detail"]')).toBeVisible({ timeout: 10000 });

    const comment = page.locator('[data-role="task-comment"]', { hasText: "Comment to cancel deletion of" });
    await expect(comment).toBeVisible();

    const deleteButton = comment.locator('[data-role="comment-delete"]');
    await expect(deleteButton).toBeVisible();
    await deleteButton.click();

    // Modal should be visible
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).toBeVisible();

    // Click cancel
    await page.locator('[data-role="task-comment-delete-confirm"]').locator("button:has-text(\"Cancel\")").click();

    // Modal should close, comment should remain
    await expect(page.locator('[data-role="task-comment-delete-confirm"]')).not.toBeVisible();
    await expect(page.locator('[data-role="task-comment"]', { hasText: "Comment to cancel deletion of" })).toBeVisible();
  });
});
