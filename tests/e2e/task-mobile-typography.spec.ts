import { expect, test, type Page } from "@playwright/test";

async function seedTaskDetailTypographyFixture(page: Page) {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    const filePath = "/mock/projects/orchestra/repository/docs/design.md";
    const taskId = "task-mobile-typography";
    const buildComment = (
      id: string,
      parentCommentId: string | null,
      author: string,
      message: string,
      offsetMs: number,
      anchor?: { relativePath: string; lineStart: number; lineEnd?: number },
    ) => ({
      id,
      taskId,
      parentCommentId,
      author,
      message,
      interruptAgent: false,
      repositoryId: anchor ? "repo-default-file" : null,
      relativePath: anchor?.relativePath ?? null,
      lineStart: anchor?.lineStart ?? null,
      lineEnd: anchor?.lineEnd ?? anchor?.lineStart ?? null,
      columnStart: null,
      columnEnd: null,
      selectedText: null,
      anchorCommitHash: null,
      anchorHasUncommittedChanges: null,
      createdAt: new Date(Date.parse(timestamp) + offsetMs).toISOString(),
      updatedAt: new Date(Date.parse(timestamp) + offsetMs).toISOString(),
    });

    const comments = [
      buildComment(
        "comment-general-parent",
        null,
        "Reviewer",
        "Overview summary comment with enough copy to stay multi-line on a mobile viewport and expose any unexpected text inflation.",
        1_000,
      ),
      buildComment(
        "comment-general-reply",
        "comment-general-parent",
        "Worker",
        "Reply body that should keep the same paragraph sizing when the full comments panel is opened later.",
        2_000,
      ),
      buildComment(
        "comment-file-parent",
        null,
        "Architect",
        "Anchored file thread body for the default file preview popover on line three.",
        3_000,
        { relativePath: "docs/design.md", lineStart: 3 },
      ),
      buildComment(
        "comment-file-reply",
        "comment-file-parent",
        "Developer",
        "Anchored file reply body that should match the same font sizing inside the thread popover.",
        4_000,
        { relativePath: "docs/design.md", lineStart: 3 },
      ),
    ];

    window.localStorage.setItem("orchestra.mock.tasks", JSON.stringify([
      {
        id: taskId,
        projectId: "orchestra",
        number: "ORC-180",
        title: "Mobile typography stability task",
        description: [
          "This task description should keep the same paragraph sizing across the mobile task detail surfaces.",
          "A second paragraph keeps the content narrow enough to trigger mobile text autosizing regressions when they exist.",
        ].join("\n\n"),
        type: "bug",
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
        commentCount: comments.length,
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
        comments,
        todos: [],
        laneRuns: [],
  laneSummaries: [],
        activeLaneAssignment: null,
        createdAt: timestamp,
        updatedAt: new Date(Date.parse(timestamp) + 5_000).toISOString(),
      },
    ]));

    window.localStorage.setItem(
      "orchestra.mock.file-contents",
      JSON.stringify({
        [filePath]: [
          "Alpha line",
          "Beta line with enough content to wrap on mobile and stay readable.",
          "Gamma line for the anchored thread popover.",
          "Delta line keeps the file preview visible under the default card.",
        ].join("\n"),
      }),
    );
  });
}

async function openTaskDetail(page: Page, mobile: boolean) {
  await page.goto("/");
  if (mobile) {
    await page.locator('[data-role="toggle-mobile-navigation"]').click();
  }
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Mobile typography stability task" }).first().click();
  await expect(page.locator('[data-role="task-detail-panel"]')).toBeVisible();
}

async function readFontSize(page: Page, selector: string) {
  return page.locator(selector).first().evaluate((element) => Number.parseFloat(getComputedStyle(element).fontSize));
}

async function expectTypographyRootRule(page: Page) {
  const hasTextSizeAdjustRule = await page.evaluate(() => Array.from(document.styleSheets).some((sheet) => {
    try {
      return Array.from(sheet.cssRules).some((rule) => {
        if (!(rule instanceof CSSStyleRule) || rule.selectorText !== "html") {
          return false;
        }
        return rule.style.getPropertyValue("text-size-adjust") === "100%"
          && rule.style.getPropertyValue("-webkit-text-size-adjust") === "100%";
      });
    } catch {
      return false;
    }
  }));

  expect(hasTextSizeAdjustRule).toBe(true);
}

test("mobile task detail keeps typography consistent across summary cards, comments, and file threads", async ({ page }) => {
  await seedTaskDetailTypographyFixture(page);
  await page.setViewportSize({ width: 390, height: 844 });
  await openTaskDetail(page, true);
  await expectTypographyRootRule(page);

  const descriptionFontSize = await readFontSize(page, '[data-role="task-description-markdown"] p');
  const detailCommentFontSize = await readFontSize(page, '[data-role="task-detail-summary-comments"] [data-role="task-comment-item"] [data-role="task-comment-markdown"] p');
  const detailReplyFontSize = await readFontSize(page, '[data-role="task-detail-summary-comments"] [data-role="task-comment-reply"] [data-role="task-comment-markdown"] p');

  await page.locator('[data-role="default-file-line-comment-button"][data-line-number="3"]').click();
  await expect(page.locator('[data-role="default-file-thread-popover"]')).toBeVisible();
  const fileThreadFontSize = await readFontSize(page, '[data-role="default-file-thread-popover"] .file-content-viewer__thread-card [data-role="task-comment-markdown"] p');
  const fileThreadReplyFontSize = await readFontSize(page, '[data-role="default-file-thread-popover"] .file-content-viewer__thread-reply [data-role="task-comment-markdown"] p');

  for (const value of [detailCommentFontSize, detailReplyFontSize, fileThreadFontSize, fileThreadReplyFontSize]) {
    expect(value).toBeCloseTo(descriptionFontSize, 3);
  }
});

test("desktop task detail keeps the same body font sizing after the global mobile typography fix", async ({ page }) => {
  await seedTaskDetailTypographyFixture(page);
  await page.setViewportSize({ width: 1280, height: 900 });
  await openTaskDetail(page, false);
  await expectTypographyRootRule(page);

  await expect(page.getByRole("tablist", { name: "Task detail panels" })).toBeVisible();
  await expect(page.locator('[data-role="task-detail-section-select-mobile"]')).toBeHidden();

  const descriptionFontSize = await readFontSize(page, '[data-role="task-description-markdown"] p');
  const detailCommentFontSize = await readFontSize(page, '[data-role="task-detail-summary-comments"] [data-role="task-comment-item"] [data-role="task-comment-markdown"] p');
  const detailReplyFontSize = await readFontSize(page, '[data-role="task-detail-summary-comments"] [data-role="task-comment-reply"] [data-role="task-comment-markdown"] p');

  expect(detailCommentFontSize).toBeCloseTo(descriptionFontSize, 3);
  expect(detailReplyFontSize).toBeCloseTo(descriptionFontSize, 3);
});
