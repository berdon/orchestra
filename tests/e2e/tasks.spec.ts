import { expect, test } from "@playwright/test";

const TINY_PNG_BASE64 = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a5ioAAAAASUVORK5CYII=";

test("tasks overview creates a draft task and opens dedicated detail/create pages", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();

  await expect(page.getByRole("heading", { name: "New task" })).toBeVisible();
  await expect(page.locator('[data-role="task-status"]')).toHaveCount(0);
  await page.locator('[data-role="task-title"]').fill("Draft board task");
  await page.locator('[data-role="save-task"]').click();

  await expect(page.getByRole("heading", { name: "Draft board task" })).toBeVisible();
  await expect(page.locator('[data-role="publish-task"]')).toBeVisible();
  await expect(page.locator('[data-role="task-overview-description"]')).toContainText("No description provided.");
  await expect(page.getByRole("button", { name: "Back to tasks" })).toHaveCount(0);
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft board task");

  await page.locator('[data-role="task-card"]').filter({ hasText: "Draft board task" }).first().click();
  await expect(page.getByRole("heading", { name: "Draft board task" })).toBeVisible();
  await expect(page.locator('[data-role="task-overview-description"]')).toContainText("No description provided.");
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Draft board task");
});

test("tasks overview hides empty inbox, hides done lanes, and supports done filtering in card and table views", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-simple",
          slug: "simple",
          name: "Simple Flow",
          description: "Single implementation lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Build it.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-active",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Visible lane task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-simple",
          currentLaneId: "lane-implement",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
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
          readyForDispatch: true,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-done",
          projectId: "orchestra",
          number: "ORC-2",
          title: "Completed task",
          description: null,
          type: "task",
          status: "completed",
          priority: "P2",
          workflowId: "workflow-simple",
          currentLaneId: null,
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          laneRunCount: 1,
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
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();

  await expect(page.locator('[data-role="task-attention-section"]')).toHaveCount(0);
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Simple Flow");
  await expect(page.locator('[data-role="workflow-task-section"]')).not.toContainText("Done");
  await expect(page.locator('[data-role="task-filter-done"]')).toBeVisible();

  await page.locator('[data-role="task-filter-done"]').click();
  await expect(page.locator('[data-role="workflow-done-grid"]')).toContainText("Completed task");

  await page.locator('[data-role="task-view-table"]').click();
  await expect(page.locator('[data-role="task-table"]')).toContainText("Completed task");
  await expect(page.locator('[data-role="task-table-row"]')).toContainText("Simple Flow");
  await expect(page.locator('[data-role="task-table-row"]')).toContainText("0");
  await expect(page.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect.poll(async () =>
    page.evaluate(() => window.localStorage.getItem("orchestra.preferences.task-board-view-mode"))
  ).toBe("table");

  const secondPage = await page.context().newPage();
  await secondPage.goto("/");
  await secondPage.getByRole("button", { name: "Tasks" }).click();
  await secondPage.locator('[data-role="task-filter-done"]').click();
  await expect(secondPage.locator('[data-role="task-view-table"]')).toHaveAttribute("aria-pressed", "true");
  await expect(secondPage.locator('[data-role="task-table"]')).toContainText("Completed task");
  await secondPage.close();
});

test("workflow lanes stay within a max height and scroll long task lists", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-scroll",
          slug: "scroll",
          name: "Scrollable Flow",
          description: "Single lane with many tasks.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-implement",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Handle task.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify(
        Array.from({ length: 18 }, (_, index) => ({
          id: `task-scroll-${index + 1}`,
          projectId: "orchestra",
          number: `ORC-${index + 1}`,
          title: `Scrollable lane task ${index + 1}`,
          description: null,
          type: "task",
          status: "ready",
          priority: index % 2 === 0 ? "P1" : "P2",
          workflowId: "workflow-scroll",
          currentLaneId: "lane-implement",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
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
          readyForDispatch: true,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        })),
      ),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await expect(page.locator('[data-role="workflow-task-section"]')).toContainText("Scrollable Flow");

  const laneList = page.locator('[data-role="workflow-lane-task-list"]').first();
  await expect(laneList).toBeVisible();
  await expect(laneList.locator('[data-role="task-card"]')).toHaveCount(18);

  const metrics = await laneList.evaluate((node) => ({
    clientHeight: node.clientHeight,
    scrollHeight: node.scrollHeight,
    overflowY: getComputedStyle(node).overflowY,
    sectionHeight: node.closest('[data-role="workflow-task-section"]') instanceof HTMLElement
      ? node.closest('[data-role="workflow-task-section"]').getBoundingClientRect().height
      : 0,
  }));

  expect(metrics.overflowY).toBe("auto");
  expect(metrics.scrollHeight).toBeGreaterThan(metrics.clientHeight);
  expect(metrics.sectionHeight).toBeLessThan(page.viewportSize()?.height ?? 720);

  const scrolled = await laneList.evaluate((node) => {
    node.scrollTop = 180;
    node.dispatchEvent(new Event("scroll", { bubbles: true }));
    return node.scrollTop;
  });
  expect(scrolled).toBeGreaterThan(0);
});

test("project setting auto-dispatches newly unblocked tasks when a blocker completes", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-user-review",
          slug: "user-review",
          name: "User Review",
          description: "User-owned blocker lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-user-review",
              key: "review",
              name: "Review",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Review the blocker.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
        {
          id: "workflow-role-implement",
          slug: "role-implement",
          name: "Role Implement",
          description: "Role-owned dependent lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-role-implement",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Implement the dependent task.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-blocker",
          projectId: "orchestra",
          number: "ORC-1",
          title: "Blocker task",
          description: null,
          type: "task",
          status: "in_review",
          priority: "P1",
          workflowId: "workflow-user-review",
          currentLaneId: "lane-user-review",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          laneRunCount: 0,
          childCount: 0,
          completedChildCount: 0,
          inProgressChildCount: 0,
          blockedChildCount: 0,
          blockedByCount: 0,
          blockingCount: 1,
          attachmentCount: 0,
          dependencyBlocked: false,
          readyForDispatch: false,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
        {
          id: "task-dependent",
          projectId: "orchestra",
          number: "ORC-2",
          title: "Dependent task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P2",
          workflowId: "workflow-role-implement",
          currentLaneId: "lane-role-implement",
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 0,
          laneRunCount: 0,
          childCount: 0,
          completedChildCount: 0,
          inProgressChildCount: 0,
          blockedChildCount: 0,
          blockedByCount: 1,
          blockingCount: 0,
          attachmentCount: 0,
          dependencyBlocked: true,
          readyForDispatch: false,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.task-dependencies",
      JSON.stringify([
        {
          id: "dependency-1",
          blockerTaskId: "task-blocker",
          blockedTaskId: "task-dependent",
          createdAt: timestamp,
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.project-settings",
      JSON.stringify({
        general: {
          autoDispatchOnBlockerCompletion: false,
          updatedAt: timestamp,
        },
      }),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Settings" }).click();
  await page.getByRole("tab", { name: "Projects" }).click();
  await page.locator('[data-role="project-auto-dispatch-on-blocker-completion"]').check();
  await page.locator('[data-role="save-project-automation-settings"]').click();
  await expect(page.locator('[data-role="project-auto-dispatch-on-blocker-completion"]')).toBeChecked();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Blocker task" }).first().click();
  await page.locator('[data-role="complete-task-success"]').click();

  await expect.poll(async () => {
    return page.evaluate(() => {
      const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
      return tasks.find((task: { id: string }) => task.id === "task-dependent") ?? null;
    });
  }).toMatchObject({
    status: "in_progress",
    assigneeType: "role",
  });

});

test("task detail manages dependencies and blocked state", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Dependency target");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="edit-task"]').click();
  await page.locator('[data-role="task-status"]').selectOption("ready");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="close-edit-task"]').click();
  await page.locator('[data-role="task-detail-tab-dependencies"]').click();
  await page.locator('[data-role="dependency-blocker-select"]').selectOption({ label: "ORC-2 · Implement task foundation shell" });
  await page.locator('[data-role="add-dependency"]').click();

  await expect(page.locator('[data-role="task-blocked-by"]')).toContainText("ORC-2");
  await expect(page.getByText("Not dispatchable", { exact: true })).toBeVisible();
});

test("task detail manages lane-scoped todos and blocks completion until current-lane todos are finished", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-todos",
          slug: "workflow-todos",
          name: "Todo Review Flow",
          description: "User-owned review lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-review",
              key: "review",
              name: "Review",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Review the task.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-todos",
          projectId: "orchestra",
          number: "ORC-50",
          title: "Todo managed task",
          description: "Use todos before approving.",
          type: "task",
          status: "in_review",
          priority: "P1",
          workflowId: "workflow-todos",
          currentLaneId: "lane-review",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
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
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          todos: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Todo managed task" }).first().click();

  await page.locator('[data-role="task-detail-tab-todos"]').click();
  await page.locator('[data-role="task-todo-description"]').fill("Confirm reviewer checklist is complete");
  await page.locator('[data-role="add-task-todo"]').click();

  await expect(page.locator('[data-role="task-todos"]')).toContainText("Confirm reviewer checklist is complete");
  await expect(page.locator('[data-role="task-current-lane-todo-warning"]')).toContainText("unfinished todo");

  await page.locator('[data-role="complete-task-success"]').click();
  await expect(page.locator('.error-copy').filter({ hasText: 'unfinished todo item' }).first()).toBeVisible();

  await page.locator('[data-role="mark-task-todo-finished"]').click();
  await expect(page.locator('[data-role="task-todos"]')).toContainText("finished");

  await page.locator('[data-role="mark-task-todo-unfinished"]').click();
  await expect(page.locator('[data-role="task-todos"]')).toContainText("unfinished");

  await page.locator('[data-role="mark-task-todo-finished"]').click();
  await page.locator('[data-role="complete-task-success"]').click();

  await expect.poll(async () => page.evaluate(() => {
    const tasks = JSON.parse(window.localStorage.getItem("orchestra.mock.tasks") ?? "[]");
    return tasks.find((task: { id: string; status: string }) => task.id === "task-todos")?.status ?? null;
  })).toBe("completed");
});

test("task detail opens tracked repo files when clicking @file mentions in comments", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Comment mention link task");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="task-detail-tab-repo-files"]').click();
  await page.locator('[data-role="task-file-reference-path"]').fill("docs/design.md");
  await page.locator('[data-role="add-task-file-reference"]').click();
  await expect(page.locator('[data-role="task-file-references"]')).toContainText("docs/design.md");

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Please review @docs/design.md before you continue.");
  await page.locator('[data-role="add-task-comment"]').click();

  await page.locator('[data-role="task-comment-file-mention-link"]').first().click();
  await expect(page.locator('[data-role="task-detail-tabpanel-repo-files"]')).toBeVisible();
  await expect(page.locator('[data-role="selected-task-file-reference-card"]')).toBeVisible();
  const repoFileState = await page.evaluate(() => {
    const select = document.querySelector('[data-role="task-file-references"] select');
    const card = document.querySelector('[data-role="selected-task-file-reference-card"]');
    return {
      selectedLabel: select instanceof HTMLSelectElement ? select.options[select.selectedIndex]?.textContent ?? "" : "",
      cardTop: card instanceof HTMLElement ? card.getBoundingClientRect().top : null,
      viewportHeight: window.innerHeight,
    };
  });
  expect(repoFileState.selectedLabel).toContain("docs/design.md");
  expect(repoFileState.cardTop).not.toBeNull();
  expect((repoFileState.cardTop ?? 0) < repoFileState.viewportHeight).toBe(true);
});

test("task detail renders markdown descriptions and comments with preserved line breaks", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-markdown-rendering",
          projectId: "orchestra",
          number: "ORC-300",
          title: "Markdown rendering task",
          description: "First line\nSecond line with **bold** text\n\n- Bullet one\n- Bullet two",
          type: "task",
          status: "in_progress",
          priority: "P1",
          workflowId: null,
          currentLaneId: null,
          assigneeType: "unassigned",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
          parentTaskId: null,
          archived: false,
          commentCount: 1,
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
          taskRepositories: [],
          fileReferences: [],
          comments: [
            {
              id: "comment-markdown-1",
              taskId: "task-markdown-rendering",
              parentCommentId: null,
              author: "Reviewer",
              message: "First review line\nSecond review line with **important** context\n\n- Check API shape\n- Confirm UI",
              interruptAgent: false,
              repositoryId: null,
              relativePath: null,
              lineStart: null,
              lineEnd: null,
              columnStart: null,
              columnEnd: null,
              selectedText: null,
              anchorCommitHash: null,
              anchorHasUncommittedChanges: null,
              createdAt: timestamp,
              updatedAt: timestamp,
            },
          ],
          todos: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Markdown rendering task" }).first().click();

  await expect(page.locator('[data-role="task-description-markdown"]')).toContainText("First line");
  await expect(page.locator('[data-role="task-description-markdown"]')).toContainText("Second line with bold text");
  await expect(page.locator('[data-role="task-description-markdown"] li')).toHaveCount(2);
  await expect(page.locator('[data-role="task-description-markdown"] strong')).toContainText("bold");
  const descriptionHtml = await page.locator('[data-role="task-description-markdown"]').evaluate((node) => node.innerHTML);
  expect(descriptionHtml).toContain("<br");

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  const detailedComment = page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"]').first();
  await expect(detailedComment).toContainText("First review line");
  await expect(detailedComment).toContainText("Second review line with important context");
  await expect(page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"] strong')).toContainText("important");
  await expect(page.locator('[data-role="task-detail-tabpanel-comments"] [data-role="task-comment-markdown"] li')).toHaveCount(2);
  const commentHtml = await detailedComment.evaluate((node) => node.innerHTML);
  expect(commentHtml).toContain("<br");
});

test("task detail supports attachments, comments, timeline, and review inbox filtering", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.locator('[data-role="task-detail-tab-attachments"]').click();
  await page.locator('[data-role="task-attachment-input"]').setInputFiles([
    {
      name: "notes.txt",
      mimeType: "text/plain",
      buffer: Buffer.from("Attachment preview text"),
    },
    {
      name: "pixel.png",
      mimeType: "image/png",
      buffer: Buffer.from(TINY_PNG_BASE64, "base64"),
    },
  ]);

  await expect(page.locator('[data-role="task-attachments"]')).toContainText("notes.txt");
  await expect(page.locator('[data-role="task-attachments"]')).toContainText("pixel.png");
  await expect(page.locator('.task-attachment-card__text')).toContainText("Attachment preview text");
  await expect(page.locator('.task-attachment-card__image')).toHaveCount(1);

  await page.locator('[data-role="task-detail-tab-comments"]').click();
  await page.locator('[data-role="task-comment-author"]').fill("Reviewer");
  await page.locator('[data-role="task-comment-message"]').fill("Pause and re-check the task context before you continue.");
  await page.locator('[data-role="task-comment-interrupt"]').check();
  await page.locator('[data-role="add-task-comment"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Reviewer");
  await expect(page.locator('[data-role="task-comments"]')).toContainText("Interrupt requested");

  await page.locator('[data-role="reply-task-comment"]').first().click();
  await page.locator('[data-role="task-reply-author"]').fill("Worker");
  await page.locator('[data-role="task-reply-message"]').fill("I checked the task context and updated the plan.");
  await page.locator('[data-role="add-task-reply"]').click();

  await expect(page.locator('[data-role="task-comments"]')).toContainText("Worker");
  await expect(page.locator('[data-role="task-comment-reply"]')).toContainText("I checked the task context and updated the plan.");

  await page.locator('[data-role="task-detail-tab-timeline"]').click();
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Attachment added: notes.txt");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Reviewer commented");
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Worker replied");

  await page.getByRole("button", { name: "Tasks", exact: true }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Review me");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="edit-task"]').click();
  await page.locator('[data-role="task-status"]').selectOption("in_review");
  await page.locator('[data-role="save-task"]').click();
  await page.locator('[data-role="close-edit-task"]').click();
  await page.getByRole("button", { name: "Tasks", exact: true }).click();

  await page.locator('[data-role="task-filter-attention"]').click();
  await expect(page.locator('[data-role="task-attention-queue"]')).toContainText("Review me");
  await page.locator('[data-role="task-filter-review"]').click();
  await expect(page.locator('[data-role="draft-task-section"]')).toContainText("Review me");
});

test("task detail dispatches a role-owned lane and shows its runtime assignment", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-role-dispatch",
          slug: "role-dispatch",
          name: "Role Dispatch Flow",
          description: "Single role-owned lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-role-dispatch",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Build it.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-role-dispatch",
          projectId: "orchestra",
          number: "ORC-10",
          title: "Role dispatch task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-role-dispatch",
          currentLaneId: "lane-role-dispatch",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
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
          readyForDispatch: true,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Role dispatch task" }).first().click();
  await page.locator('[data-role="dispatch-task-lane"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("developer");
});

test("task detail shows completion controls when user involvement is pending", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-user-review",
          slug: "user-review",
          name: "User Review Flow",
          description: "Single lane waiting on the user.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-user-review",
              key: "review",
              name: "Review",
              description: null,
              order: 0,
              assignedEntityType: "user",
              assignedEntityId: null,
              entryPromptTemplate: "Review the task.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-user-review",
          projectId: "orchestra",
          number: "ORC-9",
          title: "User review task",
          description: null,
          type: "task",
          status: "in_review",
          priority: "P2",
          workflowId: "workflow-user-review",
          currentLaneId: "lane-user-review",
          assigneeType: "user",
          assigneeId: null,
          repositoryId: null,
          repositoryIds: [],
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
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "User review task" }).first().click();

  await expect(page.locator('[data-role="complete-task-success"]')).toBeVisible();
  await expect(page.locator('[data-role="complete-task-failure"]')).toBeVisible();
});

test("approval-gated lanes pause for review, resume the same session for rework, and only finish after approval", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-approval",
          slug: "approval-flow",
          name: "Approval Flow",
          description: "Single agent-owned lane requiring user approval.",
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lanes: [
            {
              id: "lane-agent-approval",
              key: "agent-approval",
              name: "Agent approval",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: "data",
              entryPromptTemplate: "Do the work.",
              requireUserApprovalOnSuccess: true,
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
  await page.locator('[data-role="task-title"]').fill("Approval gated task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-approval");
  await page.locator('[data-role="publish-task"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  const initialSessionId = await page.locator('[data-role="task-runtime-assignment"]').textContent();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("agent");

  const seedAwaitingApproval = async () => {
    await page.evaluate(() => {
      const key = "orchestra.mock.tasks";
      const raw = window.localStorage.getItem(key);
      const tasks = raw ? JSON.parse(raw) : [];
      const target = tasks.find((entry: { title?: string }) => entry.title === "Approval gated task");
      if (!target?.activeLaneAssignment) {
        throw new Error("Expected active lane assignment for approval-gated task");
      }
      const updatedAt = new Date().toISOString();
      target.status = "in_review";
      target.assigneeType = "user";
      target.assigneeId = null;
      target.activeLaneAssignment = {
        ...target.activeLaneAssignment,
        status: "awaiting_user_approval",
        pendingOutcome: "success",
        completionNotes: null,
        updatedAt,
      };
      target.updatedAt = updatedAt;
      window.localStorage.setItem(key, JSON.stringify(tasks));
      window.dispatchEvent(new CustomEvent("orchestra:task-change", {
        detail: { taskIds: [target.id], reason: "test.seed.awaiting-approval" },
      }));
    });
  };

  await seedAwaitingApproval();
  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();
  await expect(page.locator('[data-role="send-task-back-for-work"]').first()).toBeVisible();
  await expect(page.locator('[data-role="task-awaiting-approval-note"]').first()).toContainText("paused for user approval");

  await page.locator('[data-role="send-task-back-for-work"]').first().click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("active");
  await expect(page.locator('[data-role="approve-task-lane"]')).toHaveCount(0);

  const reworkPromptSeen = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.some((session: { events?: Array<{ message?: string }> }) =>
      (session.events ?? []).some((event) => event.message?.includes("Reload the latest task context and comments")),
    );
  });
  expect(reworkPromptSeen).toBe(true);

  await seedAwaitingApproval();
  await expect(page.locator('[data-role="approve-task-lane"]').first()).toBeVisible();
  await page.locator('[data-role="approve-task-lane"]').first().click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);
  await page.locator('[data-role="task-detail-tab-timeline"]').click();
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Lane lane-agent-approval completed");
  expect(initialSessionId).toContain("Session:");
});

test("task detail dispatches an agent-owned task via publish, retries the active session, and completes the workflow", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-agent",
          slug: "agent-flow",
          name: "Agent Flow",
          description: "Single agent-owned lane.",
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lanes: [
            {
              id: "lane-agent",
              key: "agent",
              name: "Agent",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: "data",
              entryPromptTemplate: "Do the work.",
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
  await page.locator('[data-role="task-title"]').fill("Agent dispatched task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="publish-task"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("agent");
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("lane-agent");
  await expect(page.locator('[data-role="whip-task-runtime"]').first()).toBeVisible();

  await page.locator('[data-role="whip-task-runtime"]').first().click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("Whips: 1 / 10");

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Agent dispatched task");
    if (!target) {
      throw new Error("Expected agent-dispatched task was not found");
    }
    const updatedAt = new Date().toISOString();
    target.currentLaneId = null;
    target.status = "completed";
    target.assigneeType = "unassigned";
    target.assigneeId = null;
    target.activeLaneAssignment = null;
    target.laneRuns = (target.laneRuns ?? []).map((run: { completedAt?: string | null }, index: number, allRuns: Array<{ completedAt?: string | null }>) =>
      index === allRuns.length - 1 && run.completedAt == null
        ? { ...run, result: "success", completedAt: updatedAt }
        : run,
    );
    target.updatedAt = updatedAt;
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(new CustomEvent("orchestra:task-change", {
      detail: { taskIds: [target.id], reason: "test.seed.completed" },
    }));
  });

  await expect(page.locator('[data-role="task-runtime-assignment"]')).toHaveCount(0);
  await page.locator('[data-role="task-detail-tab-timeline"]').click();
  await expect(page.locator('[data-role="task-timeline"]')).toContainText("Lane lane-agent completed");
});

test("task detail requires a hold before delete and confirms removal in a modal", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Delete me");
  await page.locator('[data-role="save-task"]').click();

  await page.locator('[data-role="delete-task"]').click();

  await expect(page.locator('[data-role="task-delete-confirm"]')).toBeVisible();
  await page.locator('[data-role="confirm-delete-task"]').click();

  await expect(page.locator('[data-role="draft-task-section"]')).not.toContainText("Delete me");
});

test("dispatching a role-owned task surfaces the spawned runtime session in the Sessions list", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    const timestamp = new Date().toISOString();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-role-dispatch",
          slug: "role-dispatch",
          name: "Role Dispatch Flow",
          description: "Single role-owned lane.",
          archived: false,
          createdAt: timestamp,
          updatedAt: timestamp,
          lanes: [
            {
              id: "lane-role-dispatch",
              key: "implement",
              name: "Implement",
              description: null,
              order: 0,
              assignedEntityType: "role",
              assignedEntityId: "developer",
              entryPromptTemplate: "Build it.",
              successTransitionType: "end",
              successTargetLaneId: null,
              failureTransitionType: "end",
              failureTargetLaneId: null,
            },
          ],
        },
      ]),
    );
    window.localStorage.setItem(
      "orchestra.mock.tasks",
      JSON.stringify([
        {
          id: "task-role-dispatch",
          projectId: "orchestra",
          number: "ORC-10",
          title: "Role dispatch task",
          description: null,
          type: "task",
          status: "ready",
          priority: "P1",
          workflowId: "workflow-role-dispatch",
          currentLaneId: "lane-role-dispatch",
          assigneeType: "role",
          assigneeId: "developer",
          repositoryId: null,
          repositoryIds: [],
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
          readyForDispatch: true,
          parent: null,
          lineage: [],
          children: [],
          blockedBy: [],
          blocking: [],
          attachments: [],
          taskRepositories: [],
          fileReferences: [],
          comments: [],
          laneRuns: [],
          activeLaneAssignment: null,
          createdAt: timestamp,
          updatedAt: timestamp,
        },
      ]),
    );
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Sessions" }).click();
  const previousSessionCount = await page.locator('[data-role="session-link"]').count();

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Role dispatch task" }).first().click();
  await page.locator('[data-role="dispatch-task-lane"]').click();
  await page.locator('[data-role="task-detail-tab-runtime"]').click();
  await expect(page.locator('[data-role="task-runtime-assignment"]')).toContainText("role");

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(previousSessionCount + 1);
});

test("dispatching an agent-owned task reuses the agent main session instead of spawning a duplicate", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
    window.localStorage.setItem(
      "orchestra.mock.workflows",
      JSON.stringify([
        {
          id: "workflow-agent",
          slug: "agent-flow",
          name: "Agent Flow",
          description: "Single agent-owned lane.",
          archived: false,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          lanes: [
            {
              id: "lane-agent",
              key: "agent",
              name: "Agent",
              description: null,
              order: 0,
              assignedEntityType: "agent",
              assignedEntityId: "data",
              entryPromptTemplate: "Do the work.",
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
  await page.getByRole("button", { name: "Sessions" }).click();
  const initialSessionCount = await page.locator('[data-role="session-link"]').count();

  await page.getByRole("button", { name: "Agents" }).click();
  await page.getByRole("link", { name: /Data/i }).click();
  await page.locator('[data-role="open-agent-session"]').click();
  await expect(page.locator('[data-role="selected-session-title"]')).toContainText("Data main session");

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(initialSessionCount + 1);

  await page.getByRole("button", { name: "Tasks" }).click();
  await page.getByRole("button", { name: "New task" }).click();
  await page.locator('[data-role="task-title"]').fill("Agent session reuse task");
  await page.locator('[data-role="task-workflow"]').selectOption("workflow-agent");
  await page.locator('[data-role="publish-task"]').click();

  await page.getByRole("button", { name: "Sessions" }).click();
  await expect(page.locator('[data-role="session-link"]')).toHaveCount(initialSessionCount + 1);

  const sessionCounts = await page.evaluate(() => {
    const sessions = JSON.parse(window.localStorage.getItem("orchestra.mock.sessions.orchestra") ?? "[]");
    return sessions.filter((session: { title: string }) => session.title === "Data main session").length;
  });

  expect(sessionCounts).toBe(1);
});

test("task detail refreshes from backend task-change events without waiting on polling", async ({ page }) => {
  await page.addInitScript(() => {
    window.localStorage.clear();
  });

  await page.goto("/");
  await page.getByRole("button", { name: "Tasks" }).click();
  await page.locator('[data-role="task-card"]').filter({ hasText: "Implement task foundation shell" }).first().click();

  await page.evaluate(() => {
    const key = "orchestra.mock.tasks";
    const raw = window.localStorage.getItem(key);
    const tasks = raw ? JSON.parse(raw) : [];
    const target = tasks.find((entry: { title?: string }) => entry.title === "Implement task foundation shell");
    if (!target) {
      throw new Error("Expected seeded task was not found");
    }
    target.title = "Updated from backend event";
    target.updatedAt = new Date().toISOString();
    window.localStorage.setItem(key, JSON.stringify(tasks));
    window.dispatchEvent(
      new CustomEvent("orchestra:task-change", {
        detail: {
          taskIds: [target.id],
          reason: "task.updated",
        },
      }),
    );
  });

  await expect(page.locator('[data-role="task-title-heading"]')).toContainText("Updated from backend event");
});
