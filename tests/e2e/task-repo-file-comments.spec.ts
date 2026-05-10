import { expect, test } from "@playwright/test";

test("task detail supports anchored comments on non-default repo files from the repo files tab", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const defaultFilePath = "/mock/projects/orchestra/repository/docs/design.md";
    const secondaryFilePath = "/mock/projects/orchestra/repository/docs/notes.md";
    const taskId = "task-repo-file-comments";

    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify([
      {
        id: taskId,
        projectId: "orchestra",
        number: "ORC-295",
        title: "Review tracked repo files",
        description: "Seeded task for repo-file comment testing.",
        type: "feature",
        status: "in_progress",
        priority: "P2",
        workflowId: null,
        currentLaneId: null,
        assigneeType: "unassigned",
        assigneeId: null,
        repositoryId: "repo-default-file",
        repositoryIds: ["repo-default-file"],
        parentTaskId: null,
        archived: false,
        commentCount: 0,
        laneRunCount: 0,
        childCount: 0,
        completedChildCount: 0,
        inProgressChildCount: 0,
        blockedChildCount: 0,
        blockedByCount: 0,
        blockingCount: 0,
        attachmentCount: 0,
        dependencyBlocked: false,
        readyForDispatch: false,
        parent: null,
        lineage: [],
        children: [],
        blockedBy: [],
        blocking: [],
        attachments: [],
        taskRepositories: [
          {
            taskId,
            repositoryId: "repo-default-file",
            repositoryName: "Orchestra repository",
            repositorySlug: "orchestra",
            managedRepositoryPath: "/mock/projects/orchestra/repository",
            sourcePath: "/mock/projects/orchestra/repository",
            sourceKind: "local",
            taskWorktreePath: null,
            createdAt: timestamp,
          },
        ],
        fileReferences: [
          {
            id: "task-file-reference-default",
            taskId,
            repositoryId: "repo-default-file",
            repositoryName: "Orchestra repository",
            repositorySlug: "orchestra",
            relativePath: "docs/design.md",
            absolutePath: defaultFilePath,
            exists: true,
            isDefault: true,
            createdAt: timestamp,
          },
          {
            id: "task-file-reference-secondary",
            taskId,
            repositoryId: "repo-default-file",
            repositoryName: "Orchestra repository",
            repositorySlug: "orchestra",
            relativePath: "docs/notes.md",
            absolutePath: secondaryFilePath,
            exists: true,
            isDefault: false,
            createdAt: timestamp,
          },
        ],
        comments: [],
        laneRuns: [],
        laneSummaries: [],
        activeLaneAssignment: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]));
    window.localStorage.setItem(
      "orchestra.mock.file-contents",
      JSON.stringify({
        [defaultFilePath]: [
          "Default repo file",
          "This file stays visible in the summary card.",
        ].join("\n"),
        [secondaryFilePath]: [
          "Secondary repo file",
          "This line should accept repo-tab comments.",
          "Closing line",
        ].join("\n"),
      }),
    );
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Review tracked repo files" }).first().click();
  await expect(page.getByRole("heading", { name: "Review tracked repo files" })).toBeVisible();

  await page.getByRole("tab", { name: "Repo files" }).click();
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toBeVisible();
  await page.locator('[data-role="task-file-references"] select').selectOption("task-file-reference-secondary");

  await expect(page.locator('[data-role="repo-file-code-viewer"]')).toContainText("Secondary repo file");
  await expect(page.locator('[data-role="default-file-code-viewer"]')).toContainText("Default repo file");

  await page.evaluate(() => {
    const openDraft = (window as Window & {
      __orchestraOpenFileCommentDraft?: (detail: unknown) => void;
    }).__orchestraOpenFileCommentDraft;
    if (typeof openDraft !== "function") {
      throw new Error("Comment draft helper was not available.");
    }
    openDraft({
      viewerId: "repo-file",
      anchor: {
        repositoryId: "repo-default-file",
        relativePath: "docs/notes.md",
        absolutePath: "/mock/projects/orchestra/repository/docs/notes.md",
        lineStart: 2,
        lineEnd: 2,
        columnStart: null,
        columnEnd: null,
        selectedText: null,
      },
      top: 88,
      left: 220,
    });
  });

  await expect(page.locator('[data-role="default-file-comment-popover"]')).toHaveCount(0);
  await expect(page.locator('[data-role="repo-file-comment-popover"]')).toBeVisible();
  await page.locator('[data-role="repo-file-comment-popover"]').getByRole("textbox", { name: "Comment" }).fill("Please expand the secondary notes.");
  await page.locator('[data-role="add-repo-file-comment"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("docs/notes.md · line 2");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Please expand the secondary notes.");

  await page.locator('[data-role="repo-file-line-comment-button"][data-line-number="2"]').click();
  await expect(page.locator('[data-role="repo-file-thread-popover"]')).toContainText("Please expand the secondary notes.");
});
