import { expect, test } from "@playwright/test";

test("task detail keeps default-file line comments and viewer controls while selection comments stay disabled", async ({ page }) => {
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
  laneSummaries: [],
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
          "This is a deliberately long file preview line that should exceed the default viewer width and prove that the wrap toggle behaves correctly when enabled and disabled in the task file viewer.",
          ...Array.from({ length: 40 }, (_, index) => `Extra filler line ${index + 5}`),
        ].join("\n"),
      }),
    );
  });
  await page.goto("/", { waitUntil: "domcontentloaded" });

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();
  await expect(page.getByRole("heading", { name: "Implement task foundation shell" })).toBeVisible();

  await page.locator('[data-role="task-comment-message"]').fill("General note under the default file. See $docs/design.md");
  await page.locator('[data-role="add-task-comment"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("General note under the default file. See docs/design.md");
  await expect(page.locator('[data-role="default-file-code-viewer"]')).toContainText("Gamma line");
  await expect(page.locator('.file-content-viewer__header').first()).not.toContainText("Resizable");
  const wrapToggle = page.locator('[data-role="default-file-wrap-toggle"]');
  const scrollBottom = page.locator('[data-role="default-file-scroll-bottom"]');
  const fileViewer = page.locator('[data-role="default-file-code-viewer"]');
  await expect(wrapToggle).toHaveAttribute("data-wrap-mode", "wrap");
  await expect(fileViewer).toHaveAttribute("data-wrap-mode", "wrap");
  const wrappedMetrics = await page.evaluate(() => {
    const viewer = document.querySelector('[data-role="default-file-code-viewer"]') as HTMLElement | null;
    const line = document.querySelector('[data-line-number="4"] [data-file-line-content]') as HTMLElement | null;
    return {
      viewerClientWidth: viewer?.clientWidth ?? 0,
      lineScrollWidth: line?.scrollWidth ?? 0,
      whiteSpace: line ? getComputedStyle(line).whiteSpace : null,
    };
  });
  expect(wrappedMetrics.whiteSpace).toBe("pre-wrap");
  expect(wrappedMetrics.lineScrollWidth).toBeLessThanOrEqual(wrappedMetrics.viewerClientWidth + 12);
  await wrapToggle.click();
  await expect(wrapToggle).toHaveAttribute("data-wrap-mode", "nowrap");
  await expect(fileViewer).toHaveAttribute("data-wrap-mode", "nowrap");
  const nowrapMetrics = await page.evaluate(() => {
    const viewer = document.querySelector('[data-role="default-file-code-viewer"]') as HTMLElement | null;
    const line = document.querySelector('[data-line-number="4"] [data-file-line-content]') as HTMLElement | null;
    return {
      viewerClientWidth: viewer?.clientWidth ?? 0,
      lineScrollWidth: line?.scrollWidth ?? 0,
      whiteSpace: line ? getComputedStyle(line).whiteSpace : null,
    };
  });
  expect(nowrapMetrics.whiteSpace).toBe("pre");
  expect(nowrapMetrics.lineScrollWidth).toBeGreaterThan(nowrapMetrics.viewerClientWidth + 20);
  await wrapToggle.click();
  await expect(wrapToggle).toHaveAttribute("data-wrap-mode", "wrap");
  await scrollBottom.click();
  await expect.poll(async () => page.evaluate(() => {
    const viewer = document.querySelector('[data-role="default-file-code-viewer"]') as HTMLElement | null;
    if (!viewer) {
      return null;
    }
    return viewer.scrollHeight - viewer.clientHeight - viewer.scrollTop;
  })).toBeLessThanOrEqual(4);
  await page.locator('[data-role="task-comment-mention-link"]').first().click();
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toBeVisible();

  await scrollBottom.click();
  const scrollTopBeforeLineComment = await page.evaluate(() => {
    const viewer = document.querySelector('[data-role="default-file-code-viewer"]') as HTMLElement | null;
    if (!viewer) {
      throw new Error("Default file viewer was not available.");
    }
    return viewer.scrollTop;
  });
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
  await expect(page.locator('[data-role="default-file-comment-message"]')).toBeFocused();
  await page.locator('[data-role="default-file-comment-popover"]').getByRole("textbox", { name: "Comment" }).fill("Please revisit this line.");
  await page.locator('[data-role="add-default-file-comment"]').click();
  await expect(page.locator('[data-role="default-file-comment-popover"]')).toHaveCount(0);
  await expect.poll(async () => page.evaluate(() => {
    const viewer = document.querySelector('[data-role="default-file-code-viewer"]') as HTMLElement | null;
    return viewer?.scrollTop ?? null;
  })).toBeGreaterThan(scrollTopBeforeLineComment - 24);

  await expect(page.locator('[data-role="task-comments"]')).toContainText("docs/design.md · line 3");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Please revisit this line.");
  await page.evaluate(() => {
    const viewer = document.querySelector('[data-role="default-file-code-viewer"]') as HTMLElement | null;
    if (viewer) {
      viewer.scrollTop = 0;
    }
  });
  await page.evaluate(() => {
    const button = document.querySelector('[data-role="default-file-line-comment-button"][data-line-number="4"]') as HTMLButtonElement | null;
    if (!button) {
      throw new Error("Line 4 comment button was not available.");
    }
    button.click();
  });
  await expect(page.locator('[data-role="default-file-comment-popover"]')).toContainText("Line 4");
  await expect(page.locator('[data-role="default-file-comment-message"]')).toBeFocused();
  await page.evaluate(() => {
    const button = document.querySelector('[data-role="default-file-line-comment-button"][data-line-number="5"]') as HTMLButtonElement | null;
    if (!button) {
      throw new Error("Line 5 comment button was not available.");
    }
    button.click();
  });
  await expect(page.locator('[data-role="default-file-comment-popover"]')).toContainText("Line 5");
  await expect(page.locator('[data-role="default-file-comment-message"]')).toBeFocused();
  await page.locator('[data-role="cancel-default-file-comment"]').click();
  await expect(page.locator('[data-role="default-file-comment-popover"]')).toHaveCount(0);
  await page.evaluate(() => {
    const button = document.querySelector('[data-role="default-file-line-comment-button"][data-line-number="3"]') as HTMLButtonElement | null;
    if (!button) {
      throw new Error("Line 3 comment button was not available.");
    }
    button.click();
  });
  await expect(page.locator('[data-role="default-file-thread-popover"]')).toContainText("Please revisit this line.");
  await page.locator('[data-role="default-file-open-reply"]').click();
  await page.getByRole("textbox", { name: "Reply" }).fill("Acknowledged on line 3.");
  await page.locator('[data-role="add-default-file-reply"]').click();
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Please revisit this line.");

  const selectionState = await page.evaluate(() => {
    const lineContent = document.querySelector('[data-file-line-row][data-line-number="2"] [data-file-line-content]') as HTMLElement | null;
    if (!lineContent) {
      throw new Error("Viewer line content was not available.");
    }

    const textNodes: Text[] = [];
    const walker = document.createTreeWalker(lineContent, NodeFilter.SHOW_TEXT);
    let current = walker.nextNode();
    while (current) {
      if (current.textContent && current.textContent.length > 0) {
        textNodes.push(current as Text);
      }
      current = walker.nextNode();
    }

    const selection = window.getSelection();
    if (!selection) {
      throw new Error("Selection API was not available.");
    }

    const locate = (targetOffset: number) => {
      let traversed = 0;
      for (const node of textNodes) {
        const value = node.textContent ?? "";
        const nextTraversed = traversed + value.length;
        if (targetOffset <= nextTraversed) {
          return { node, offset: Math.max(0, targetOffset - traversed) };
        }
        traversed = nextTraversed;
      }
      return null;
    };

    const start = locate(5);
    const end = locate(18);
    if (!start || !end) {
      throw new Error("Unable to resolve selection offsets inside line 2.");
    }

    const range = document.createRange();
    range.setStart(start.node, start.offset);
    range.setEnd(end.node, end.offset);
    selection.removeAllRanges();
    selection.addRange(range);
    return {
      selectedText: selection.toString(),
      buttonCount: document.querySelectorAll('[data-role="default-file-selection-comment-button"]').length,
      popoverCount: document.querySelectorAll('[data-role="default-file-comment-popover"]').length,
    };
  });
  expect(selectionState.selectedText).toBe("selected text");
  expect(selectionState.buttonCount).toBe(0);
  expect(selectionState.popoverCount).toBe(0);
  await expect(page.locator('[data-role="default-file-selection-comment-button"]')).toHaveCount(0);
  await expect(page.locator('[data-role="default-file-comment-popover"]')).toHaveCount(0);

  await expect(page.locator('[data-role="default-file-viewer-toggle"]')).toHaveText("Minimize");
  await page.locator('[data-role="default-file-viewer-toggle"]').click();
  await expect(page.locator('[data-role="default-file-viewer-toggle"]')).toHaveText("Expand");
  await page.mouse.click(5, 5);
  await expect(page.locator('[data-role="default-file-thread-popover"]')).toHaveCount(0);
  await page.locator('[data-role="default-file-viewer-toggle"]').click();
  await expect(page.locator('[data-role="default-file-viewer-toggle"]')).toHaveText("Minimize");

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Default file");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("docs/design.md · line 3");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Acknowledged on line 3.");
});
