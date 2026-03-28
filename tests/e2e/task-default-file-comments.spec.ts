import { expect, test } from "@playwright/test";

test("task detail supports quick comments, line comments, replies, and viewer controls on the default file preview", async ({ page }) => {
  await page.goto("/");
  await page.evaluate(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const filePath = "/mock/projects/orchestra/repository/docs/design.md";
    const taskId = "task-default-file-comments";

    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify([
      {
        id: taskId,
        projectId: "orchestra",
        number: "ORC-200",
        title: "Implement task foundation shell",
        description: "Seeded task for default file comment testing.",
        type: "feature",
        status: "in_progress",
        priority: "P1",
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
            absolutePath: filePath,
            exists: true,
            isDefault: true,
            createdAt: timestamp,
          },
        ],
        comments: [],
        laneRuns: [],
        activeLaneAssignment: null,
        createdAt: timestamp,
        updatedAt: timestamp,
      },
    ]));
    window.localStorage.setItem(
      "orchestra.mock.file-contents",
      JSON.stringify({
        [filePath]: [
          "Alpha line",
          "Beta selected text",
          "Gamma line",
        ].join("\n"),
      }),
    );
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.evaluate(() => {
    const tasksButton = Array.from(document.querySelectorAll('button')).find((element) =>
      (element.textContent ?? '').trim() === 'Tasks',
    ) as HTMLButtonElement | undefined;
    tasksButton?.click();
  });
  await page.evaluate(() => {
    const match = Array.from(document.querySelectorAll('[data-role="task-card"]')).find((element) =>
      (element.textContent ?? '').includes('Implement task foundation shell'),
    ) as HTMLButtonElement | undefined;
    match?.click();
  });
  await expect(page.getByRole("heading", { name: "Implement task foundation shell" })).toBeVisible();

  await page.getByRole("textbox", { name: "Quick comment" }).fill("General note under the default file. See @docs/design.md");
  await page.locator('[data-role="add-default-file-quick-comment"]').click();

  await expect(page.locator('[data-role="default-file-comment-summary"]')).toContainText("General note under the default file. See @docs/design.md");
  await expect(page.locator('[data-role="default-file-code-viewer"]')).toContainText("Gamma line");
  await page.locator('[data-role="task-comment-file-mention-link"]').first().click();
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toBeVisible();

  await page.evaluate(() => {
    const openDraft = (window as Window & { __orchestraOpenFileCommentDraft?: (detail: unknown) => void }).__orchestraOpenFileCommentDraft;
    if (typeof openDraft !== "function") {
      throw new Error("Comment draft helper was not available.");
    }
    openDraft({
      anchor: {
        repositoryId: "repo-default-file",
        relativePath: "docs/design.md",
        absolutePath: "/mock/projects/orchestra/repository/docs/design.md",
        lineStart: 3,
        lineEnd: 3,
        columnStart: null,
        columnEnd: null,
        selectedText: null,
      },
      top: 88,
      left: 220,
    });
  });
  await expect(page.locator('[data-role="default-file-comment-popover"]')).toBeVisible();
  await page.locator('[data-role="default-file-comment-popover"]').getByRole("textbox", { name: "Comment" }).fill("Please revisit this line.");
  await page.locator('[data-role="add-default-file-comment"]').click();

  await expect(page.locator('[data-role="default-file-comment-summary"]')).toContainText("docs/design.md · line 3");
  await expect(page.locator('[data-role="default-file-comment-summary"]')).toContainText("Please revisit this line.");
  await page.locator('[data-role="default-file-line-comment-button"][data-line-number="3"]').click({ force: true });
  await expect(page.locator('[data-role="default-file-thread-popover"]')).toContainText("Please revisit this line.");
  await page.locator('[data-role="default-file-open-reply"]').click();
  await page.getByRole("textbox", { name: "Reply" }).fill("Acknowledged on line 3.");
  await page.locator('[data-role="add-default-file-reply"]').click();

  await expect(page.locator('[data-role="default-file-viewer-toggle"]')).toHaveText("Minimize");
  await page.locator('[data-role="default-file-viewer-toggle"]').click();
  await expect(page.locator('[data-role="default-file-viewer-toggle"]')).toHaveText("Expand");
  await page.mouse.click(5, 5);
  await expect(page.locator('[data-role="default-file-thread-popover"]')).toHaveCount(0);
  await page.locator('[data-role="default-file-viewer-toggle"]').click();
  await expect(page.locator('[data-role="default-file-viewer-toggle"]')).toHaveText("Minimize");

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Default file");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("docs/design.md · line 3");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Acknowledged on line 3.");
});
